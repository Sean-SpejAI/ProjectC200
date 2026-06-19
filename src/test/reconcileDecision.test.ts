import { describe, it, expect } from "vitest";
import {
  decideReconcileMode,
  DEFAULT_RECONCILE_THRESHOLDS,
  type TreeDiff,
} from "../../supabase/functions/_shared/reconcile-decision.ts";

// Build a TreeDiff for a known 100-doc claim with nothing changed; override bits.
function diff(p: Partial<TreeDiff>): TreeDiff {
  return {
    isKnown: true,
    storedCount: 100,
    freshCount: 100,
    added: [],
    modified: [],
    removed: [],
    removedRowIds: [],
    folderChanged: false,
    ...p,
  };
}
const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("decideReconcileMode", () => {
  const T = DEFAULT_RECONCILE_THRESHOLDS;

  it("first pull (unknown claim) → incremental", () => {
    expect(decideReconcileMode(diff({ isKnown: false, storedCount: 0, added: ids(3) }), T)).toBe("incremental");
  });

  it("no change → noop", () => {
    expect(decideReconcileMode(diff({}), T)).toBe("noop");
  });

  it("a few new docs → incremental", () => {
    expect(decideReconcileMode(diff({ added: ids(3) }), T)).toBe("incremental");
  });

  it("a single modified doc → incremental", () => {
    expect(decideReconcileMode(diff({ modified: ids(1) }), T)).toBe("incremental");
  });

  it("a folder reorganization → full", () => {
    expect(decideReconcileMode(diff({ modified: ids(1), folderChanged: true }), T)).toBe("full");
  });

  it("removals beyond the max-removed fraction (>10%) → full", () => {
    expect(decideReconcileMode(diff({ removed: ids(20) }), T)).toBe("full"); // 20/100
  });

  it("a single removal within the fraction → incremental", () => {
    expect(decideReconcileMode(diff({ removed: ids(1) }), T)).toBe("incremental"); // 1/100
  });

  it("≥50 new docs → full", () => {
    expect(decideReconcileMode(diff({ added: ids(50) }), T)).toBe("full");
  });

  it("≥40% churn → full", () => {
    expect(decideReconcileMode(diff({ modified: ids(40) }), T)).toBe("full"); // 40/100
  });

  it("respects custom thresholds (folder reorg ignored when disabled)", () => {
    const lenient = { ...T, fullOnFolderReorg: false };
    expect(decideReconcileMode(diff({ modified: ids(1), folderChanged: true }), lenient)).toBe("incremental");
  });
});
