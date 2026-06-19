// Page-citation resolver.
//
// Two jobs:
//  1. Resolve a stored citation string ("<file_name> p. N") to the right claim
//     document — robustly, even when a claim has many identically-described
//     Sor documents (we suffix file names with "[#docId]" so they're
//     unique; the AI cites that name).
//  2. Render a LAYERED citation that mirrors Sor — folder › document
//     (page collection) › page — and a LINK that opens the backing PDF at the
//     correct page.
//
// Split-document detail: a large PDF is split into slices whose internal pages
// run 1..N while the filename advertises the ORIGINAL page range, e.g.
// "… part 3 of 3 (pp. 101-150).pdf". The model cites the SLICE page
// (chunk-relative: "p. 1" = original page 101). We therefore show the page in
// ORIGINAL numbering (1 + page_start - 1) while linking to the slice's INTERNAL
// page (#page=1). For non-split docs (no page_start) display == link page.

import { displayDocName } from "./docTree";

export interface CiteDoc {
  id?: string | null;
  fileName?: string | null;
  fileUrl?: string | null;
  /** Original-document page where this slice starts (from claim_details.page_start). Null/1 for non-split. */
  pageStart?: number | null;
  /** Sor folder this document lives under (immediate parent). */
  folderName?: string | null;
  /** Short Sor type code (e.g. "BIDO"); used only as supplemental context. */
  documentTypeCode?: string | null;
  /** Human document type (ObjType.Description, e.g. "Report"); used as the label when the file has no custom name. */
  documentType?: string | null;
}

export interface ResolvedCite {
  /** Layered citation text — "folder › document › p. N" — no outer parens. */
  text: string;
  /** Matched document id — open it via the sign-claim-document edge proxy (bucket is private). */
  documentId?: string;
  /** Internal (slice-relative) page to open at, when resolvable. */
  page?: number;
}

const normFull = (s: string): string =>
  s.toLowerCase().replace(/[()]/g, "").replace(/\.pdf\b/g, "").replace(/\s+/g, " ").trim();

const normNoId = (s: string): string =>
  normFull(s).replace(/\[#\d+\]/g, "").replace(/\s+/g, " ").trim();

// Longest normalized-fileName substring match within a candidate list.
function longestMatch(
  refNorm: string,
  docs: CiteDoc[],
  norm: (s: string) => string,
): CiteDoc | undefined {
  let best: CiteDoc | undefined;
  let bestLen = -1;
  for (const d of docs) {
    if (!d.fileName) continue;
    const fn = norm(d.fileName);
    if (fn && refNorm.includes(fn) && fn.length > bestLen) {
      best = d;
      bestLen = fn.length;
    }
  }
  return best;
}

// Resolve the cited document. Tiers (most→least specific):
//  1. Exact "[#docId]" token in the citation → among docs carrying that id,
//     the longest full-name match (picks the right resplit slice). A unique id
//     resolves even if the rest of the name was shortened.
//  2. Longest full-name substring match (id kept — disambiguates duplicate
//     descriptions, since the id is part of the name).
//  3. Longest id-stripped match (fallback when the model dropped the suffix).
function matchDoc(raw: string, docs: CiteDoc[]): CiteDoc | undefined {
  const idm = raw.match(/\[#(\d+)\]/);
  if (idm) {
    const token = `[#${idm[1]}]`;
    const cands = docs.filter((d) => (d.fileName ?? "").includes(token));
    const byName = longestMatch(normFull(raw), cands, normFull);
    if (byName) return byName;
    if (cands.length === 1) return cands[0];
  }
  return longestMatch(normFull(raw), docs, normFull) ?? longestMatch(normNoId(raw), docs, normNoId);
}

// Parse a trailing page expression's body (the part after "p."/"pp.") into an
// ordered list of pages/ranges: "1, 76, 78" → [{1},{76},{78}], "256-270" →
// [{256,270}], "5" → [{5}]. Tolerates en-dashes and stray whitespace.
function parsePageList(group: string): Array<{ start: number; end?: number }> {
  const out: Array<{ start: number; end?: number }> = [];
  for (const tok of group.split(",")) {
    const t = tok.trim();
    if (!t) continue;
    const rng = t.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (rng) {
      out.push({ start: parseInt(rng[1], 10), end: parseInt(rng[2], 10) });
      continue;
    }
    const single = t.match(/^(\d+)$/);
    if (single) out.push({ start: parseInt(single[1], 10) });
  }
  return out;
}

/**
 * Resolve a stored citation string into a layered display citation + a link
 * into the backing PDF. `docs` is the claim's document list (CiteDoc[]).
 */
export function resolvePageCite(
  pageRef: string | null | undefined,
  docs: CiteDoc[] = [],
): ResolvedCite {
  if (!pageRef) return { text: "" };
  // Collapse a redundant inner "(p. N)" / "(pp. N-M)" wrapper, like fmtPageRef does.
  const raw = String(pageRef)
    .replace(/\((pp?\.\s*[^)]*)\)/gi, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!raw) return { text: "" };

  const match = matchDoc(raw, docs);

  // Parse the TRAILING page citation, which may be a single page ("p. 5"), a
  // range ("pp. 256-270"), or a comma-separated list ("pp. 1, 76, 78" — one
  // provider spanning several pages). Anchored at end so the "(pp. 101-150)"
  // range embedded in the FILENAME is never mistaken for it.
  const m = raw.match(/\bpp?\.\s*([\d\s,–-]+?)\s*$/i);
  const offset = match?.pageStart && match.pageStart > 1 ? match.pageStart - 1 : 0;

  let pageText = "";
  let internalStart: number | undefined;
  if (m) {
    const items = parsePageList(m[1]);
    if (items.length > 0) {
      // Link target = the FIRST cited page, slice-relative (before offset).
      internalStart = items[0].start;
      // Display each page/range in ORIGINAL numbering (offset applied).
      const dispParts = items.map((it) =>
        it.end != null ? `${it.start + offset}-${it.end + offset}` : `${it.start + offset}`,
      );
      const single = items.length === 1 && items[0].end == null;
      pageText = `${single ? "p." : "pp."} ${dispParts.join(", ")}`;
    }
  }

  let text: string;
  if (match) {
    // Rebuild the citation from the matched document's metadata: folder ›
    // document › page. Strip the "[#id]" suffix + ".pdf", and the internal
    // "· part N of M (pp. …)" split-suffixes, so a citation reads
    // "PIP Records › p. 256" not "PIP Records · part 3 of 5 … · part 2 of 8 … › p. 256".
    const folder = match.folderName?.trim();
    const label = displayDocName(match.fileName, { documentType: match.documentType });
    const head = [folder, label].filter(Boolean).join(" › ");
    text = pageText ? (head ? `${head} › ${pageText}` : pageText) : head;
  } else {
    // No matched document — show the cleaned citation text (strip "[#id]").
    const prefix = m ? raw.slice(0, m.index).trim() : raw;
    const cleanedPrefix = prefix.replace(/\s*\[#\d+\]/g, "").replace(/\.pdf\b/gi, "").trim();
    text = [cleanedPrefix, pageText].filter(Boolean).join(" ");
  }

  return {
    text,
    documentId: match?.id ? String(match.id) : undefined,
    page: match?.id && internalStart != null ? internalStart : undefined,
  };
}
