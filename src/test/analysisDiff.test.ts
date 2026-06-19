import { describe, it, expect } from "vitest";
import { diffAnalysis, labelForPath } from "../../supabase/functions/_shared/analysis-diff.ts";

describe("labelForPath", () => {
  it("titleizes a nested camelCase path", () => {
    expect(labelForPath("headerInfo.demandAmount")).toBe("Header Info · Demand Amount");
  });
  it("renders 1-based array indices", () => {
    expect(labelForPath("medicalBillBreakdown[2].amountBilled")).toBe("Medical Bill Breakdown #3 · Amount Billed");
  });
});

describe("diffAnalysis", () => {
  it("captures a scalar change in a nested object", () => {
    const changes = diffAnalysis(
      { headerInfo: { demandAmount: null } },
      { headerInfo: { demandAmount: "$100,000" } },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ path: "headerInfo.demandAmount", old: null, new: "$100,000" });
    expect(changes[0].label).toBe("Header Info · Demand Amount");
  });

  it("treats null / undefined / empty-string as equal (no churn)", () => {
    expect(diffAnalysis({ a: null }, { a: "" })).toHaveLength(0);
    expect(diffAnalysis({ a: "  " }, {})).toHaveLength(0);
  });

  it("diffs array elements by index", () => {
    const changes = diffAnalysis(
      { bills: [{ amt: "100" }, { amt: "200" }] },
      { bills: [{ amt: "100" }, { amt: "250" }] },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe("bills[1].amt");
    expect(changes[0]).toMatchObject({ old: "200", new: "250" });
  });

  it("reports an added array element", () => {
    const changes = diffAnalysis({ tags: ["a"] }, { tags: ["a", "b"] });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ path: "tags[1]", old: undefined, new: "b" });
  });

  it("ignores internal (_-prefixed) keys and confidence scores", () => {
    const changes = diffAnalysis(
      { _provenance: { x: 1 }, confidence: 0.5, name: "A" },
      { _provenance: { x: 2 }, confidence: 0.9, name: "A" },
    );
    expect(changes).toHaveLength(0);
  });

  it("records a shape change (object -> string) as one leaf change", () => {
    const changes = diffAnalysis({ liability: { draft: "x" } }, { liability: "plain text" });
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe("liability");
  });

  it("diffs arrays of objects by identity — a middle removal does not cascade", () => {
    const bill = (p: string, amt: string) => ({ provider: p, date: "2024-01-01", amountBilled: amt });
    const changes = diffAnalysis(
      { medicalBillBreakdown: [bill("X", "10"), bill("Y", "20"), bill("Z", "30")] },
      { medicalBillBreakdown: [bill("X", "10"), bill("Z", "30")] }, // Y removed
    );
    expect(changes).toHaveLength(1); // only Y removed, no spurious X/Z shifts
    expect(changes[0].new).toBeUndefined();
    expect((changes[0].old as { provider: string }).provider).toBe("Y");
  });

  it("treats a pure array reorder of identical objects as no change", () => {
    const inj = (n: string) => ({ injury: n });
    expect(
      diffAnalysis({ diagnosedInjuries: [inj("neck"), inj("back")] }, { diagnosedInjuries: [inj("back"), inj("neck")] }),
    ).toHaveLength(0);
  });

  it("records a single edited field on a keyed object after a sibling row is removed", () => {
    const bill = (p: string, amt: string) => ({ provider: p, date: "2024-01-01", amountBilled: amt });
    const changes = diffAnalysis(
      { bills: [bill("X", "10"), bill("Y", "20")] },
      { bills: [bill("Y", "25")] }, // X removed AND Y.amountBilled edited
    );
    // X removed (1 whole-object change) + Y.amountBilled 20->25 (1 field change)
    const removed = changes.filter((c) => c.new === undefined);
    const edited = changes.filter((c) => c.path.endsWith(".amountBilled"));
    expect(removed).toHaveLength(1);
    expect((removed[0].old as { provider: string }).provider).toBe("X");
    expect(edited).toHaveLength(1);
    expect(edited[0]).toMatchObject({ old: "20", new: "25" });
  });

  it("does NOT emit a truncation marker at exactly the cap (no off-by-one)", () => {
    const mk = (n: number, val: string) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, val]));
    const changes = diffAnalysis(mk(300, "a"), mk(300, "b")); // exactly MAX_CHANGES
    expect(changes.some((c) => c.path === "__audit_truncated__")).toBe(false);
    expect(changes).toHaveLength(300);
  });

  it("emits a truncation marker only when changes exceed the cap", () => {
    const mk = (n: number, val: string) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, val]));
    const changes = diffAnalysis(mk(305, "a"), mk(305, "b"));
    expect(changes.some((c) => c.path === "__audit_truncated__")).toBe(true);
  });

  it("returns nothing for identical analyses", () => {
    const a = { headerInfo: { demandAmount: "$1", timeLimitDemand: null }, bills: [{ amt: "5" }] };
    expect(diffAnalysis(a, structuredClone(a))).toHaveLength(0);
  });
});
