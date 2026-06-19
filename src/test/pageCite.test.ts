import { describe, it, expect } from "vitest";
import { resolvePageCite, type CiteDoc } from "@/utils/pageCite";

const docs: CiteDoc[] = [
  { id: "d-sg11", fileName: "Declarations [#84624118].pdf", folderName: "Claim Information", pageStart: null },
  { id: "d-lor1", fileName: "LOR ACK [#86834946].pdf", folderName: "Correspondence", pageStart: null },
  { id: "d-lor2", fileName: "LOR ACK [#86834014].pdf", folderName: "Correspondence", pageStart: null },
  // a resplit slice of a 668-page POLDEM: internal pages 1.., original pages 101..
  { id: "d-poldem3", fileName: "11/15/2024 POLDEM - Policy Demand [#104828137] · part 3 of 3 (pp. 101-150).pdf", folderName: "Claimant", pageStart: 101 },
  { id: "d-manual", fileName: "uploaded-report.pdf", folderName: null, pageStart: null },
];

describe("resolvePageCite layered citations", () => {
  it("renders folder › document › page for an IR doc", () => {
    const r = resolvePageCite("Declarations [#84624118] p. 2", docs);
    expect(r.text).toBe("Claim Information › Declarations › p. 2");
    expect(r.documentId).toBe("d-sg11");
    expect(r.page).toBe(2);
  });

  it("disambiguates duplicate-named docs via [#id]", () => {
    const r = resolvePageCite("LOR ACK [#86834014] p. 1", docs);
    expect(r.documentId).toBe("d-lor2");
    expect(r.text).toBe("Correspondence › LOR ACK › p. 1");
  });

  it("maps a resplit slice to original page numbers + links to the slice page", () => {
    const r = resolvePageCite("11/15/2024 POLDEM - Policy Demand [#104828137] · part 3 of 3 (pp. 101-150) p. 5", docs);
    expect(r.documentId).toBe("d-poldem3");
    expect(r.page).toBe(5);              // slice-internal page for the link
    expect(r.text).toContain("Claimant ›");
    expect(r.text).toContain("p. 105");  // original-document page for display
    expect(r.text).not.toMatch(/part \d+ of \d+/); // no "part N of M" cruft
  });

  it("strips deeply-nested (part → part) split suffixes from the citation label", () => {
    const nested: CiteDoc[] = [
      { id: "ch", folderName: "Insured", pageStart: 256,
        fileName: "PIP Records [#999] · part 3 of 5 (pp. 241-360) · part 2 of 8 (pp. 256-270).pdf" },
    ];
    const r = resolvePageCite(
      "PIP Records [#999] · part 3 of 5 (pp. 241-360) · part 2 of 8 (pp. 256-270) p. 1",
      nested,
    );
    expect(r.documentId).toBe("ch");
    expect(r.text).toBe("Insured › PIP Records › p. 256");
  });

  it("falls back gracefully for a manual doc without a folder", () => {
    const r = resolvePageCite("uploaded-report p. 3", docs);
    expect(r.documentId).toBe("d-manual");
    expect(r.text).toBe("uploaded-report › p. 3");
  });

  it("renders a comma-separated multi-page list and links to the first page", () => {
    const multi: CiteDoc[] = [
      { id: "d", folderName: "Insured", documentType: "Report", pageStart: 1,
        fileName: "ir-doc-89559592 [#89559592] · part 1 of 3 (pp. 1-120).pdf" },
    ];
    const r = resolvePageCite(
      "ir-doc-89559592 [#89559592] · part 1 of 3 pp. 1-120.pdf pp. 1, 76, 78",
      multi,
    );
    expect(r.documentId).toBe("d");
    expect(r.page).toBe(1);                          // link to the FIRST cited page
    expect(r.text).toBe("Insured › Report › pp. 1, 76, 78");
    expect(r.text).not.toMatch(/part \d+ of \d+/);   // no split cruft
    expect(r.text).not.toContain("ir-doc-");         // placeholder → type label
  });

  it("falls back to the document type when the file name is the ir-doc placeholder", () => {
    const placeholder: CiteDoc[] = [
      { id: "x", folderName: "Claim Information", documentType: "Report", pageStart: null,
        fileName: "ir-doc-89863879 [#89863879].pdf" },
    ];
    const r = resolvePageCite("ir-doc-89863879 [#89863879].pdf p. 4", placeholder);
    expect(r.documentId).toBe("x");
    expect(r.text).toBe("Claim Information › Report › p. 4");
    expect(r.page).toBe(4);
  });
});
