import { describe, it, expect } from "vitest";
import { buildDocTree, displayDocName, type DocTreeInput } from "@/utils/docTree";

// A 595-page Sor doc fetched in 120-page parts, one of which was split
// again into 15-page chunks. With the superseded parents included, the whole
// hierarchy must collapse into ONE "PIP Records" page-collection node — the
// inner parts/chunks must NOT leak as separate rows.
function evansonPipr(): DocTreeInput[] {
  const manifest = [
    { n: 1, irPageId: 1, format: "PDF", rendered: true },
    { n: 130, irPageId: 130, format: "PDF", rendered: true }, // inside part 2's range
    { n: 151, irPageId: 151, format: "PDF", rendered: true }, // inside the re-split chunk
  ];
  return [
    { id: "head", sorDocumentId: 999, fileName: "PIP Records [#999].pdf",
      folderPath: [{ id: 7, name: "Insured" }], pages: manifest, processingStatus: "superseded" },
    { id: "p1", fileName: "PIP Records [#999] · part 1 of 5 (pp. 1-120).pdf",
      resplitOf: "head", pageStart: 1, pageEnd: 120, fileUrl: "sor/x/p1.pdf", processingStatus: "completed" },
    { id: "p2", fileName: "PIP Records [#999] · part 2 of 5 (pp. 121-240).pdf",
      resplitOf: "head", pageStart: 121, pageEnd: 240, fileUrl: "sor/x/p2.pdf", processingStatus: "superseded" },
    { id: "c1", fileName: "PIP Records [#999] · part 2 of 5 (pp. 121-240) · part 3 of 8 (pp. 151-165).pdf",
      resplitOf: "p2", pageStart: 151, pageEnd: 165, fileUrl: "sor/x/c1.pdf", processingStatus: "completed" },
  ];
}

describe("buildDocTree — multi-level resplit folding", () => {
  it("collapses head → parts → chunks into one document node", () => {
    const tree = buildDocTree(evansonPipr());
    expect(tree.folders).toHaveLength(1);
    const insured = tree.folders[0];
    expect(insured.name).toBe("Insured");
    expect(insured.docs).toHaveLength(1);          // only the head, no part/chunk rows
    const doc = insured.docs[0];
    expect(doc.key).toBe("ir:999");
    expect(doc.label).toBe("PIP Records");          // clean name, no "part N of M"
    expect(tree.looseDocs).toHaveLength(0);         // nothing leaked to the top level
  });

  it("resolves head pages to the covering part (incl. a re-split part's range)", () => {
    const doc = buildDocTree(evansonPipr()).folders[0].docs[0];
    const byN = Object.fromEntries(doc.pages.map((p) => [p.n, p]));
    expect(byN[1].docRowId).toBe("p1");
    expect(byN[130].docRowId).toBe("p2");           // p2 superseded but its PDF still opens
    expect(byN[151].docRowId).toBe("p2");           // page resolves to the part (chunk folded away)
  });
});

describe("nodeLabel — page-range labels for split slices", () => {
  it("labels a manual split chunk by its page range, not 'part N of M'", () => {
    const tree = buildDocTree([
      { id: "m1", fileName: "Demand Packet — part 2 of 3 (pp. 51-100).pdf",
        originalFileName: "Demand Packet.pdf", pageStart: 51, pageEnd: 100, fileUrl: "manual/x/m1.pdf", processingStatus: "completed" },
    ]);
    expect(tree.looseDocs[0].label).toBe("Demand Packet (pp. 51-100)");
  });

  it("labels an unnamed Sor doc by its type, not the sor-doc placeholder", () => {
    const tree = buildDocTree([
      { id: "h", sorDocumentId: 42, fileName: "sor-doc-42 [#42].pdf", documentType: "Report",
        folderPath: [{ id: 1, name: "Claim Information" }], pages: [], processingStatus: "completed" },
    ] as unknown as DocTreeInput[]);
    expect(tree.folders[0].docs[0].label).toBe("Report");
  });
});

describe("displayDocName", () => {
  it("keeps a real document name (strips [#id] + .pdf)", () => {
    expect(displayDocName("Declarations [#84624118].pdf")).toBe("Declarations");
  });
  it("falls back to the type when the name is the sor-doc placeholder", () => {
    expect(displayDocName("sor-doc-89863879 [#89863879].pdf", { documentType: "Report" })).toBe("Report");
  });
  it("strips split-suffixes before the placeholder check", () => {
    expect(
      displayDocName("sor-doc-999 [#999] · part 2 of 5 (pp. 121-240).pdf", { documentType: "PIP Records" }),
    ).toBe("PIP Records");
  });
  it("returns 'Document' for an empty name with no type", () => {
    expect(displayDocName(null)).toBe("Document");
  });
  it("keeps the placeholder when no type is available", () => {
    expect(displayDocName("sor-doc-5 [#5].pdf")).toBe("sor-doc-5");
  });
});
