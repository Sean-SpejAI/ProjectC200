// Builds the Folder → Document (page collection) → Page tree for a claim's
// documents, mirroring the Sor desktop structure so adjusters can find
// the same document there.
//
// The tree is reconstructed entirely client-side from the flat claim_documents
// rows (which carry the denormalized Sor folder path + per-page manifest):
//
//   • A "page collection" node = one Sor document. For documents we
//     auto-resplit for processing, the original (superseded) HEAD row owns the
//     identity + full page manifest; opening a given page resolves to the child
//     slice that actually contains it (via claim_details.page_start/page_end).
//   • Manual uploads (no Sor id, no manifest) render as simple openable
//     page collections with no expandable page list.
//
// Page numbers are ABSOLUTE Sor page numbers; the link opens the backing
// PDF row at its INTERNAL page (mirrors the offset logic in pageCite.ts).

export interface DocTreeInput {
  id: string;
  fileName: string;
  documentType: string;
  fileUrl?: string | null;
  summary?: string;
  analysis?: unknown;
  source?: string | null;
  processingStatus?: string | null;
  sorDocumentId?: number | null;
  documentTypeCode?: string | null;
  documentDate?: string | null;
  pageCount?: number | null;
  folderPath?: Array<{ id: number | null; name: string }> | null;
  folderName?: string | null;
  pages?: Array<{ n: number | null; irPageId: number; format: string | null; rendered: boolean }> | null;
  // From claim_details:
  resplitOf?: string | null;
  pageStart?: number | null;
  pageEnd?: number | null;
  originalFileName?: string | null;
}

export interface TreePageNode {
  /** Absolute Sor page number (for display). */
  n: number;
  format: string | null;
  /** claim_documents row to open for this page. */
  docRowId: string;
  /** Page within that row's PDF (1-based). */
  internalPage: number;
}

export interface TreeDocNode {
  key: string;
  label: string;
  typeCode: string | null;
  documentType: string;
  documentDate: string | null;
  pageCount: number | null;
  analysis?: unknown;
  summary?: string;
  /** Row to open for the whole document ("Open PDF"); null when content isn't available yet. */
  openRowId: string | null;
  /** Per-page nodes (empty for manual uploads / docs without a manifest). */
  pages: TreePageNode[];
  isSor: boolean;
}

export interface TreeFolderNode {
  name: string;
  id: number | null;
  path: string;
  folders: TreeFolderNode[];
  docs: TreeDocNode[];
  /** Rolled-up page count across this folder's subtree. */
  pageCount: number;
}

export interface DocTree {
  folders: TreeFolderNode[];
  /** Documents with no Sor folder (manual uploads) — rendered top-level. */
  looseDocs: TreeDocNode[];
}

/** Strip the "[#docId]" uniqueness suffix and ".pdf" for display. */
export function stripDocLabel(fileName: string | null | undefined): string {
  return (fileName ?? "Document")
    .replace(/\s*\[#\d+\]/g, "")
    .replace(/\.pdf$/i, "")
    .trim() || "Document";
}

// Strip every "<sep> part N of M (pp. X-Y)" split-suffix segment from a name
// (server resplit uses "·", the browser uploader uses "—"), leaving just the
// source-document name. Handles deeply-nested splits (part → part) via /g.
export function stripSplitSuffix(name: string): string {
  return name.replace(/\s*[·—-]?\s*part\s+\d+\s+of\s+\d+\s*\(pp\.\s*\d+\s*-\s*\d+\)/gi, "").trim();
}

// Human-facing document name. Strips the "[#id]" uniqueness suffix, ".pdf", and
// any "· part N of M (pp. …)" split-suffixes, then — when all that's left is our
// "sor-doc-{id}" placeholder (the Sor doc had no custom Description) or
// nothing — falls back to the Sor document TYPE (e.g. "Report"), which is
// what the Sor desktop client itself shows for an unnamed document.
export function displayDocName(
  fileName: string | null | undefined,
  opts?: { documentType?: string | null },
): string {
  const stripped = stripSplitSuffix(stripDocLabel(fileName));
  if (!stripped || stripped === "Document" || /^sor-doc-\d+$/i.test(stripped)) {
    const type = opts?.documentType?.trim();
    if (type) return type;
  }
  return stripped || "Document";
}

// Display label for a tree node. For a split slice (it carries an absolute
// page_start/page_end), show the document's base name + its page range —
// e.g. "PIP Records (pp. 151-165)" — instead of the raw, deeply-nested
// "… · part N of M (pp. …)" file name. Non-split docs keep their stripped name.
function nodeLabel(d: DocTreeInput): string {
  const base = displayDocName(d.fileName, { documentType: d.documentType });
  if (typeof d.pageStart === "number" && typeof d.pageEnd === "number" && d.pageEnd >= d.pageStart) {
    return `${base} (pp. ${d.pageStart}-${d.pageEnd})`;
  }
  return base;
}

function buildPages(head: DocTreeInput, children: DocTreeInput[]): TreePageNode[] {
  const manifest = Array.isArray(head.pages) ? head.pages : [];
  const rendered = manifest.filter(
    (p): p is { n: number; irPageId: number; format: string | null; rendered: boolean } =>
      !!p && p.rendered === true && typeof p.n === "number",
  );
  if (rendered.length === 0) return [];

  if (children.length === 0) {
    // Not split — every page opens the head row at its own page.
    return rendered.map((p) => ({ n: p.n, format: p.format, docRowId: head.id, internalPage: p.n }));
  }

  // Split — resolve each absolute page to the child slice that contains it.
  return rendered.map((p) => {
    const child = children.find(
      (c) => (c.pageStart ?? 1) <= p.n && p.n <= (c.pageEnd ?? Number.POSITIVE_INFINITY),
    );
    if (!child) return { n: p.n, format: p.format, docRowId: head.id, internalPage: p.n };
    return { n: p.n, format: p.format, docRowId: child.id, internalPage: p.n - (child.pageStart ?? 1) + 1 };
  });
}

function pickOpenRow(head: DocTreeInput, children: DocTreeInput[]): string | null {
  if (head.fileUrl) return head.id; // resplit heads retain their full-doc PDF
  const firstChild = children.find((c) => c.fileUrl);
  return firstChild ? firstChild.id : null;
}

function sortDocs(docs: TreeDocNode[]): TreeDocNode[] {
  return docs.slice().sort((a, b) => {
    const da = a.documentDate ?? "";
    const db = b.documentDate ?? "";
    if (da !== db) return db.localeCompare(da); // newest first
    return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" });
  });
}

function rollupAndSort(folder: TreeFolderNode): number {
  let total = 0;
  for (const f of folder.folders) total += rollupAndSort(f);
  for (const d of folder.docs) total += d.pageCount ?? d.pages.length ?? 0;
  folder.pageCount = total;
  folder.folders.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
  );
  folder.docs = sortDocs(folder.docs);
  return total;
}

export function buildDocTree(docs: DocTreeInput[]): DocTree {
  // Group resplit children under their head id, and mark child ids so they
  // aren't rendered as standalone page collections. Only fold a child when its
  // head is actually present in the set — otherwise (head filtered out, e.g. a
  // superseded manual parent) the child renders standalone instead of vanishing.
  const allIds = new Set(docs.map((d) => d.id));
  const childrenByHead = new Map<string, DocTreeInput[]>();
  const childIds = new Set<string>();
  for (const d of docs) {
    if (d.resplitOf && allIds.has(d.resplitOf)) {
      childIds.add(d.id);
      const arr = childrenByHead.get(d.resplitOf) ?? [];
      arr.push(d);
      childrenByHead.set(d.resplitOf, arr);
    }
  }

  const docNodes: Array<{ node: TreeDocNode; folderPath: Array<{ id: number | null; name: string }> | null }> = [];
  for (const d of docs) {
    if (childIds.has(d.id)) continue; // folded into its head
    const isIR = d.sorDocumentId != null;
    const children = (childrenByHead.get(d.id) ?? [])
      .slice()
      .sort((a, b) => (a.pageStart ?? 0) - (b.pageStart ?? 0));
    const pages = buildPages(d, children);
    docNodes.push({
      node: {
        key: isIR ? `ir:${d.sorDocumentId}` : `doc:${d.id}`,
        label: nodeLabel(d),
        typeCode: d.documentTypeCode ?? null,
        documentType: d.documentType,
        documentDate: d.documentDate ?? null,
        pageCount: d.pageCount ?? (pages.length || null),
        analysis: d.analysis,
        summary: d.summary,
        openRowId: pickOpenRow(d, children),
        pages,
        isSor: isIR,
      },
      folderPath: d.folderPath ?? null,
    });
  }

  const root: TreeFolderNode = { name: "", id: null, path: "", folders: [], docs: [], pageCount: 0 };
  const looseDocs: TreeDocNode[] = [];
  for (const { node, folderPath } of docNodes) {
    if (!folderPath || folderPath.length === 0) {
      looseDocs.push(node);
      continue;
    }
    let cursor = root;
    let pathKey = "";
    for (const seg of folderPath) {
      pathKey += "/" + (seg.name ?? "");
      let next = cursor.folders.find((f) => f.name === seg.name);
      if (!next) {
        next = { name: seg.name, id: seg.id ?? null, path: pathKey, folders: [], docs: [], pageCount: 0 };
        cursor.folders.push(next);
      }
      cursor = next;
    }
    cursor.docs.push(node);
  }

  rollupAndSort(root);
  return { folders: root.folders, looseDocs: sortDocs(looseDocs) };
}
