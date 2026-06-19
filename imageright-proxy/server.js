import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import { execFile } from 'node:child_process';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import mammoth from 'mammoth';

import {
  SoapSession,
  SoapError,
  findFiles,
  getFileTree,
  getFileInventory,
  getDocumentPageIds,
  streamPdfForPages,
  fetchNativeDocument,
  getAttributeDefs,
  getAttributes,
  getAttributeRules,
  getFileType,
  getAvailableConnections,
  findDocumentsByFileNumber,
  getFilePresence,
} from './soap.js';

const {
  IMAGERIGHT_SOAP_URL,
  IMAGERIGHT_SOAP_HOST,
  PROXY_SHARED_SECRET,
  IR_USERNAME,
  IR_PASSWORD,
  PORT = '8080',
} = process.env;

if (!IMAGERIGHT_SOAP_URL) {
  console.error('FATAL: IMAGERIGHT_SOAP_URL is not set (e.g. http://192.168.11.179/imageright.webservice/IRWebService40.asmx)');
  process.exit(1);
}
if (!IMAGERIGHT_SOAP_HOST) {
  console.error('FATAL: IMAGERIGHT_SOAP_HOST is not set (the Host header value, e.g. irtest-appsvr.nodakmutual.com)');
  process.exit(1);
}
if (!PROXY_SHARED_SECRET || PROXY_SHARED_SECRET.length < 32) {
  console.error('FATAL: PROXY_SHARED_SECRET must be at least 32 characters');
  process.exit(1);
}
if (!IR_USERNAME || !IR_PASSWORD) {
  console.error('FATAL: IR_USERNAME and IR_PASSWORD must be set');
  process.exit(1);
}

// Office formats that are fetched as native binary and converted to PDF
// via mammoth (text extraction) + Chrome headless (HTML→PDF).
const OFFICE_FORMATS = new Set([
  'DOC', 'DOCX', 'RTF',
  'XLS', 'XLSX',
  'PPT', 'PPTX',
  'MSG', 'EML',
  'HTML', 'HTM',
  'TXT',
]);

/**
 * Convert a DOCX/DOC buffer to a PDF buffer using mammoth (DOCX→HTML)
 * then Chrome headless (HTML→PDF). Falls back to plain-text wrapping for
 * non-DOCX formats. Temp files are written to /tmp and cleaned up.
 *
 * @param {Buffer} docBuf - raw file bytes
 * @param {string} format - uppercased format string (e.g. 'DOCX')
 * @returns {Promise<Buffer>} PDF bytes
 */
async function nativeDocToPdf(docBuf, format) {
  const id = randomUUID();
  const htmlPath = `/tmp/ir-convert-${id}.html`;
  const pdfPath = `/tmp/ir-convert-${id}.pdf`;

  let html;
  if (['DOCX', 'DOC'].includes(format)) {
    const result = await mammoth.convertToHtml({ buffer: docBuf });
    html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body { font-family: Arial, sans-serif; margin: 2cm; font-size: 11pt; line-height: 1.4; }
      table { border-collapse: collapse; width: 100%; }
      td, th { border: 1px solid #ccc; padding: 4px; }
    </style></head><body>${result.value}</body></html>`;
  } else {
    // For other formats, render the raw text in a simple wrapper.
    const text = docBuf.toString('utf8').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body { font-family: monospace; white-space: pre-wrap; margin: 2cm; font-size: 10pt; }
    </style></head><body>${text}</body></html>`;
  }

  await writeFile(htmlPath, html, 'utf8');

  await new Promise((resolve, reject) => {
    execFile(process.env.CHROME_BIN || 'google-chrome', [
      '--headless', '--no-sandbox', '--disable-gpu',
      '--disable-software-rasterizer', '--disable-dev-shm-usage',
      `--print-to-pdf=${pdfPath}`,
      '--print-to-pdf-no-header',
      htmlPath,
    ], { timeout: 30_000 }, (err) => {
      if (err) reject(err); else resolve();
    });
  });

  const pdfBuf = await readFile(pdfPath);
  await unlink(htmlPath).catch(() => {});
  await unlink(pdfPath).catch(() => {});
  return pdfBuf;
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('combined', { skip: (req) => req.path === '/health' }));

// ---------------------------------------------------------------------------
// Inbound auth
// ---------------------------------------------------------------------------

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function requireBearerToken(req, res, next) {
  const header = req.get('Authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'missing_or_invalid_authorization_header' });
  }
  if (!timingSafeEqual(token, PROXY_SHARED_SECRET)) {
    return res.status(401).json({ error: 'invalid_token' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Session helper — fresh login per request
// ---------------------------------------------------------------------------

async function startSession() {
  const session = new SoapSession({
    endpoint: IMAGERIGHT_SOAP_URL,
    hostHeader: IMAGERIGHT_SOAP_HOST,
    // IIS Windows Authentication (NTLM) is enabled on the WebService, so every
    // request carries these HTTP NTLM credentials (the Windows account). They're
    // the same creds we authenticate the SOAP body with.
    ntlmUser: IR_USERNAME,
    ntlmPass: IR_PASSWORD,
  });
  await session.login(IR_USERNAME, IR_PASSWORD, 'Test');
  return session;
}

function reportError(res, action, err) {
  if (err instanceof SoapError) {
    const status = err.notLoggedIn ? 502 : 502;
    return res.status(status).json({
      error: 'upstream_soap_fault',
      action,
      message: err.upstreamMessage,
    });
  }
  if (err?.name === 'AbortError') {
    return res.status(504).json({ error: 'upstream_timeout', action });
  }
  console.error(`upstream_error ${action}`, err);
  return res.status(502).json({ error: 'upstream_error', action, message: err?.message || String(err) });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Pre-flight: confirms VPN + service account by completing a UserLogin.
// We don't run any further ops — UserLogin success implies the upstream
// is reachable and credentials are good.
app.get('/imageright/health-upstream', requireBearerToken, async (_req, res) => {
  try {
    const session = await startSession();
    return res.json({
      status: 'ok',
      upstream: 'soap',
      tokenPrefix: String(session.token).slice(0, 8),
    });
  } catch (err) {
    return reportError(res, 'UserLogin', err);
  }
});

// Search files. Exactly one of:
//   { fileNumber: "0000372262" }
//   { dateModifiedFrom: "2026-05-12", dateModifiedTo: "2026-05-13" }
//   { dateCreatedFrom:  "2026-05-12", dateCreatedTo:  "2026-05-13" }
// Drawer is hard-coded to 1383 (CLMS) inside soap.js.
app.post('/imageright/files/search', requireBearerToken, async (req, res) => {
  try {
    const session = await startSession();
    const files = await findFiles(session, req.body ?? {});
    return res.json({ files });
  } catch (err) {
    return reportError(res, 'FindFilesEx', err);
  }
});

// Get a file's full tree: metadata + attributes + flat list of documents
// (recursively gathered across all sub-folders).
app.get('/imageright/files/:fileId', requireBearerToken, async (req, res) => {
  const fileId = Number(req.params.fileId);
  if (!Number.isFinite(fileId) || fileId <= 0) {
    return res.status(400).json({ error: 'invalid_file_id' });
  }
  try {
    const session = await startSession();
    const tree = await getFileTree(session, fileId);
    return res.json(tree);
  } catch (err) {
    return reportError(res, 'GetFileByRef', err);
  }
});

// Diagnostic: full inventory of a file — EVERY folder + document, including
// deleted/cut items, each with its delete state. Lets an operator verify what
// ImageRight actually holds for a claim. `?includeDeleted=false` to hide
// deleted/cut (defaults to true so nothing is hidden).
app.get('/imageright/files/:fileId/inventory', requireBearerToken, async (req, res) => {
  const fileId = Number(req.params.fileId);
  if (!Number.isFinite(fileId) || fileId <= 0) {
    return res.status(400).json({ error: 'invalid_file_id' });
  }
  const includeDeleted = req.query.includeDeleted !== 'false'; // default true
  try {
    const session = await startSession();
    const { file, objects } = await getFileInventory(session, fileId, includeDeleted);
    const byDeleteIndicator = {};
    let folders = 0;
    let documents = 0;
    for (const o of objects) {
      if (o.kind === 'Folder') folders += 1;
      else if (o.kind === 'Document') documents += 1;
      const k = o.deleteIndicator || 'None';
      byDeleteIndicator[k] = (byDeleteIndicator[k] || 0) + 1;
    }
    return res.json({
      fileId,
      includeDeleted,
      file,
      counts: { folders, documents, byDeleteIndicator },
      objects,
    });
  } catch (err) {
    return reportError(res, 'GetFileByRef', err);
  }
});

// Diagnostic: which backend databases (connNames) does this appsvr expose?
// A single "Test" entry confirms there is no prod connection to switch to.
app.get('/imageright/connections', requireBearerToken, async (_req, res) => {
  try {
    const session = await startSession();
    const availableConnections = await getAvailableConnections(session);
    return res.json({ connNameInUse: 'Test', availableConnections });
  } catch (err) {
    return reportError(res, 'AvailableConnections', err);
  }
});

// Diagnostic: environment presence probe by claim number. Answers "is this
// claim's document data actually present in the ImageRight environment this
// proxy is connected to?" using BOTH our real pull path (getFileTree's
// recursive folder walk) AND an independent server-side document search
// (FindDocumentsEx — can't share a traversal bug), plus the backend connections
// this appsvr exposes. Returns a machine-readable verdict + all raw counts and a
// byType breakdown so it's fully auditable.
//   ?sparseThreshold=10  — docs at/below this (and >0) => file_present_sparse.
app.get('/imageright/claims/:claimNumber/probe', requireBearerToken, async (req, res) => {
  const claimNumber = String(req.params.claimNumber || '').trim();
  if (!claimNumber) return res.status(400).json({ error: 'invalid_claim_number' });
  const reqThreshold = Number(req.query.sparseThreshold);
  const sparseThreshold = Number.isFinite(reqThreshold) && reqThreshold > 0 ? reqThreshold : 10;
  try {
    const session = await startSession();
    const availableConnections = await getAvailableConnections(session);
    const files = await findFiles(session, { fileNumber: claimNumber });
    if (files.length === 0) {
      return res.json({
        claimNumber,
        found: false,
        connNameInUse: 'Test',
        availableConnections,
        verdict: 'file_not_found_in_environment',
        note: `No file with number ${claimNumber} exists in the connected ImageRight environment (drawer CLMS/1383).`,
      });
    }
    const file = files[0];
    const tree = await getFileTree(session, file.fileId);
    const searchDocs = await findDocumentsByFileNumber(session, claimNumber, true);
    const presence = await getFilePresence(session, file.fileId);

    const byType = (list) => {
      const m = {};
      for (const d of list) {
        const k = d.documentTypeCode || 'unknown';
        m[k] = (m[k] || 0) + 1;
      }
      return m;
    };
    const traversal = { documentCount: tree.documents.length, byType: byType(tree.documents) };
    const search = { documentCount: searchDocs.length, byType: byType(searchDocs) };
    const documentCount = Math.max(traversal.documentCount, search.documentCount);

    let verdict;
    let note;
    if (documentCount === 0) {
      verdict = 'file_present_empty';
      note = 'File exists but contains no documents in this environment.';
    } else if (documentCount <= sparseThreshold) {
      verdict = 'file_present_sparse';
      note = `File exists but holds only ${documentCount} document(s) visible to our service account (webagent) — typically the skeleton (SG11 / New Mail / STAT). Substantive content (BI/medical/bills/records) is NOT visible here: either it is not loaded in this environment, OR ImageRight document-class permissions restrict our account from those document types. Inspect byType; confirm with Nodak.`;
    } else {
      verdict = 'documents_present';
      note = `File holds ${documentCount} documents in this environment.`;
    }

    return res.json({
      claimNumber,
      found: true,
      fileId: file.fileId,
      description: file.description,
      connNameInUse: 'Test',
      availableConnections,
      verdict,
      note,
      sparseThreshold,
      traversal, // our real pull path (recursive GetContent)
      search,    // independent FindDocumentsEx DB search
      topLevelDocs: presence.topLevelDocs,
      foldersTruncated: presence.foldersTruncated,
      topFolders: presence.topFolders,
    });
  } catch (err) {
    return reportError(res, 'ClaimPresenceProbe', err);
  }
});

// Fetch one document as a merged PDF. Streams application/pdf back —
// bytes go straight from the upstream SOAP response (base64 inside XML)
// through a SAX parser → 4-char-aligned base64 decode → res.write, so the
// proxy never buffers the full PDF in memory regardless of size.
// Non-image pages (emails, Word docs, etc.) are filtered before the fetch so
// ImageRight doesn't embed "This page could not be converted to PDF." placeholders.
app.get('/imageright/documents/:docId/pdf', requireBearerToken, async (req, res) => {
  const docId = Number(req.params.docId);
  if (!Number.isFinite(docId) || docId <= 0) {
    return res.status(400).json({ error: 'invalid_doc_id' });
  }
  let session;
  let pageResult;
  try {
    session = await startSession();
    pageResult = await getDocumentPageIds(session, docId);
  } catch (err) {
    return reportError(res, 'GetPages', err);
  }
  const { imagePageIds, officePages, totalPageCount, skippedCount } = pageResult;
  const officePageIds = officePages.map((p) => p.id);
  const officeFormat = officePages[0]?.format?.toUpperCase() ?? null;

  if (imagePageIds.length === 0 && officePageIds.length === 0) {
    const allFormats = pageResult.pageInfos.map((p) => p.format ?? 'null').join(',');
    return res.status(422).json({
      error: 'no_renderable_pages',
      totalPageCount,
      skippedCount,
      formats: allFormats,
    });
  }

  res.set('Content-Type', 'application/pdf');
  res.set('X-ImageRight-Page-Count', String(totalPageCount));
  res.set('X-ImageRight-Renderable-Pages', String(imagePageIds.length + officePageIds.length));
  if (skippedCount > 0) {
    res.set('X-ImageRight-Skipped-Non-Image', String(skippedCount));
  }
  if (officePageIds.length > 0) {
    res.set('X-ImageRight-Office-Converted', String(officePageIds.length));
  }

  // Pure office document (no image pages) — fetch native + convert to PDF.
  if (imagePageIds.length === 0 && officePageIds.length > 0) {
    try {
      const nativeBuf = await fetchNativeDocument(session, officePageIds);
      const pdfBuf = await nativeDocToPdf(nativeBuf, officeFormat ?? 'DOCX');
      res.set('X-ImageRight-Page-Ids', officePageIds.join(','));
      res.send(pdfBuf);
      return;
    } catch (err) {
      return reportError(res, 'NativeDocToPdf', err);
    }
  }

  // Optional page range (1-based, inclusive, over the RENDERED image-page set)
  // for batched fetching of oversized documents: ?from=1&to=100. ImageRight
  // faults when asked to render a very large PDF in one call (~668 pages →
  // sax_error at ~134s), so callers split big docs into smaller ranges. Absent
  // params → the whole document (unchanged behavior).
  let selectedImagePageIds = imagePageIds;
  const fromQ = parseInt(req.query.from, 10);
  const toQ = parseInt(req.query.to, 10);
  if (Number.isFinite(fromQ) || Number.isFinite(toQ)) {
    const from = Number.isFinite(fromQ) ? fromQ : 1;
    const to = Number.isFinite(toQ) ? toQ : imagePageIds.length;
    if (from < 1 || to < from || from > imagePageIds.length) {
      return res.status(400).json({ error: 'invalid_range', from, to, renderablePages: imagePageIds.length });
    }
    selectedImagePageIds = imagePageIds.slice(from - 1, to); // `to` clamps naturally
    res.set('X-ImageRight-Range-From', String(from));
    res.set('X-ImageRight-Range-To', String(Math.min(to, imagePageIds.length)));
  }

  // Image-only or mixed: stream image pages as PDF. For mixed docs with
  // office pages, the office content is currently omitted (TODO: merge PDFs).
  res.set('X-ImageRight-Page-Ids', selectedImagePageIds.join(','));
  try {
    await streamPdfForPages(session, selectedImagePageIds, res);
    res.end();
  } catch (err) {
    if (res.headersSent) {
      console.error('upstream_error_mid_stream', err);
      try { res.destroy(err); } catch (_) {}
      return;
    }
    return reportError(res, 'GetMultiPageImageFileUsingPages', err);
  }
});

// Per-page manifest for one document. Returns the ordered page list with the
// merged-PDF ordinal (`n`), the ImageRight page id, the page Format, and whether
// the page is rendered into the PDF. This is the structured source for the
// portal's per-page tree level + page-jump links, and replaces the size-limited
// `X-ImageRight-Page-Ids` header (which silently truncates for 1000+ page docs).
//
// `n` mirrors GetMultiPageImageFileUsingPages page order exactly: rendered pages
// are numbered 1..N in document order; non-rendered pages (audio/video, plus the
// office pages omitted from a mixed image+office doc) carry rendered=false, n=null.
app.get('/imageright/documents/:docId/pages', requireBearerToken, async (req, res) => {
  const docId = Number(req.params.docId);
  if (!Number.isFinite(docId) || docId <= 0) {
    return res.status(400).json({ error: 'invalid_doc_id' });
  }
  let result;
  try {
    const session = await startSession();
    result = await getDocumentPageIds(session, docId);
  } catch (err) {
    return reportError(res, 'GetPages', err);
  }
  // Mirror the /pdf route's branch: an image-only or mixed doc renders its image
  // pages; a pure-office doc renders its (native-converted) office pages. The
  // rendered set, in document order, is the merged-PDF page order.
  const renderedIds = result.imagePageIds.length > 0
    ? result.imagePageIds
    : result.officePages.map((p) => p.id);
  const renderedSet = new Set(renderedIds);
  let ord = 0;
  const pages = result.pageInfos.map((p) => {
    const rendered = renderedSet.has(p.id);
    return {
      n: rendered ? ++ord : null,
      irPageId: p.id,
      format: p.format ?? null,
      rendered,
    };
  });
  return res.json({
    docId,
    totalPageCount: result.totalPageCount,
    renderedPageCount: renderedIds.length,
    skippedCount: result.skippedCount,
    pages,
  });
});

// Debug: inspect raw page metadata (id + Format) for a document.
// Used to verify Format values before/after blocklist tuning.
app.get('/imageright/debug/pages/:docId', requireBearerToken, async (req, res) => {
  const docId = Number(req.params.docId);
  if (!Number.isFinite(docId) || docId <= 0) {
    return res.status(400).json({ error: 'invalid_doc_id' });
  }
  try {
    const session = await startSession();
    const result = await getDocumentPageIds(session, docId);
    return res.json({
      docId,
      totalPageCount: result.totalPageCount,
      imagePageCount: result.imagePageIds.length,
      skippedCount: result.skippedCount,
      pages: result.pageInfos,
    });
  } catch (err) {
    return reportError(res, 'GetPages', err);
  }
});

// ---------------------------------------------------------------------------
// Admin discovery — enumerate ImageRight custom attributes so we can decide
// whether to filter at the SOAP layer (e.g. BI vs PD). See
// docs/2026-06-10-ImageRight-Attribute-Discovery.md.
//
// Bearer-token gated like every other route. Cheap calls (one SOAP round-trip
// each) — safe to leave deployed.
// ---------------------------------------------------------------------------

app.get('/imageright/discover/attribute-defs', requireBearerToken, async (_req, res) => {
  try {
    const session = await startSession();
    const defs = await getAttributeDefs(session);
    return res.json({ count: defs.length, defs });
  } catch (err) {
    return reportError(res, 'GetAttributeDefs', err);
  }
});

app.get('/imageright/discover/attributes/:objectId', requireBearerToken, async (req, res) => {
  const objectId = Number(req.params.objectId);
  if (!Number.isFinite(objectId) || objectId <= 0) {
    return res.status(400).json({ error: 'invalid_object_id' });
  }
  try {
    const session = await startSession();
    const attrs = await getAttributes(session, objectId);
    return res.json({ objectId, count: attrs.length, attrs });
  } catch (err) {
    return reportError(res, 'GetAttributes', err);
  }
});

app.get('/imageright/discover/attribute-rules/:typeId', requireBearerToken, async (req, res) => {
  const typeId = Number(req.params.typeId);
  if (!Number.isFinite(typeId) || typeId <= 0) {
    return res.status(400).json({ error: 'invalid_type_id' });
  }
  try {
    const session = await startSession();
    const rules = await getAttributeRules(session, typeId);
    return res.json({ typeId, count: rules.length, rules });
  } catch (err) {
    return reportError(res, 'GetAttributeRules', err);
  }
});

app.get('/imageright/discover/file-type/:name', requireBearerToken, async (req, res) => {
  const name = String(req.params.name || '').trim();
  if (!name) return res.status(400).json({ error: 'invalid_name' });
  try {
    const session = await startSession();
    const fileType = await getFileType(session, name);
    return res.json({ name, fileType });
  } catch (err) {
    return reportError(res, 'GetFileType', err);
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

app.listen(Number(PORT), () => {
  console.log(`imageright-proxy (SOAP) listening on :${PORT}`);
});
