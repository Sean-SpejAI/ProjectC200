// SOAP helpers for the ImageRight WebAPI (IRWebService40.asmx).
//
// Why hand-rolled XML instead of a `soap` library: the wire format is stable,
// the operations we use are few, and the verified end-to-end flow (see
// docs/IRWebService40.wsdl + the 2026-05-22 PDF fetch) is easier to debug
// when you can see the envelopes. fast-xml-parser handles the responses.
//
// Session model: every SOAP response carries a new `securityToken` that
// supersedes the previous one. `SoapSession` threads the latest token into
// each call. Sessions are per-request — start one, run a sequence, drop it.

import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import sax from 'sax';
import { XMLParser } from 'fast-xml-parser';

const IR_NS = 'http://imageright.com/imageright.webservice';

// `processEntities: false` is important — File responses include embedded
// note bodies with HTML-escaped content (`&lt;`, `&amp;`, ...) that easily
// blow past fast-xml-parser's built-in entity-expansion safety cap of 1000.
// We don't care about note contents at all, but the parser still counts
// every entity it walks. Disable entity processing globally and decode the
// few fields we actually read via `decodeEntities` below.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  processEntities: false,
});

function decodeEntities(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&'); // last so we don't double-decode
}

// ---------------------------------------------------------------------------
// Low-level transport
// ---------------------------------------------------------------------------

function envelope(bodyInner) {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope ' +
      'xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ' +
      `xmlns:ir="${IR_NS}" ` +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xmlns:xsd="http://www.w3.org/2001/XMLSchema">' +
    '<soap:Body>' + bodyInner + '</soap:Body>' +
    '</soap:Envelope>'
  );
}

// All ImageRight WebService calls go over HTTP NTLM. Windows Authentication is
// enabled on the IIS site (2026-06-17) — Anonymous is off — so every request
// must carry NTLM HTTP credentials. Node's built-in fetch cannot do NTLM, so we
// shell out to `curl --ntlm`. The SOAP body is fed via STDIN (`--data-binary @-`)
// rather than as an arg, to avoid the 128 KB single-arg limit for documents with
// thousands of page refs (curl buffers stdin for Content-Length, so it can still
// resend the body during NTLM's 401-challenge handshake). NTLM credentials come
// from the SoapSession (ntlmUser/ntlmPass).
function baseCurlArgs(session, action, timeoutMs) {
  if (!session.ntlmUser || !session.ntlmPass) {
    throw new SoapError(action, 0, 'ntlm_credentials_not_configured', '');
  }
  return [
    '-s', '-S', '--ntlm', '-u', `${session.ntlmUser}:${session.ntlmPass}`,
    '--max-time', String(Math.ceil((timeoutMs ?? session.timeoutMs) / 1000)),
    '-X', 'POST', session.endpoint,
    '-H', 'Content-Type: text/xml; charset=utf-8',
    '-H', `SOAPAction: "${IR_NS}/${action}"`,
    '-H', `Host: ${session.hostHeader}`,
    '--data-binary', '@-',
  ];
}

// Spawn curl for a STREAMING response (PDF / native bytes). The request body is
// written to stdin; the (large) response streams out on stdout.
function spawnSoapCurl(session, action, bodyInner, timeoutMs) {
  const cp = spawn('curl', baseCurlArgs(session, action, timeoutMs), {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  cp.stdin.on('error', () => {}); // ignore EPIPE if curl exits before draining stdin
  cp.stdin.end(envelope(bodyInner));
  return cp;
}

// Buffered SOAP POST over NTLM. Returns { status, text }. The HTTP status comes
// from a curl -w sentinel appended after the body (SOAP XML never contains it).
function postSoap(session, action, bodyInner, timeoutMs) {
  const HC = '\n<<<HC:';
  return new Promise((resolve, reject) => {
    const args = [...baseCurlArgs(session, action, timeoutMs), '-w', `${HC}%{http_code}>>>`];
    const cp = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let errBuf = '';
    cp.stdout.on('data', (d) => out.push(d));
    cp.stderr.on('data', (d) => { errBuf += d; });
    cp.stdin.on('error', () => {});
    cp.on('error', (e) => reject(new SoapError(action, 0, 'curl_spawn_failed', e.message)));
    cp.on('close', (code) => {
      const s = Buffer.concat(out).toString('utf8');
      const i = s.lastIndexOf(HC);
      let text = s;
      let status = 0;
      if (i >= 0) {
        text = s.slice(0, i);
        const m = s.slice(i).match(/HC:(\d+)/);
        if (m) status = parseInt(m[1], 10);
      }
      if (code !== 0 && !text) {
        reject(new SoapError(action, code === 28 ? 504 : 0, code === 28 ? 'timeout' : `curl_exit_${code}`, errBuf.slice(0, 300)));
        return;
      }
      resolve({ status, text });
    });
    cp.stdin.end(envelope(bodyInner));
  });
}

function parseResponseOrThrow(action, text) {
  const obj = parser.parse(text);
  const env = obj['soap:Envelope'] || obj['SOAP-ENV:Envelope'] || obj['Envelope'];
  if (!env) throw new SoapError(action, 0, `malformed_envelope`, text.slice(0, 300));
  const body = env['soap:Body'] || env['SOAP-ENV:Body'] || env['Body'];
  if (!body) throw new SoapError(action, 0, `missing_body`, text.slice(0, 300));
  const fault = body['soap:Fault'] || body['Fault'];
  if (fault) {
    const message = fault.faultstring || fault['soap:faultstring'] || 'unknown_soap_fault';
    throw new SoapError(action, 0, message, text.slice(0, 500));
  }
  return body;
}

export class SoapError extends Error {
  constructor(action, status, message, detail) {
    super(`SOAP ${action} failed: ${message}`);
    this.name = 'SoapError';
    this.action = action;
    this.status = status;
    this.upstreamMessage = message;
    this.detail = detail;
    // Standard upstream phrasing — surface this so the proxy can react
    // (e.g. start a new session and retry exactly once).
    this.notLoggedIn = /not logged in/i.test(message);
  }
}

// ---------------------------------------------------------------------------
// Session — threads the rolling securityToken
// ---------------------------------------------------------------------------

export class SoapSession {
  constructor(opts) {
    this.endpoint = opts.endpoint;     // e.g. http://192.168.11.179/imageright.webservice/IRWebService40.asmx
    this.hostHeader = opts.hostHeader; // e.g. irtest-appsvr.nodakmutual.com
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.contentTimeoutMs = opts.contentTimeoutMs ?? 5 * 60_000;
    // HTTP NTLM (Windows Auth) credentials — required on every request since IIS
    // Windows Authentication is enabled. Sent via `curl --ntlm`.
    this.ntlmUser = opts.ntlmUser ?? null;
    this.ntlmPass = opts.ntlmPass ?? null;
    this.token = null;
  }

  async _call(action, bodyInner, timeoutMs) {
    const { status, text } = await postSoap(
      this, action, bodyInner, timeoutMs ?? this.timeoutMs,
    );
    if (status !== 200) {
      const fault = (() => {
        try { return parseResponseOrThrow(action, text); } catch (e) {
          if (e instanceof SoapError) return e;
          return null;
        }
      })();
      if (fault instanceof SoapError) throw fault;
      throw new SoapError(action, status, `http_${status}`, text.slice(0, 500));
    }
    const body = parseResponseOrThrow(action, text);
    const resp = body[`${action}Response`] || body[action + 'Response'];
    if (!resp) throw new SoapError(action, 0, `missing_${action}Response`, text.slice(0, 300));
    // Rotate the token from the response (may be absent — e.g. UserLogin).
    if (resp.securityToken) this.token = resp.securityToken;
    return resp;
  }

  async login(username, password, connName = 'Test') {
    const inner =
      '<ir:UserLogin>' +
        `<ir:username>${escapeXml(username)}</ir:username>` +
        `<ir:password>${escapeXml(password)}</ir:password>` +
        `<ir:connName>${escapeXml(connName)}</ir:connName>` +
      '</ir:UserLogin>';
    const resp = await this._call('UserLogin', inner);
    const tok = resp.UserLoginResult;
    if (!tok || typeof tok !== 'string') {
      throw new SoapError('UserLogin', 0, 'no_token_in_response', JSON.stringify(resp).slice(0, 300));
    }
    this.token = tok;
    return tok;
  }
}

// ---------------------------------------------------------------------------
// High-level operations
// ---------------------------------------------------------------------------

/**
 * FindFilesEx — search CLMS drawer (id=1383) by file number OR date range.
 * Exactly one filter must be set.
 *
 * @returns Array<{fileId, claimNumber, fileNumber2, fileNumber3, description}>
 */
export async function findFiles(session, filter) {
  const cond = buildFileFindCondition(filter);
  const inner =
    '<ir:FindFilesEx>' +
      `<ir:securityToken>${session.token}</ir:securityToken>` +
      '<ir:searchConditions>' +
        '<ir:DrawerConditions>' +
          '<ir:DrawerCondition>' +
            '<ir:AType>atInt</ir:AType>' +
            '<ir:ATarget>catSelf</ir:ATarget>' +
            '<ir:CompOp>coEqual</ir:CompOp>' +
            '<ir:Id>0</ir:Id>' +
            '<ir:Value xsi:type="xsd:long">1383</ir:Value>' +
            '<ir:ConditionName>drsaDrawerId</ir:ConditionName>' +
          '</ir:DrawerCondition>' +
        '</ir:DrawerConditions>' +
        '<ir:FileConditions>' + cond + '</ir:FileConditions>' +
        '<ir:Operation>And</ir:Operation>' +
      '</ir:searchConditions>' +
      '<ir:getContent>false</ir:getContent>' +
      '<ir:includeDeleted>false</ir:includeDeleted>' +
    '</ir:FindFilesEx>';

  const resp = await session._call('FindFilesEx', inner);
  const result = resp.FindFilesExResult;
  const files = asArray(result?.File);
  return files.map((f) => ({
    fileId: numOrNull(f.Id?.RefId),
    claimNumber: stringOrNull(f.FileNumber1),
    fileNumber2: stringOrNull(f.FileNumber2),
    fileNumber3: stringOrNull(f.FileNumber3),
    description: stringOrNull(f.Description),
  })).filter((f) => f.fileId != null);
}

function buildFileFindCondition(filter) {
  if (filter.fileNumber) {
    return (
      '<ir:FileCondition>' +
        '<ir:AType>atString</ir:AType>' +
        '<ir:ATarget>catSelf</ir:ATarget>' +
        '<ir:CompOp>coEqual</ir:CompOp>' +
        '<ir:Id>0</ir:Id>' +
        `<ir:Value xsi:type="xsd:string">${escapeXml(filter.fileNumber)}</ir:Value>` +
        '<ir:ConditionName>fsaFileNumber</ir:ConditionName>' +
      '</ir:FileCondition>'
    );
  }
  if (filter.dateModifiedFrom && filter.dateModifiedTo) {
    return dateBetween('fsaDateModified', filter.dateModifiedFrom, filter.dateModifiedTo);
  }
  if (filter.dateCreatedFrom && filter.dateCreatedTo) {
    return dateBetween('fsaDateCreated', filter.dateCreatedFrom, filter.dateCreatedTo);
  }
  throw new Error('findFiles: provide one of fileNumber, dateModifiedFrom+To, dateCreatedFrom+To');
}

function dateBetween(conditionName, from, to) {
  return (
    '<ir:FileCondition>' +
      '<ir:AType>atDate</ir:AType>' +
      '<ir:ATarget>catSelf</ir:ATarget>' +
      '<ir:CompOp>coBetween</ir:CompOp>' +
      '<ir:Id>0</ir:Id>' +
      `<ir:Value xsi:type="xsd:dateTime">${formatDate(from)}</ir:Value>` +
      `<ir:Value2 xsi:type="xsd:dateTime">${formatDate(to)}</ir:Value2>` +
      `<ir:ConditionName>${conditionName}</ir:ConditionName>` +
    '</ir:FileCondition>'
  );
}

/**
 * Get a file plus its full document tree.
 *
 * `GetFileByRef(getContent=true)` returns top-level folders + top-level docs.
 * Sub-folders' Content arrays come back empty, so we call `GetContent` for
 * each folder to enumerate nested documents. The returned `documents[]` is
 * the flat union across all folders.
 *
 * @returns {file, attributes, documents}
 *   file: {fileId, claimNumber, fileNumber2, fileNumber3, description, dateLastOpened}
 *   attributes: {[name]: stringValue}     // ADJUSTER CODE, DATE OF LOSS, etc.
 *   documents: Array<{docId, parentFolderId, description, pageCount, dateCreated, dateLastModified, documentDate}>
 */
// Folder display name. ImageRight folder INSTANCES frequently have an empty
// Description; the meaningful name shown in the desktop client (e.g. "Claim
// Information", "Insured", "Claimant", "Litigation", "Correspondence") lives on
// the folder TYPE (ObjType.Description / ObjType.Name). Prefer a non-empty
// instance Description (e.g. a named claimant folder) and fall back to the type.
function folderLabel(item) {
  const desc = stringOrNull(item.Description);
  if (desc && desc.trim().length > 0) return desc.trim();
  return stringOrNull(item.ObjType?.Description) || stringOrNull(item.ObjType?.Name) || null;
}

export async function getFileTree(session, fileId) {
  const fileResp = await session._call(
    'GetFileByRef',
    '<ir:GetFileByRef>' +
      `<ir:securityToken>${session.token}</ir:securityToken>` +
      `<ir:fileRef><ir:RefId>${Number(fileId)}</ir:RefId></ir:fileRef>` +
      '<ir:getContent>true</ir:getContent>' +
      '<ir:includeDeleted>false</ir:includeDeleted>' +
    '</ir:GetFileByRef>',
  );
  const result = fileResp.GetFileByRefResult;
  if (!result) throw new SoapError('GetFileByRef', 0, 'no_result', JSON.stringify(fileResp).slice(0, 300));

  const file = {
    fileId: Number(fileId),
    claimNumber: stringOrNull(result.FileNumber1),
    fileNumber2: stringOrNull(result.FileNumber2),
    fileNumber3: stringOrNull(result.FileNumber3),
    description: stringOrNull(result.Description),
    dateLastOpened: stringOrNull(result.DateLastOpened),
  };

  const attributes = {};
  const attrList = asArray(result.AttributeData?.AttributeData);
  for (const a of attrList) {
    const name = stringOrNull(a.Name);
    if (name) attributes[name] = stringOrNull(a.Val);
  }

  // Walk top-level content. Each TypedObjectData carries xsi:type indicating
  // Folder or Document. Recurse into folders via GetContent.
  const documents = [];
  const topItems = asArray(result.Content?.TypedObjectData);
  for (const item of topItems) {
    const typeAttr = item['@_xsi:type'];
    if (typeAttr === 'Document') {
      documents.push(extractDocument(item, /* parentFolderId */ null, /* folderPath */ []));
    } else if (typeAttr === 'Folder') {
      const folderId = numOrNull(item.Id?.RefId);
      if (folderId == null) continue;
      const folderName = folderLabel(item);
      const nested = await fetchFolderDocuments(
        session, folderId, folderName != null ? [folderName] : [],
      );
      documents.push(...nested);
    }
  }

  return { file, attributes, documents };
}

// `folderPath` is the chain of folder Descriptions from the file root down to
// (and including) this folder — threaded so each document carries the named
// folder hierarchy it lives under, for downstream include/exclude filtering.
async function fetchFolderDocuments(session, folderId, folderPath = []) {
  const resp = await session._call(
    'GetContent',
    '<ir:GetContent>' +
      `<ir:securityToken>${session.token}</ir:securityToken>` +
      `<ir:objectId>${Number(folderId)}</ir:objectId>` +
      '<ir:includeDeleted>false</ir:includeDeleted>' +
    '</ir:GetContent>',
  );
  const out = [];
  const items = asArray(resp.GetContentResult?.TypedObjectData);
  for (const item of items) {
    const typeAttr = item['@_xsi:type'];
    if (typeAttr === 'Document') {
      out.push(extractDocument(item, folderId, folderPath));
    } else if (typeAttr === 'Folder') {
      const nestedId = numOrNull(item.Id?.RefId);
      if (nestedId != null) {
        const nestedName = folderLabel(item);
        const nestedPath = nestedName != null ? [...folderPath, nestedName] : folderPath;
        const nested = await fetchFolderDocuments(session, nestedId, nestedPath);
        out.push(...nested);
      }
    }
  }
  return out;
}

function extractDocument(item, parentFolderId, folderPath = []) {
  const path = Array.isArray(folderPath) ? folderPath : [];
  return {
    docId: numOrNull(item.Id?.RefId),
    parentFolderId,
    // Named folder hierarchy this doc lives under (root → immediate parent).
    folderName: path.length > 0 ? path[path.length - 1] : null,
    folderPath: path,
    description: stringOrNull(item.Description),
    // documentType prefers the human-readable ObjType.Description ("BI Documents");
    // documentTypeCode is the short type code ("BIDO") for exact-match filtering.
    documentType: stringOrNull(item.ObjType?.Description) || stringOrNull(item.ObjType?.Name),
    documentTypeCode: stringOrNull(item.ObjType?.Name),
    pageCount: numOrNull(item.PageCount),
    dateCreated: stringOrNull(item.DateCreated),
    dateLastModified: stringOrNull(item.DateLastModified),
    documentDate: stringOrNull(item.DocumentDate),
  };
}

// ---------------------------------------------------------------------------
// Diagnostic: full file inventory (folders + documents, including deleted/cut).
//
// Unlike getFileTree (the real pull path: documents only, non-deleted), this
// returns EVERY object in the file with its delete state — so an operator can
// verify exactly what ImageRight holds for a claim without manual raw-SOAP
// probing. Same GetFileByRef -> recursive GetContent walk; `includeDeleted`
// is threaded into both calls. Additive — does not touch getFileTree.
// ---------------------------------------------------------------------------

function extractObject(item, kind, folderPath) {
  const path = Array.isArray(folderPath) ? folderPath : [];
  return {
    kind, // 'Folder' | 'Document'
    id: numOrNull(item.Id?.RefId),
    parentFolderId: numOrNull(item.ParentId?.RefId),
    folderName: path.length > 0 ? path[path.length - 1] : null,
    folderPath: path,
    description: stringOrNull(item.Description),
    documentType: stringOrNull(item.ObjType?.Description) || stringOrNull(item.ObjType?.Name),
    documentTypeCode: stringOrNull(item.ObjType?.Name),
    // None | Deleted | Cut | All | CutAndUndelete
    deleteIndicator: stringOrNull(item.DeleteIndicator),
    pageCount: numOrNull(item.PageCount),
    documentDate: stringOrNull(item.DocumentDate),
    dateCreated: stringOrNull(item.DateCreated),
    dateLastModified: stringOrNull(item.DateLastModified),
  };
}

export async function getFileInventory(session, fileId, includeDeleted = true) {
  const del = includeDeleted ? 'true' : 'false';
  const fileResp = await session._call(
    'GetFileByRef',
    '<ir:GetFileByRef>' +
      `<ir:securityToken>${session.token}</ir:securityToken>` +
      `<ir:fileRef><ir:RefId>${Number(fileId)}</ir:RefId></ir:fileRef>` +
      '<ir:getContent>true</ir:getContent>' +
      `<ir:includeDeleted>${del}</ir:includeDeleted>` +
    '</ir:GetFileByRef>',
  );
  const result = fileResp.GetFileByRefResult;
  if (!result) throw new SoapError('GetFileByRef', 0, 'no_result', JSON.stringify(fileResp).slice(0, 300));

  const file = {
    fileId: Number(fileId),
    claimNumber: stringOrNull(result.FileNumber1),
    description: stringOrNull(result.Description),
    deleteIndicator: stringOrNull(result.DeleteIndicator),
  };

  const objects = [];
  const topItems = asArray(result.Content?.TypedObjectData);
  for (const item of topItems) {
    const typeAttr = item['@_xsi:type'];
    if (typeAttr === 'Document') {
      objects.push(extractObject(item, 'Document', []));
    } else if (typeAttr === 'Folder') {
      objects.push(extractObject(item, 'Folder', []));
      const folderId = numOrNull(item.Id?.RefId);
      const folderName = folderLabel(item);
      if (folderId != null) {
        const nested = await fetchFolderInventory(
          session, folderId, folderName != null ? [folderName] : [], includeDeleted,
        );
        objects.push(...nested);
      }
    }
  }
  return { file, objects };
}

async function fetchFolderInventory(session, folderId, folderPath, includeDeleted) {
  const del = includeDeleted ? 'true' : 'false';
  const resp = await session._call(
    'GetContent',
    '<ir:GetContent>' +
      `<ir:securityToken>${session.token}</ir:securityToken>` +
      `<ir:objectId>${Number(folderId)}</ir:objectId>` +
      `<ir:includeDeleted>${del}</ir:includeDeleted>` +
    '</ir:GetContent>',
  );
  const out = [];
  const items = asArray(resp.GetContentResult?.TypedObjectData);
  for (const item of items) {
    const typeAttr = item['@_xsi:type'];
    if (typeAttr === 'Document') {
      out.push(extractObject(item, 'Document', folderPath));
    } else if (typeAttr === 'Folder') {
      out.push(extractObject(item, 'Folder', folderPath));
      const nestedId = numOrNull(item.Id?.RefId);
      const nestedName = folderLabel(item);
      if (nestedId != null) {
        const nestedPath = nestedName != null ? [...folderPath, nestedName] : folderPath;
        out.push(...await fetchFolderInventory(session, nestedId, nestedPath, includeDeleted));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Diagnostic: environment presence probe.
//
// Answers "is this claim's document data actually present in the ImageRight
// environment this proxy is connected to?" using TWO independent paths:
//   1. getFileTree          — our real pull path (recursive GetContent walk)
//   2. findDocumentsByFileNumber — a server-side FindDocumentsEx DB search that
//      does NOT touch the folder walk, so it can't share a traversal bug.
// Plus AvailableConnections (which backend database / connName this appsvr
// exposes) and a shallow top-level folder summary. When both paths return only
// the handful of auto-generated skeleton docs (SG11 Declarations, New Mail,
// STAT) the substantive documents simply aren't in this database — they live in
// another ImageRight environment. Used by the /imageright/claims/:n/probe route.
//
// Note: MaxDocDateUTC comes back as DateTime.MinValue (0001-01-01) for EVERY
// folder in the test env — even folders that DO hold documents — so it is NOT a
// usable presence signal here; the FindDocumentsEx count is authoritative.
// ---------------------------------------------------------------------------

export async function getAvailableConnections(session) {
  const resp = await session._call('AvailableConnections', '<ir:AvailableConnections></ir:AvailableConnections>');
  return asArray(resp.AvailableConnectionsResult?.string).map(stringOrNull).filter((v) => v != null);
}

/**
 * Independent server-side document search scoped to one file number, via
 * FindDocumentsEx (DrawerCondition drsaDrawerId=1383 + FileCondition
 * fsaFileNumber). Bypasses the GetContent folder walk entirely — use it to
 * confirm whether a file's documents exist in the connected database at all.
 *
 * @returns Array<{docId, documentType, documentTypeCode, pageCount, deleteIndicator, dateCreated, documentDate}>
 */
export async function findDocumentsByFileNumber(session, fileNumber, includeDeleted = true) {
  const del = includeDeleted ? 'true' : 'false';
  const inner =
    '<ir:FindDocumentsEx>' +
      `<ir:securityToken>${session.token}</ir:securityToken>` +
      '<ir:searchConditions>' +
        '<ir:DrawerConditions><ir:DrawerCondition>' +
          '<ir:AType>atInt</ir:AType><ir:ATarget>catSelf</ir:ATarget><ir:CompOp>coEqual</ir:CompOp>' +
          '<ir:Id>0</ir:Id><ir:Value xsi:type="xsd:long">1383</ir:Value>' +
          '<ir:ConditionName>drsaDrawerId</ir:ConditionName>' +
        '</ir:DrawerCondition></ir:DrawerConditions>' +
        '<ir:FileConditions><ir:FileCondition>' +
          '<ir:AType>atString</ir:AType><ir:ATarget>catSelf</ir:ATarget><ir:CompOp>coEqual</ir:CompOp>' +
          `<ir:Id>0</ir:Id><ir:Value xsi:type="xsd:string">${escapeXml(fileNumber)}</ir:Value>` +
          '<ir:ConditionName>fsaFileNumber</ir:ConditionName>' +
        '</ir:FileCondition></ir:FileConditions>' +
        '<ir:Operation>And</ir:Operation>' +
      '</ir:searchConditions>' +
      `<ir:includeDeleted>${del}</ir:includeDeleted>` +
      '<ir:includePageData>false</ir:includePageData>' +
    '</ir:FindDocumentsEx>';
  const resp = await session._call('FindDocumentsEx', inner);
  const docs = asArray(resp.FindDocumentsExResult?.Document);
  return docs.map((d) => ({
    docId: numOrNull(d.Id?.RefId),
    documentType: stringOrNull(d.ObjType?.Description) || stringOrNull(d.ObjType?.Name),
    documentTypeCode: stringOrNull(d.ObjType?.Name),
    pageCount: numOrNull(d.PageCount),
    deleteIndicator: stringOrNull(d.DeleteIndicator),
    dateCreated: stringOrNull(d.DateCreated),
    documentDate: stringOrNull(d.DocumentDate),
  }));
}

/**
 * Shallow top-level presence summary for a file: each top-level folder with its
 * direct document / sub-folder counts (one GetFileByRef + one GetContent per
 * top-level folder, capped at maxFolders). The "empty Claimant-NN folder" signal
 * is at the top level (substantive docs are direct children of "Claimant-NN"),
 * so no deep recursion is needed here — getFileTree provides the recursive total.
 *
 * @returns {topLevelDocs, foldersTruncated, topFolders: Array<{id,name,description,maxDocDateUTC,directDocs,subFolders}>}
 */
export async function getFilePresence(session, fileId, { maxFolders = 60 } = {}) {
  const fileResp = await session._call(
    'GetFileByRef',
    '<ir:GetFileByRef>' +
      `<ir:securityToken>${session.token}</ir:securityToken>` +
      `<ir:fileRef><ir:RefId>${Number(fileId)}</ir:RefId></ir:fileRef>` +
      '<ir:getContent>true</ir:getContent>' +
      '<ir:includeDeleted>true</ir:includeDeleted>' +
    '</ir:GetFileByRef>',
  );
  const result = fileResp.GetFileByRefResult;
  if (!result) throw new SoapError('GetFileByRef', 0, 'no_result', JSON.stringify(fileResp).slice(0, 300));

  const topItems = asArray(result.Content?.TypedObjectData);
  let topLevelDocs = 0;
  const folderItems = [];
  for (const item of topItems) {
    const t = item['@_xsi:type'];
    if (t === 'Document') topLevelDocs += 1;
    else if (t === 'Folder') folderItems.push(item);
  }

  const foldersTruncated = folderItems.length > maxFolders;
  const topFolders = [];
  for (const item of folderItems.slice(0, maxFolders)) {
    const id = numOrNull(item.Id?.RefId);
    const entry = {
      id,
      name: stringOrNull(item.ObjType?.Name),
      description: stringOrNull(item.Description),
      maxDocDateUTC: stringOrNull(item.MaxDocDateUTC),
      directDocs: 0,
      subFolders: 0,
    };
    if (id != null) {
      const resp = await session._call(
        'GetContent',
        '<ir:GetContent>' +
          `<ir:securityToken>${session.token}</ir:securityToken>` +
          `<ir:objectId>${id}</ir:objectId>` +
          '<ir:includeDeleted>true</ir:includeDeleted>' +
        '</ir:GetContent>',
      );
      for (const kid of asArray(resp.GetContentResult?.TypedObjectData)) {
        const kt = kid['@_xsi:type'];
        if (kt === 'Document') entry.directDocs += 1;
        else if (kt === 'Folder') entry.subFolders += 1;
      }
    }
    topFolders.push(entry);
  }
  return { topLevelDocs, foldersTruncated, topFolders };
}

// Formats that ImageRight cannot render to PDF via GetMultiPageImageFileUsingPages.
// Pages with these formats produce "This page could not be converted to PDF." placeholders.
// Fail-open: any format NOT in this set (including null/unknown) is passed through.
// Formats that ImageRight cannot render to PDF — pages with these formats
// produce "This page could not be converted to PDF." placeholders.
// Only audio/video is blocked here because those have no readable content
// for a PDF viewer. Office/email formats (DOC, MSG, etc.) produce placeholders
// too, but we want to eventually support them via native-format download +
// LibreOffice conversion — so they are NOT in this blocklist yet.
const NON_IMAGE_FORMATS = new Set([
  // Audio / video (recorded statements, voicemails — common in claims)
  'MP3', 'MP4', 'WAV', 'AAC', 'M4A', 'OGG', 'FLAC', 'WMA',
  'AVI', 'MOV', 'WMV', 'MKV', 'WEBM', 'FLV',
]);

/**
 * Look up the page ids for a document, filtering out non-image formats that
 * ImageRight cannot convert to PDF (they produce placeholder pages instead).
 *
 * Returns { imagePageIds, totalPageCount, skippedCount, pageInfos }
 * where imagePageIds is the filtered set safe to pass to streamPdfForPages.
 *
 * @returns {Promise<{imagePageIds: number[], totalPageCount: number, skippedCount: number, pageInfos: {id:number,format:string|null}[]}>}
 */
export async function getDocumentPageIds(session, docId) {
  const pagesResp = await session._call(
    'GetPages',
    '<ir:GetPages>' +
      `<ir:securityToken>${session.token}</ir:securityToken>` +
      `<ir:documentRef><ir:RefId>${Number(docId)}</ir:RefId></ir:documentRef>` +
      '<ir:includeDeleted>false</ir:includeDeleted>' +
    '</ir:GetPages>',
  );
  const pages = asArray(pagesResp.GetPagesResult?.Page);
  const pageInfos = pages
    .map((p) => ({ id: numOrNull(p.Id?.RefId), format: p.Format ?? null }))
    .filter((p) => p.id != null);

  if (pageInfos.length === 0) {
    throw new SoapError('GetPages', 0, 'no_pages_for_document', `docId=${docId}`);
  }

  // Office formats that can be converted via native download + mammoth/Chrome.
  // These are NOT passed to GetMultiPageImageFileUsingPages(outputType=PDF)
  // because that produces placeholder pages — but we handle them separately.
  const OFFICE_FORMATS_SOAP = new Set([
    'DOC', 'DOCX', 'RTF', 'XLS', 'XLSX', 'PPT', 'PPTX',
    'MSG', 'EML', 'HTML', 'HTM', 'TXT',
  ]);

  const imagePageIds = pageInfos
    .filter((p) => {
      const fmt = (p.format ?? '').toString().toUpperCase().trim();
      return !NON_IMAGE_FORMATS.has(fmt) && !OFFICE_FORMATS_SOAP.has(fmt);
    })
    .map((p) => p.id);

  const officePages = pageInfos.filter((p) =>
    OFFICE_FORMATS_SOAP.has((p.format ?? '').toString().toUpperCase().trim())
  );

  const skippedCount = pageInfos.length - imagePageIds.length - officePages.length;

  return {
    imagePageIds,
    officePages,
    totalPageCount: pageInfos.length,
    skippedCount,
    pageInfos,
  };
}

/**
 * Fetch one document as a single PDF and pipe the bytes to `target` as they
 * arrive — never buffers the full PDF in memory.
 *
 *   GetMultiPageImageFileUsingPages → SOAP response containing one giant
 *   base64 string. We SAX-parse the upstream stream, extract the base64 text
 *   as it streams, decode 4-char-aligned chunks, and `target.write()` the
 *   decoded bytes. The new `securityToken` (returned after the result element)
 *   is captured and threaded back to the session at end of stream.
 *
 * Memory profile: ~64 KB transient regardless of PDF size. Previously we
 * buffered the full response text (~67 MB for a 50 MB PDF), DOM-parsed it
 * (another ~67 MB), then Buffer.from-decoded the base64 (~50 MB), pinning
 * ~200 MB transient per request. Concurrent fetches OOMed at 2 GB Node heap
 * (see 2026-06-01 crashloop incident).
 *
 * @param session   SoapSession
 * @param pageIds   page ids (from getDocumentPageIds)
 * @param target    Writable — bytes are written here as they decode
 * @returns {Promise<{bytesWritten:number}>}
 */
export async function streamPdfForPages(session, pageIds, target) {
  const refsXml = pageIds.map((pid) => `<ir:PageRef><ir:RefId>${pid}</ir:RefId></ir:PageRef>`).join('');
  const bodyInner =
    '<ir:GetMultiPageImageFileUsingPages>' +
      `<ir:securityToken>${session.token}</ir:securityToken>` +
      `<ir:pageRefs>${refsXml}</ir:pageRefs>` +
      '<ir:outputType>PDF</ir:outputType>' +
    '</ir:GetMultiPageImageFileUsingPages>';

  // NTLM transport: stream the response from `curl --ntlm` (Node fetch can't do
  // NTLM). A SOAP fault or HTML auth/error page is handled by the SAX layer below
  // (faultstring capture + the %PDF header check), so no pre-stream status check.
  const cp = spawnSoapCurl(session, 'GetMultiPageImageFileUsingPages', bodyInner, session.contentTimeoutMs);
  const t = setTimeout(() => { try { cp.kill('SIGKILL'); } catch (_) {} }, session.contentTimeoutMs + 5_000);
  let curlErr = '';
  cp.stderr.on('data', (d) => { curlErr += d; });

  return await new Promise((resolve, reject) => {
    const sx = sax.createStream(true, { trim: false, normalize: false, lowercase: false });

    let inResult = false;
    let pendingB64 = '';
    let bytesWritten = 0;
    let pdfHeaderChecked = false;
    let inSecurityToken = false;
    let tokenBuf = '';
    let inFaultString = false;
    let faultBuf = '';
    let finished = false;
    let upstreamNode = null;

    const finish = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(t);
      try { upstreamNode?.unpipe(sx); } catch (_) {}
      try { upstreamNode?.destroy(); } catch (_) {}
      try { cp.kill('SIGKILL'); } catch (_) {}
      if (err) reject(err);
      else resolve({ bytesWritten });
    };

    const localName = (n) => String(n).split(':').pop();

    sx.on('opentag', (node) => {
      const lname = localName(node.name);
      if (lname === 'GetMultiPageImageFileUsingPagesResult') {
        inResult = true;
      } else if (lname === 'securityToken') {
        inSecurityToken = true;
        tokenBuf = '';
      } else if (lname === 'faultstring') {
        inFaultString = true;
        faultBuf = '';
      }
    });

    sx.on('closetag', (tagName) => {
      const lname = localName(tagName);
      if (lname === 'GetMultiPageImageFileUsingPagesResult') {
        // Flush the tail — base64 in a real response is always a multiple of 4,
        // but pad just in case so an unexpected trailing fragment doesn't drop bytes.
        if (pendingB64.length > 0) {
          const padded = pendingB64 + '='.repeat((4 - (pendingB64.length % 4)) % 4);
          const buf = Buffer.from(padded, 'base64');
          if (buf.length > 0) {
            bytesWritten += buf.length;
            target.write(buf);
          }
          pendingB64 = '';
        }
        inResult = false;
      } else if (lname === 'securityToken') {
        if (tokenBuf) session.token = tokenBuf;
        inSecurityToken = false;
      } else if (lname === 'faultstring') {
        inFaultString = false;
      }
    });

    const onB64Text = (chunk) => {
      // Strip any whitespace / non-base64 chars before alignment math —
      // SAX may emit fragments that include trailing newlines from large
      // text nodes, and Buffer.from('base64') silently ignores them, which
      // would otherwise mis-align our pending buffer.
      const clean = String(chunk).replace(/[^A-Za-z0-9+/=]/g, '');
      if (!clean) return;
      pendingB64 += clean;
      // 4 base64 chars decode to 3 bytes; only decode what's aligned.
      const usable = pendingB64.length - (pendingB64.length % 4);
      if (usable <= 0) return;
      const slice = pendingB64.slice(0, usable);
      pendingB64 = pendingB64.slice(usable);
      const buf = Buffer.from(slice, 'base64');
      if (!pdfHeaderChecked) {
        if (buf.length < 4 || buf.subarray(0, 4).toString() !== '%PDF') {
          finish(new SoapError('GetMultiPageImageFileUsingPages', 0, 'response_not_pdf',
            `first_bytes=${buf.subarray(0, 8).toString('hex')}`));
          return;
        }
        pdfHeaderChecked = true;
      }
      bytesWritten += buf.length;
      const ok = target.write(buf);
      if (!ok) {
        // Backpressure: pause upstream until drain
        upstreamNode?.pause();
        target.once('drain', () => {
          if (!finished) upstreamNode?.resume();
        });
      }
    };

    sx.on('text', (text) => {
      if (finished) return;
      if (inResult) onB64Text(text);
      else if (inSecurityToken) tokenBuf += text;
      else if (inFaultString) faultBuf += text;
    });
    sx.on('cdata', (cdata) => {
      if (finished) return;
      if (inResult) onB64Text(cdata);
    });

    sx.on('error', (err) => {
      finish(new SoapError('GetMultiPageImageFileUsingPages', 0, 'sax_error', err.message));
    });

    sx.on('end', () => {
      if (faultBuf) {
        finish(new SoapError('GetMultiPageImageFileUsingPages', 0, faultBuf, ''));
        return;
      }
      if (bytesWritten === 0) {
        finish(new SoapError('GetMultiPageImageFileUsingPages', 0, 'no_pdf_in_response', ''));
        return;
      }
      finish();
    });

    upstreamNode = cp.stdout;
    upstreamNode.on('error', (err) => finish(err));
    cp.on('error', (e) => finish(new SoapError('GetMultiPageImageFileUsingPages', 0, 'curl_spawn_failed', e.message)));
    cp.on('close', (code) => {
      // Success (code 0 + bytes written) resolves via the SAX 'end' handler.
      // Only surface an error if curl failed and produced nothing usable.
      if (!finished && code !== 0 && bytesWritten === 0) {
        finish(new SoapError('GetMultiPageImageFileUsingPages', code === 28 ? 504 : 0,
          code === 28 ? 'timeout' : (curlErr ? curlErr.slice(0, 200) : `curl_exit_${code}`), ''));
      }
    });
    // Client disconnected mid-stream — stop pulling upstream + drop the timer.
    target.on?.('close', () => {
      if (!finished) finish(new Error('client_disconnected'));
    });
    upstreamNode.pipe(sx);
  });
}

// ---------------------------------------------------------------------------
// Discovery operations (admin / one-off — used to enumerate which custom
// attributes Nodak has defined, then decide whether we can filter on coverage
// type at the SOAP layer instead of post-pull. See
// docs/2026-06-10-ImageRight-Attribute-Discovery.md.
// ---------------------------------------------------------------------------

/**
 * Fetch a document as its native binary (no PDF conversion).
 * Used for office-format pages (DOC, DOCX, MSG, etc.) that ImageRight
 * cannot render to PDF — it returns the raw bytes instead.
 *
 * @returns {Promise<Buffer>} raw bytes of the native file
 */
export async function fetchNativeDocument(session, pageIds) {
  const refsXml = pageIds.map((pid) => `<ir:PageRef><ir:RefId>${pid}</ir:RefId></ir:PageRef>`).join('');
  const bodyInner =
    '<ir:GetMultiPageImageFileUsingPages>' +
      `<ir:securityToken>${session.token}</ir:securityToken>` +
      `<ir:pageRefs>${refsXml}</ir:pageRefs>` +
      '<ir:outputType>Native</ir:outputType>' +
    '</ir:GetMultiPageImageFileUsingPages>';

  // NTLM transport via curl (see streamPdfForPages). Native (office) responses
  // are small enough to buffer.
  const cp = spawnSoapCurl(session, 'GetMultiPageImageFileUsingPages', bodyInner, session.contentTimeoutMs);
  const t = setTimeout(() => { try { cp.kill('SIGKILL'); } catch (_) {} }, session.contentTimeoutMs + 5_000);
  let curlErr = '';
  cp.stderr.on('data', (d) => { curlErr += d; });

  return await new Promise((resolve, reject) => {
    const sx = sax.createStream(true, { trim: false, normalize: false, lowercase: false });
    let inResult = false;
    let inSecurityToken = false;
    let tokenBuf = '';
    let pendingB64 = '';
    const chunks = [];
    let finished = false;
    let upstreamNode = null;

    const finish = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(t);
      try { upstreamNode?.unpipe(sx); } catch (_) {}
      try { upstreamNode?.destroy(); } catch (_) {}
      try { cp.kill('SIGKILL'); } catch (_) {}
      if (err) reject(err);
      else resolve(Buffer.concat(chunks));
    };

    const localName = (n) => String(n).split(':').pop();

    sx.on('opentag', (node) => {
      const lname = localName(node.name);
      if (lname === 'GetMultiPageImageFileUsingPagesResult') inResult = true;
      else if (lname === 'securityToken') { inSecurityToken = true; tokenBuf = ''; }
    });

    sx.on('closetag', (tagName) => {
      const lname = localName(tagName);
      if (lname === 'GetMultiPageImageFileUsingPagesResult') {
        if (pendingB64.length > 0) {
          const padded = pendingB64 + '='.repeat((4 - (pendingB64.length % 4)) % 4);
          chunks.push(Buffer.from(padded, 'base64'));
          pendingB64 = '';
        }
        inResult = false;
      } else if (lname === 'securityToken') {
        if (tokenBuf) session.token = tokenBuf;
        inSecurityToken = false;
      }
    });

    const onB64 = (chunk) => {
      const clean = String(chunk).replace(/[^A-Za-z0-9+/=]/g, '');
      if (!clean) return;
      pendingB64 += clean;
      const usable = pendingB64.length - (pendingB64.length % 4);
      if (usable <= 0) return;
      chunks.push(Buffer.from(pendingB64.slice(0, usable), 'base64'));
      pendingB64 = pendingB64.slice(usable);
    };

    sx.on('text', (text) => {
      if (finished) return;
      if (inResult) onB64(text);
      else if (inSecurityToken) tokenBuf += text;
    });
    sx.on('cdata', (cdata) => { if (finished && inResult) onB64(cdata); });
    sx.on('error', (err) => finish(new SoapError('GetMultiPageImageFileUsingPages(Native)', 0, 'sax_error', err.message)));
    sx.on('end', () => {
      if (chunks.length === 0 && pendingB64.length === 0) {
        finish(new SoapError('GetMultiPageImageFileUsingPages(Native)', 0, 'empty_native_response', ''));
        return;
      }
      finish();
    });

    upstreamNode = cp.stdout;
    upstreamNode.on('error', (err) => finish(err));
    cp.on('error', (e) => finish(new SoapError('GetMultiPageImageFileUsingPages(Native)', 0, 'curl_spawn_failed', e.message)));
    cp.on('close', (code) => {
      if (!finished && code !== 0 && chunks.length === 0) {
        finish(new SoapError('GetMultiPageImageFileUsingPages(Native)', code === 28 ? 504 : 0,
          code === 28 ? 'timeout' : (curlErr ? curlErr.slice(0, 200) : `curl_exit_${code}`), ''));
      }
    });
    upstreamNode.pipe(sx);
  });
}

// ---------------------------------------------------------------------------

/**
 * GetAttributeDefs — system-wide catalog of every attribute definition.
 *
 * @returns Array<{id, name, displayName, description, type, disabled}>
 */
export async function getAttributeDefs(session) {
  const inner =
    '<ir:GetAttributeDefs>' +
      `<ir:securityToken>${session.token}</ir:securityToken>` +
    '</ir:GetAttributeDefs>';
  const resp = await session._call('GetAttributeDefs', inner);
  const defs = asArray(resp.GetAttributeDefsResult?.AttributeDef);
  return defs.map((d) => ({
    id: numOrNull(d.Id?.RefId),
    name: stringOrNull(d.Name),
    displayName: stringOrNull(d.DisplayName),
    description: stringOrNull(d.Description),
    type: stringOrNull(d.Type),
    disabled: stringOrNull(d.Disabled) === 'true',
  }));
}

/**
 * GetAttributes — list every attribute value set on a specific object
 * (file / folder / document). Useful for diffing BI vs PD sample claims to
 * find a coverage-type attribute.
 *
 * @returns Array<{type, id, name, value}>
 */
export async function getAttributes(session, objectId) {
  const inner =
    '<ir:GetAttributes>' +
      `<ir:securityToken>${session.token}</ir:securityToken>` +
      `<ir:objectId>${Number(objectId)}</ir:objectId>` +
    '</ir:GetAttributes>';
  const resp = await session._call('GetAttributes', inner);
  const attrs = asArray(resp.GetAttributesResult?.AttributeData);
  return attrs.map((a) => ({
    type: stringOrNull(a.Type),
    id: numOrNull(a.Id?.RefId),
    name: stringOrNull(a.Name),
    value: stringOrNull(a.Val),
  }));
}

/**
 * GetAttributeRules — attributes (with mandatory / default-value rules) that
 * apply to a given object type. typeId comes from getFileType / getFolderType
 * / getDocumentType / getDrawerType.
 *
 * @returns Array<{id, name, displayName, type, mandatory, hasDefault, defaultValue}>
 */
export async function getAttributeRules(session, typeId) {
  const inner =
    '<ir:GetAttributeRules>' +
      `<ir:securityToken>${session.token}</ir:securityToken>` +
      `<ir:typeId>${Number(typeId)}</ir:typeId>` +
    '</ir:GetAttributeRules>';
  const resp = await session._call('GetAttributeRules', inner);
  const rules = asArray(resp.GetAttributeRulesResult?.AttributeRule);
  return rules.map((r) => ({
    id: numOrNull(r.Id?.RefId),
    name: stringOrNull(r.Name),
    displayName: stringOrNull(r.DisplayName),
    type: stringOrNull(r.Type),
    mandatory: stringOrNull(r.Mandatory) === 'true',
    hasDefault: stringOrNull(r.HasDefaultValue) === 'true',
    defaultValue: stringOrNull(r.DefaultValue),
  }));
}

/**
 * GetFileType — resolve a programmatic file-type name (e.g. "CLMS") to its
 * numeric typeId, suitable for passing to getAttributeRules.
 *
 * @returns {id, name, description} | null
 */
export async function getFileType(session, programmaticName) {
  const inner =
    '<ir:GetFileType>' +
      `<ir:securityToken>${session.token}</ir:securityToken>` +
      `<ir:programmaticname>${escapeXml(programmaticName)}</ir:programmaticname>` +
    '</ir:GetFileType>';
  const resp = await session._call('GetFileType', inner);
  const result = resp.GetFileTypeResult;
  if (!result) return null;
  return {
    id: numOrNull(result.Id?.RefId),
    name: stringOrNull(result.Name),
    description: stringOrNull(result.Description),
    programmaticName: stringOrNull(result.ProgrammaticName),
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function stringOrNull(v) {
  if (v == null) return null;
  if (typeof v === 'string') return decodeEntities(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // fast-xml-parser sometimes returns objects with attributes; extract text node
  if (typeof v === 'object' && '#text' in v) return decodeEntities(String(v['#text']));
  return null;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatDate(input) {
  // Accept ISO strings / YYYY-MM-DD / Date objects. Emit yyyy-mm-ddTHH:MM:SS
  // (no timezone — ImageRight serializer treats this as local server time).
  if (input instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${input.getUTCFullYear()}-${pad(input.getUTCMonth() + 1)}-${pad(input.getUTCDate())}T${pad(input.getUTCHours())}:${pad(input.getUTCMinutes())}:${pad(input.getUTCSeconds())}`;
  }
  const s = String(input).trim();
  // YYYY-MM-DD → add T00:00:00
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + 'T00:00:00';
  // Already YYYY-MM-DDTHH:MM[:SS] — keep, strip trailing tz if present
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    return s.replace(/(Z|[+\-]\d{2}:?\d{2})$/, '').slice(0, 19).padEnd(19, '0:00:00'.slice(s.length - 16));
  }
  // Last resort — let Date parse it
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`unparseable_date: ${input}`);
  return formatDate(d);
}
