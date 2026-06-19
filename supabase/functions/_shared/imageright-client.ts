// HTTP client for the ImageRight proxy on the nodak Azure VM.
//
// The proxy terminates the StrongSwan VPN tunnel and speaks SOAP to the
// upstream IRWebService40.asmx; this module never sees SOAP envelopes.
// External surface is JSON for metadata and `application/pdf` binary for
// document content.
//
// Goals: classify failures as retryable vs terminal, do bounded exponential
// backoff on the retryable class only, and surface a clean error envelope
// so the per-claim worker can record useful diagnostics.

const DEFAULT_BASE_TIMEOUT_MS = 60_000;
const DEFAULT_CONTENT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_RETRIES = 3;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface ImageRightClientConfig {
  proxyUrl: string;
  proxyToken: string;
}

export interface FetchOptions {
  method?: "GET" | "POST";
  body?: unknown;
  retries?: number;
  timeoutMs?: number;
  classify4xxAsTerminal?: boolean;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  contentType: string | null;
  headers: Headers;
  body: Uint8Array;
  text: () => string;
  json: <T = unknown>() => T;
  retryableExhausted?: boolean;
  terminal4xx?: boolean;
  upstreamMessage?: string;
}

// =====================================================================
// High-level types returned by the helpers
// =====================================================================

export interface SearchFilesFilter {
  fileNumber?: string;
  dateModifiedFrom?: string;
  dateModifiedTo?: string;
  dateCreatedFrom?: string;
  dateCreatedTo?: string;
}

export interface IRFileSummary {
  fileId: number;
  claimNumber: string | null;
  fileNumber2: string | null;
  fileNumber3: string | null;
  description: string | null;
}

export interface IRFileTreeFile {
  fileId: number;
  claimNumber: string | null;
  fileNumber2: string | null;
  fileNumber3: string | null;
  description: string | null;
  dateLastOpened: string | null;
}

export interface IRTreeDocument {
  docId: number;
  parentFolderId: number | null;
  // Named folder hierarchy this document lives under (root → immediate parent),
  // and the immediate parent's name. Used for folder include/exclude filtering.
  folderName: string | null;
  folderPath: string[];
  description: string | null;
  documentType: string | null;
  // Short ImageRight type code (ObjType.Name, e.g. "BIDO") for exact-match filters.
  documentTypeCode: string | null;
  pageCount: number | null;
  dateCreated: string | null;
  dateLastModified: string | null;
  documentDate: string | null;
}

export interface IRFileTree {
  file: IRFileTreeFile;
  attributes: Record<string, string | null>;
  documents: IRTreeDocument[];
}

export interface IRDocumentPdf {
  pdfBytes: Uint8Array;
  pageIds: number[];
  contentType: string;
}

export interface ClaimPresenceProbe {
  claimNumber: string;
  found: boolean;
  fileId?: number;
  description?: string | null;
  connNameInUse: string;
  availableConnections: string[];
  verdict:
    | "file_not_found_in_environment"
    | "file_present_empty"
    | "file_present_sparse"
    | "documents_present";
  note: string;
  sparseThreshold?: number;
  // Our real pull path (recursive GetContent) vs an independent server-side
  // FindDocumentsEx DB search — agreement is what makes a verdict trustworthy.
  traversal?: { documentCount: number; byType: Record<string, number> };
  search?: { documentCount: number; byType: Record<string, number> };
  topLevelDocs?: number;
  foldersTruncated?: boolean;
  topFolders?: Array<{
    id: number | null;
    name: string | null;
    description: string | null;
    maxDocDateUTC: string | null;
    directDocs: number;
    subFolders: number;
  }>;
}

// =====================================================================
// Core HTTP wrapper
// =====================================================================

export function createImageRightClient(config: ImageRightClientConfig) {
  const { proxyUrl, proxyToken } = config;
  if (!proxyUrl) throw new Error("imageright_client: proxyUrl is required");
  if (!proxyToken) throw new Error("imageright_client: proxyToken is required");

  const base = proxyUrl.replace(/\/$/, "");

  async function call(path: string, opts: FetchOptions = {}): Promise<FetchResult> {
    const {
      method = "GET",
      body,
      retries = DEFAULT_RETRIES,
      timeoutMs = DEFAULT_BASE_TIMEOUT_MS,
      classify4xxAsTerminal = false,
    } = opts;

    const url = `${base}${path}`;
    let lastError: { status: number; message: string } | null = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      const ctrl = new AbortController();
      const tHandle = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method,
          headers: {
            "Authorization": `Bearer ${proxyToken}`,
            ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
            "Accept": "application/json, application/pdf, application/octet-stream, */*",
          },
          body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
          signal: ctrl.signal,
        });
        clearTimeout(tHandle);

        const contentType = res.headers.get("content-type");
        const buf = new Uint8Array(await res.arrayBuffer());

        const result: FetchResult = {
          ok: res.ok,
          status: res.status,
          contentType,
          headers: res.headers,
          body: buf,
          text: () => new TextDecoder().decode(buf),
          json: <T>() => JSON.parse(new TextDecoder().decode(buf)) as T,
        };

        if (res.ok) return result;

        if (RETRYABLE_STATUS.has(res.status) && attempt < retries - 1) {
          lastError = { status: res.status, message: result.text().slice(0, 200) };
          await backoff(attempt);
          continue;
        }

        if (classify4xxAsTerminal && res.status >= 400 && res.status < 500 && res.status !== 401) {
          result.terminal4xx = true;
          result.upstreamMessage = result.text().slice(0, 500);
          return result;
        }

        result.upstreamMessage = result.text().slice(0, 500);
        result.retryableExhausted = RETRYABLE_STATUS.has(res.status);
        return result;
      } catch (err) {
        clearTimeout(tHandle);
        const message = err instanceof Error ? err.message : String(err);
        lastError = { status: 0, message };
        if (attempt < retries - 1) {
          await backoff(attempt);
          continue;
        }
        return {
          ok: false,
          status: 599,
          contentType: null,
          headers: new Headers(),
          body: new Uint8Array(),
          text: () => "",
          json: () => ({}),
          retryableExhausted: true,
          upstreamMessage: message,
        };
      }
    }

    return {
      ok: false,
      status: lastError?.status ?? 599,
      contentType: null,
      headers: new Headers(),
      body: new Uint8Array(),
      text: () => "",
      json: () => ({}),
      retryableExhausted: true,
      upstreamMessage: lastError?.message ?? "unknown",
    };
  }

  function backoff(attempt: number): Promise<void> {
    const delay = Math.min(1000 * 2 ** attempt, 8000);
    return new Promise((r) => setTimeout(r, delay));
  }

  return {
    // Raw fetch — escape hatch the helpers below build on.
    call,

    async healthUpstream(): Promise<FetchResult> {
      return call("/imageright/health-upstream", { method: "GET", retries: 1 });
    },

    /**
     * Search the CLMS drawer for files matching one of:
     *   - exact fileNumber (claim number)
     *   - DateModified range
     *   - DateCreated range
     * Exactly one filter must be set.
     */
    async searchFiles(filter: SearchFilesFilter): Promise<{ ok: boolean; files: IRFileSummary[]; error?: FetchResult }> {
      const res = await call("/imageright/files/search", { method: "POST", body: filter });
      if (!res.ok) return { ok: false, files: [], error: res };
      const parsed = res.json<{ files?: IRFileSummary[] }>();
      return { ok: true, files: Array.isArray(parsed?.files) ? parsed.files : [] };
    },

    /**
     * Fetch a file with its full document tree (all sub-folders flattened
     * server-side via recursive GetContent calls).
     */
    async getFileTree(fileId: number | string): Promise<{ ok: boolean; tree?: IRFileTree; error?: FetchResult }> {
      const res = await call(`/imageright/files/${encodeURIComponent(String(fileId))}`);
      if (!res.ok) return { ok: false, error: res };
      const tree = res.json<IRFileTree>();
      return { ok: true, tree };
    },

    /**
     * Download a document as a single merged PDF.
     * Response is `application/pdf` binary; pageIds come back via header
     * `X-ImageRight-Page-Ids` (CSV).
     */
    async getDocumentPdf(docId: number | string): Promise<{ ok: boolean; pdf?: IRDocumentPdf; error?: FetchResult }> {
      const res = await call(`/imageright/documents/${encodeURIComponent(String(docId))}/pdf`, {
        timeoutMs: DEFAULT_CONTENT_TIMEOUT_MS,
        classify4xxAsTerminal: true,
      });
      if (!res.ok) return { ok: false, error: res };
      const pageIdsHeader = res.headers.get("x-imageright-page-ids") ?? "";
      const pageIds = pageIdsHeader
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n));
      return {
        ok: true,
        pdf: {
          pdfBytes: res.body,
          pageIds,
          contentType: res.contentType || "application/pdf",
        },
      };
    },

    /**
     * Diagnostic: full inventory of a file — every folder + document,
     * including deleted/cut items with their delete state. Returns the
     * proxy's JSON verbatim ({ fileId, file, counts, objects[] }).
     */
    async getFileInventory(
      fileId: number | string,
      includeDeleted = true,
    ): Promise<{ ok: boolean; inventory?: unknown; error?: FetchResult }> {
      const res = await call(
        `/imageright/files/${encodeURIComponent(String(fileId))}/inventory?includeDeleted=${includeDeleted ? "true" : "false"}`,
        { timeoutMs: 120_000, retries: 1 },
      );
      if (!res.ok) return { ok: false, error: res };
      return { ok: true, inventory: res.json() };
    },

    /**
     * Diagnostic: environment presence probe for a claim number. Answers whether
     * the claim's document data is actually present in the connected ImageRight
     * environment, using BOTH our recursive pull path and an independent
     * server-side FindDocumentsEx search. Returns the proxy verdict JSON verbatim.
     */
    async probeClaim(
      claimNumber: string,
    ): Promise<{ ok: boolean; probe?: ClaimPresenceProbe; error?: FetchResult }> {
      const res = await call(
        `/imageright/claims/${encodeURIComponent(claimNumber)}/probe`,
        { timeoutMs: 120_000, retries: 1 },
      );
      if (!res.ok) return { ok: false, error: res };
      return { ok: true, probe: res.json<ClaimPresenceProbe>() };
    },

    /** Diagnostic: list the backend connections (connNames) the appsvr exposes. */
    async availableConnections(): Promise<
      { ok: boolean; connNameInUse?: string; availableConnections?: string[]; error?: FetchResult }
    > {
      const res = await call(`/imageright/connections`, { retries: 1 });
      if (!res.ok) return { ok: false, error: res };
      const parsed = res.json<{ connNameInUse?: string; availableConnections?: string[] }>();
      return {
        ok: true,
        connNameInUse: parsed.connNameInUse,
        availableConnections: parsed.availableConnections ?? [],
      };
    },
  };
}

export type ImageRightClient = ReturnType<typeof createImageRightClient>;

export function clientFromEnv(): ImageRightClient {
  const proxyUrl = Deno.env.get("IMAGERIGHT_PROXY_URL");
  const proxyToken = Deno.env.get("IMAGERIGHT_PROXY_TOKEN");
  if (!proxyUrl || !proxyToken) {
    throw new Error("IMAGERIGHT_PROXY_URL and IMAGERIGHT_PROXY_TOKEN must be configured");
  }
  return createImageRightClient({ proxyUrl, proxyToken });
}
