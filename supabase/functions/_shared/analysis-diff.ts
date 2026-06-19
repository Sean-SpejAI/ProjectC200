// Pure deep-diff of two claim-analysis (ai_synthesis) objects into leaf-level
// field changes, for the audit trail. NO external deps so it is unit-testable
// from the frontend vitest suite and runnable in the Deno edge runtime.
//
// Used by:
//   - save-claim-analysis      (human edits: diff stored vs submitted)
//   - synthesize-claim-extraction (AI writes: diff prior vs new synthesis)

export interface FieldChange {
  /** Dot/indexed path into the analysis, e.g. "headerInfo.demandAmount" or "medicalBillBreakdown[2].amountBilled". */
  path: string;
  /** Human-readable label derived from the path. */
  label: string;
  old: unknown;
  new: unknown;
}

// Keys we never audit: internal/provenance (leading underscore) + confidence
// scores (noisy, not reviewer-facing).
const IGNORE_KEYS = new Set(["confidence"]);
const MAX_CHANGES = 300;

function isEmpty(v: unknown): boolean {
  return v == null || (typeof v === "string" && v.trim() === "");
}

function shape(v: unknown): "array" | "object" | "primitive" {
  if (Array.isArray(v)) return "array";
  if (v != null && typeof v === "object") return "object";
  return "primitive";
}

function eq(a: unknown, b: unknown): boolean {
  if (isEmpty(a) && isEmpty(b)) return true; // null/undefined/"" are all "empty"
  if (shape(a) === "primitive" && shape(b) === "primitive") return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

// Identity-key heuristics for array elements, so arrays of objects are diffed by
// IDENTITY rather than position — a removal/reorder then yields accurate per-row
// changes instead of an index-shift cascade. First combo whose leading field is
// present wins; covers the analysis arrays (bills, injuries, providers, imaging,
// recaps, parties, documents_summary). Primitives key on their own value.
// Identity fields only — must NOT include fields a reviewer edits (e.g. a bill's
// amountBilled, a recap's summary), or editing them would read as remove+add
// instead of a field change.
const KEY_COMBOS: string[][] = [
  ["id"], ["docId"], ["injury"],
  ["provider", "date"], // medical bills (provider+date); recaps (provider, date empty)
  ["file_name"],
  ["name", "specialty"], // treatment providers
  ["type", "bodyPart", "date"], // imaging results
  ["role", "name"], // parties
];

function keyOf(el: unknown): string | null {
  if (el == null) return null;
  if (typeof el !== "object") return "v:" + String(el); // primitive identity = its value
  if (Array.isArray(el)) return null;
  const o = el as Record<string, unknown>;
  const s = (k: string) => (o[k] == null ? "" : String(o[k]).trim().toLowerCase());
  for (const combo of KEY_COMBOS) {
    if (s(combo[0]).length > 0) return combo.join(".") + ":" + combo.map(s).join("|");
  }
  return null;
}

// True when every element yields a non-null key and all keys are distinct (so a
// key-based match is unambiguous). Empty arrays are trivially key-matchable.
function uniqueKeyed(keys: (string | null)[]): boolean {
  if (keys.length === 0) return true;
  if (keys.some((k) => k === null)) return false;
  return new Set(keys).size === keys.length;
}

/**
 * Turn a path into a readable label.
 * "headerInfo.demandAmount" -> "Header Info · Demand Amount"
 * "medicalBillBreakdown[2].amountBilled" -> "Medical Bill Breakdown #3 · Amount Billed"
 */
export function labelForPath(path: string): string {
  const titleize = (s: string) =>
    s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase()).trim();
  return path
    .split(".")
    .filter(Boolean)
    .map((part) => {
      const m = part.match(/^(.*?)\[(\d+)\]$/);
      if (m) return `${titleize(m[1])} #${Number(m[2]) + 1}`;
      return titleize(part);
    })
    .join(" · ");
}

/** Deep-diff oldVal vs newVal into leaf-level field changes (ignores empties/internal keys). */
export function diffAnalysis(oldVal: unknown, newVal: unknown): FieldChange[] {
  const out: FieldChange[] = [];
  let truncated = false; // set iff a real change couldn't be recorded (cap hit)
  const push = (path: string, a: unknown, b: unknown) => {
    if (out.length < MAX_CHANGES) out.push({ path, label: labelForPath(path), old: a, new: b });
    else truncated = true;
  };
  // Note: we traverse the WHOLE structure even after the cap (no early return),
  // so `truncated` is set only when an actual change push is dropped — not merely
  // when exactly MAX_CHANGES changes were all recorded.
  const walk = (a: unknown, b: unknown, path: string): void => {
    const sa = shape(a);
    const sb = shape(b);
    if (sa !== sb) {
      if (!eq(a, b)) push(path, a, b); // shape changed (e.g. object -> string)
      return;
    }
    if (sa === "primitive") {
      if (!eq(a, b)) push(path, a, b);
      return;
    }
    if (sa === "array") {
      const aa = a as unknown[];
      const bb = b as unknown[];
      const ka = aa.map(keyOf);
      const kb = bb.map(keyOf);
      if (uniqueKeyed(ka) && uniqueKeyed(kb)) {
        // Identity-based: match elements by key so removal/reorder is accurate.
        const aByKey = new Map<string, unknown>(aa.map((el, i) => [ka[i] as string, el]));
        const bKeys = new Set(kb as string[]);
        // Removed (present in old, absent in new) — one change per removed element.
        for (let i = 0; i < aa.length; i++) {
          if (!bKeys.has(ka[i] as string)) walk(aa[i], undefined, `${path}[${i}]`);
        }
        // Matched (recurse) + added (old=undefined), iterated in NEW-array order.
        for (let i = 0; i < bb.length; i++) {
          walk(aByKey.get(kb[i] as string), bb[i], `${path}[${i}]`);
        }
        return;
      }
      // Fallback (primitives with duplicate values / unkeyable objects): equal
      // length -> positional (no shift); differing length -> one whole-array
      // change (avoids the positional cascade).
      if (aa.length === bb.length) {
        for (let i = 0; i < aa.length; i++) walk(aa[i], bb[i], `${path}[${i}]`);
      } else if (!eq(aa, bb)) {
        push(path, aa, bb);
      }
      return;
    }
    // object
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
      if (k.startsWith("_") || IGNORE_KEYS.has(k)) continue;
      walk(ao[k], bo[k], path ? `${path}.${k}` : k);
    }
  };
  walk(oldVal, newVal, "");
  // Signal truncation ONLY when a real change was actually dropped.
  if (truncated) {
    out.push({
      path: "__audit_truncated__",
      label: "Audit truncated",
      old: null,
      new: `More than ${MAX_CHANGES} fields changed; only the first ${MAX_CHANGES} were recorded.`,
    });
  }
  return out;
}
