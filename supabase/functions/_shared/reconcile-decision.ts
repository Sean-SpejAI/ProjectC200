// Pure reconcile decision logic — NO Deno/Supabase/network dependencies — so it
// is unit-testable from the frontend vitest suite as well as runnable in the
// Deno edge runtime (imported by sor-pull-claim.ts).

export type ReconcileMode = "noop" | "incremental" | "full";

export interface ReconcileThresholds {
  // FULL re-analysis when the changed fraction ((added+modified+removed)/stored)
  // meets/exceeds this.
  fullMinChangedFraction: number;
  // ...or when at least this many NEW documents appeared.
  fullMinAddedAbs: number;
  // ...or when the removed fraction (removed/stored) exceeds this.
  fullMaxRemovedFraction: number;
  // ...or when documents moved / appeared under a new folder path (reorg).
  fullOnFolderReorg: boolean;
  // Whether an incremental soft-remove also deletes the storage object. Default
  // false — a transient Sor blip stays recoverable; a dated GC sweep can
  // reclaim space later.
  purgeStorageOnRemove: boolean;
}

export const DEFAULT_RECONCILE_THRESHOLDS: ReconcileThresholds = {
  fullMinChangedFraction: 0.40,
  fullMinAddedAbs: 50,
  fullMaxRemovedFraction: 0.10,
  fullOnFolderReorg: true,
  purgeStorageOnRemove: false,
};

export interface TreeDiff {
  isKnown: boolean;        // claim already has stored docs
  storedCount: number;     // active stored HEAD docs (with sor_document_id)
  freshCount: number;      // fresh tree docs (after the pageCount===0 skip)
  added: number[];         // docIds present in the fresh tree, absent in DB
  modified: number[];      // docIds in both whose last_modified/page_count changed
  removed: number[];       // docIds in DB (active), absent from the fresh tree
  removedRowIds: string[]; // removed head rows + resplit descendants (to soft-remove)
  folderChanged: boolean;  // a doc moved, or appeared under a folder path not seen before
}

// Decide how big this change is and therefore how to reconcile it:
//   noop        — nothing changed
//   incremental — fetch/analyze only new+changed docs, soft-remove vanished ones
//   full        — wipe + re-pull + re-analyze + re-synthesize
export function decideReconcileMode(diff: TreeDiff, t: ReconcileThresholds): ReconcileMode {
  if (!diff.isKnown) return "incremental"; // first real pull — wipe is meaningless
  const changed = diff.added.length + diff.modified.length + diff.removed.length;
  if (changed === 0) return "noop";
  if (t.fullOnFolderReorg && diff.folderChanged) return "full";
  if (
    diff.removed.length > 0 &&
    diff.storedCount > 0 &&
    diff.removed.length / diff.storedCount > t.fullMaxRemovedFraction
  ) {
    return "full";
  }
  if (diff.added.length >= t.fullMinAddedAbs) return "full";
  if (diff.storedCount > 0 && changed / diff.storedCount >= t.fullMinChangedFraction) return "full";
  return "incremental";
}
