import {
  Document,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
  WidthType,
  Packer,
} from "docx";
import { resolvePageCite, type CiteDoc } from "@/utils/pageCite";

// Normalize a pageRef/pageRefs value for display. Synthesis stores the
// canonical "<file_name> p. N" form, but older/raw values may be a bare page
// number ("2", "2-3") or a stray "(p. N)" wrapper. Returns the inner citation
// text WITHOUT outer parens; callers add their own surrounding decoration.
// This prevents the "(p. <ref> (p. 2))" double-wrap regression.
export const fmtPageRef = (v?: string | null): string => {
  if (!v) return "";
  // collapse a redundant inner "(p. N)" / "(pp. N-M)" into "p. N"
  let s = String(v).replace(/\((pp?\.\s*[^)]*)\)/gi, "$1").replace(/\s{2,}/g, " ").trim();
  if (!s) return "";
  // bare page number(s) → add the "p." label so it reads as a page citation
  if (/^\d+(\s*[-–]\s*\d+)?$/.test(s)) return `p. ${s}`;
  return s; // already "<file_name> p. N" or other descriptive ref
};

// Helper function to download blob as file
const downloadBlob = (blob: Blob, fileName: string): void => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

interface DemandReviewAnalysis {
  summary: string;
  headerInfo?: {
    claimNumber?: string;
    dateCompleted?: string;
    completedBy?: string;
    namedobGender?: string;
    seatbelt?: string;
    accidentLocation?: string;
    dateOfAccident?: string;
    accidentType?: string;
    attorneyRepresented?: string;
    timeLimitDemand?: string;
    demandAmount?: string;
  };
  diagnosedInjuries?: Array<{ injury: string; scarringNoted?: boolean; pageRef?: string }>;
  priorInjuries?: string;
  treatmentRecap?: {
    narrative?: string;
    providers?: string[];
    providerDetails?: Array<{
      name?: string;
      specialty?: string;
      dateRange?: string;
      visits?: string;
      treatmentsProvided?: string[];
      pageRefs?: string;
    }>;
    imagingResults?: Array<{
      type?: string;
      bodyPart?: string;
      date?: string;
      findings?: string;
      pageRef?: string;
    }>;
    prognosisAssessment?: {
      prognosis?: string;
      impairmentRating?: string;
      futureExpenses?: string;
      pageRef?: string;
    };
    totalVisits?: string;
    surgery?: boolean;
    surgeryDetails?: string;
    injections?: boolean;
    injectionsDetails?: string;
    imaging?: string[];
    pageRefs?: string;
  };
  impactToLife?: string;
  claimedWageLoss?: string;
  medicalBillBreakdown?: Array<{
    date?: string;
    provider?: string;
    complaintsOrDiagnosis?: string;
    type?: string;
    amountBilled?: string;
    healthInsurancePaid?: string;
    pageRef?: string;
  }>;
  postAccidentRecap?: Array<{ provider: string; summary: string; cptCodes?: string[]; pageRefs?: string }>;
  preAccidentRecap?: Array<{ provider: string; summary: string; cptCodes?: string[]; pageRefs?: string }>;
  adjusterPortion?: {
    factsOfLoss?: string;
    liability?: string;
    increasingFactors?: string;
    generals?: string;
    wageLoss?: string;
    medicalBillsLiens?: string;
    futures?: string;
    reductions?: string;
    totalRange?: string;
    currentReserves?: string;
    reservesOk?: string;
    policyLimits?: string;
  };
  verification?: {
    status: string;
    dateAlignment?: string;
    nameMatch?: string;
    injuryConsistency?: string;
    costReasonableness?: string;
    notes?: string;
  };
  flags?: string[];
  recommendedActions?: string[];
  confidenceScore?: number;
}

const createHeaderField = (label: string, value: string | undefined): Paragraph => {
  return new Paragraph({
    children: [
      new TextRun({ text: `${label}: `, bold: true }),
      new TextRun({ text: value || "N/A" }),
    ],
    spacing: { after: 100 },
  });
};

const createSectionHeading = (text: string): Paragraph => {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 300, after: 150 },
  });
};

const createTableCell = (text: string, isHeader = false): TableCell => {
  return new TableCell({
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text: text || "-",
            bold: isHeader,
            size: isHeader ? 20 : 18,
          }),
        ],
        alignment: AlignmentType.LEFT,
      }),
    ],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 1 },
      bottom: { style: BorderStyle.SINGLE, size: 1 },
      left: { style: BorderStyle.SINGLE, size: 1 },
      right: { style: BorderStyle.SINGLE, size: 1 },
    },
  });
};

const NOT_TRANSFERRED = "Did not transfer from Document Analysis";

export const generateDemandReviewDocument = async (
  analysis: DemandReviewAnalysis,
  claimNumber: string,
  documents: CiteDoc[] = []
): Promise<void> => {
  const headerInfo = analysis.headerInfo || {};
  
  const sections: Paragraph[] = [];

  // Title
  sections.push(
    new Paragraph({
      text: "INJURY/TREATMENT SUMMARY",
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
      spacing: { after: 300 },
    })
  );

  // Summary
  if (analysis.summary) {
    sections.push(
      new Paragraph({
        text: analysis.summary,
        spacing: { after: 200 },
      })
    );
  }

  // Completed By with full disclaimer
  const completedByText = headerInfo.completedBy === "AI Analysis" || !headerInfo.completedBy
    ? "AI Analysis & Adjuster (All determinations regarding the value, reasonableness, and relatedness of medical bills and treatment are made solely by the adjuster. These considerations remain the responsibility of the adjuster and are not determined by the AI analysis tool)."
    : headerInfo.completedBy;

  // Header Information
  sections.push(createHeaderField("Claim Number", headerInfo.claimNumber || claimNumber));
  sections.push(createHeaderField("Date Completed", headerInfo.dateCompleted || new Date().toLocaleDateString()));
  sections.push(createHeaderField("Completed By", completedByText));
  sections.push(createHeaderField("Name/DOB/Gender", headerInfo.namedobGender));
  sections.push(createHeaderField("Seatbelt", headerInfo.seatbelt));
  sections.push(createHeaderField("Accident Location", headerInfo.accidentLocation));
  sections.push(createHeaderField("Date of Accident", headerInfo.dateOfAccident));
  sections.push(createHeaderField("Accident Type", headerInfo.accidentType));
  sections.push(createHeaderField("Attorney Represented", headerInfo.attorneyRepresented));
  sections.push(createHeaderField("Time Limit Demand", headerInfo.timeLimitDemand));
  sections.push(createHeaderField("Demand Amount", headerInfo.demandAmount));

  // Adjuster Portion Section
  sections.push(createSectionHeading("ADJUSTER PORTION: (Adjuster to complete)"));
  
  const adjuster = analysis.adjusterPortion || {};
  
  // Facts of Loss
  sections.push(
    new Paragraph({
      children: [new TextRun({ text: "FACTS OF LOSS:", bold: true })],
      spacing: { before: 150, after: 50 },
    })
  );
  sections.push(
    new Paragraph({
      text: adjuster.factsOfLoss || "Click or tap here to enter text.",
      spacing: { after: 100 },
    })
  );
  
  // Liability
  sections.push(
    new Paragraph({
      children: [new TextRun({ text: "LIABILITY:", bold: true })],
      spacing: { before: 150, after: 50 },
    })
  );
  sections.push(
    new Paragraph({
      text: adjuster.liability || "Click or tap here to enter text.",
      spacing: { after: 100 },
    })
  );
  
  // Current Range of Value
  sections.push(
    new Paragraph({
      children: [new TextRun({ text: "CURRENT RANGE OF VALUE", bold: true, size: 24 })],
      spacing: { before: 200, after: 100 },
    })
  );
  
  const rangeItems = [
    { label: "INCREASING FACTORS:", value: adjuster.increasingFactors },
    { label: "GENERALS:", value: adjuster.generals },
    { label: "WAGE LOSS:", value: adjuster.wageLoss },
    { label: "MEDICAL BILLS/LIENS:", value: adjuster.medicalBillsLiens },
    { label: "FUTURES (MEDICAL BILLS/GENERALS):", value: adjuster.futures },
    { label: "REDUCTIONS (COMP/NEG RANGE, OFFSETS):", value: adjuster.reductions },
    { label: "TOTAL RANGE:", value: adjuster.totalRange },
    { label: "CURRENT RESERVES:", value: adjuster.currentReserves },
    { label: "RESERVES OK?", value: adjuster.reservesOk },
    { label: "POLICY LIMITS:", value: adjuster.policyLimits },
  ];
  
  rangeItems.forEach((item) => {
    sections.push(
      new Paragraph({
        children: [
          new TextRun({ text: "• " }),
          new TextRun({ text: `${item.label} `, bold: true }),
          new TextRun({ text: item.value || "Click or tap here to enter text." }),
        ],
        spacing: { after: 50 },
        indent: { left: 360 },
      })
    );
  });

  // Diagnosed Injuries Section
  sections.push(createSectionHeading("DIAGNOSED INJURIES & INJURY COMPLAINTS:"));
  sections.push(
    new Paragraph({
      children: [
        new TextRun({ text: "Claiming ", color: "FF0000", bold: true }),
        new TextRun({ text: "(As claimed in Demand Letter)", italics: true }),
      ],
      spacing: { after: 100 },
    })
  );
  sections.push(
    new Paragraph({
      children: [new TextRun({ text: "(List each individual injury, scarring noted?)", italics: true })],
      spacing: { after: 100 },
    })
  );

  if (analysis.diagnosedInjuries && analysis.diagnosedInjuries.length > 0) {
    analysis.diagnosedInjuries.forEach((injury, index) => {
      const scarring = injury.scarringNoted ? " (Scarring Noted)" : "";
      // Show the ORIGINAL-document page (slice page_start applied) to match the portal.
      const ref = resolvePageCite(injury.pageRef, documents).text;
      const pageRef = ref ? ` (${ref})` : "";
      sections.push(
        new Paragraph({
          text: `${index + 1}. ${injury.injury}${scarring}${pageRef}`,
          spacing: { after: 50 },
        })
      );
    });
  } else {
    sections.push(new Paragraph({ text: "No diagnosed injuries documented." }));
  }

  // Prior Injuries Section
  sections.push(createSectionHeading("PRIOR INJURIES:"));
  sections.push(
    new Paragraph({
      text: analysis.priorInjuries || "No prior injuries documented.",
      spacing: { after: 100 },
    })
  );

  // Brief Treatment Recap Section
  sections.push(createSectionHeading("BRIEF TREATMENT RECAP:"));
  sections.push(
    new Paragraph({
      children: [new TextRun({ text: "(Type of providers, number of visits, surgery?, injections?, Imaging?)", italics: true })],
      spacing: { after: 100 },
    })
  );

  if (analysis.treatmentRecap) {
    const recap = analysis.treatmentRecap;
    const details: string[] = [];
    
    if (recap.providers?.length) {
      details.push(`Providers: ${recap.providers.join(", ")}`);
    }
    if (recap.totalVisits) {
      details.push(`Total Visits: ${recap.totalVisits}`);
    }
    details.push(`Surgery: ${recap.surgery ? (recap.surgeryDetails ? `Yes - ${recap.surgeryDetails}` : "Yes") : "No"}`);
    details.push(`Injections: ${recap.injections ? (recap.injectionsDetails ? `Yes - ${recap.injectionsDetails}` : "Yes") : "No"}`);
    if (recap.imaging?.length) {
      details.push(`Imaging: ${recap.imaging.join(", ")}`);
    }
    
    if (recap.narrative) {
      sections.push(new Paragraph({ text: recap.narrative, spacing: { after: 100 } }));
    }
    
    details.forEach((detail) => {
      sections.push(new Paragraph({ text: `• ${detail}`, spacing: { after: 50 } }));
    });
    
    if (recap.pageRefs) {
      sections.push(
        new Paragraph({
          children: [new TextRun({ text: `Reference: ${recap.pageRefs}`, italics: true })],
          spacing: { after: 100 },
        })
      );
    }
  } else {
    sections.push(new Paragraph({ text: "No treatment information documented." }));
  }

  // Treatment Recap by Provider Section
  sections.push(createSectionHeading("TREATMENT RECAP BY PROVIDER:"));
  const providerDetails = analysis.treatmentRecap?.providerDetails;
  if (providerDetails && providerDetails.length > 0) {
    providerDetails.forEach((provider) => {
      sections.push(
        new Paragraph({
          children: [
            new TextRun({ text: provider.name || "Unknown Provider", bold: true }),
            provider.specialty ? new TextRun({ text: ` (${provider.specialty})`, italics: true }) : new TextRun({ text: "" }),
          ],
          spacing: { before: 150, after: 50 },
        })
      );
      if (provider.dateRange) {
        sections.push(new Paragraph({ text: `• Date Range: ${provider.dateRange}`, spacing: { after: 30 }, indent: { left: 360 } }));
      }
      if (provider.visits) {
        sections.push(new Paragraph({ text: `• Visits: ${provider.visits}`, spacing: { after: 30 }, indent: { left: 360 } }));
      }
      if (provider.treatmentsProvided && provider.treatmentsProvided.length > 0) {
        sections.push(new Paragraph({ text: `• Treatments: ${provider.treatmentsProvided.join(", ")}`, spacing: { after: 30 }, indent: { left: 360 } }));
      }
      if (provider.pageRefs) {
        sections.push(
          new Paragraph({
            children: [new TextRun({ text: `• Pages: ${provider.pageRefs}`, italics: true })],
            spacing: { after: 50 },
            indent: { left: 360 },
          })
        );
      }
    });
  } else {
    sections.push(new Paragraph({ text: NOT_TRANSFERRED, spacing: { after: 100 } }));
  }

  // Imaging Results Section
  sections.push(createSectionHeading("IMAGE RESULTS:"));
  const imagingResults = analysis.treatmentRecap?.imagingResults;
  if (imagingResults && imagingResults.length > 0) {
    imagingResults.forEach((img) => {
      const parts: string[] = [];
      if (img.type) parts.push(img.type);
      if (img.bodyPart) parts.push(img.bodyPart);
      if (img.date) parts.push(img.date);
      
      sections.push(
        new Paragraph({
          children: [
            new TextRun({ text: parts.join(" - ") || "Imaging Study", bold: true }),
          ],
          spacing: { before: 100, after: 30 },
        })
      );
      if (img.findings) {
        sections.push(new Paragraph({ text: `Findings: ${img.findings}`, spacing: { after: 30 }, indent: { left: 360 } }));
      }
      if (img.pageRef) {
        sections.push(
          new Paragraph({
            children: [new TextRun({ text: `Page: ${img.pageRef}`, italics: true })],
            spacing: { after: 50 },
            indent: { left: 360 },
          })
        );
      }
    });
  } else {
    sections.push(new Paragraph({ text: NOT_TRANSFERRED, spacing: { after: 100 } }));
  }

  // Prognosis/Assessment Section
  sections.push(createSectionHeading("PROGNOSIS/ASSESSMENT:"));
  const prognosis = analysis.treatmentRecap?.prognosisAssessment;
  if (prognosis && (prognosis.prognosis || prognosis.impairmentRating || prognosis.futureExpenses)) {
    if (prognosis.prognosis) {
      sections.push(new Paragraph({ text: prognosis.prognosis, spacing: { after: 50 } }));
    }
    if (prognosis.impairmentRating) {
      sections.push(new Paragraph({ text: `• Impairment Rating: ${prognosis.impairmentRating}`, spacing: { after: 30 }, indent: { left: 360 } }));
    }
    if (prognosis.futureExpenses) {
      sections.push(new Paragraph({ text: `• Future Expenses: ${prognosis.futureExpenses}`, spacing: { after: 30 }, indent: { left: 360 } }));
    }
    if (prognosis.pageRef) {
      sections.push(
        new Paragraph({
          children: [new TextRun({ text: `Page: ${prognosis.pageRef}`, italics: true })],
          spacing: { after: 50 },
          indent: { left: 360 },
        })
      );
    }
  } else {
    sections.push(new Paragraph({ text: NOT_TRANSFERRED, spacing: { after: 100 } }));
  }

  // Impact to Life Section
  sections.push(createSectionHeading("IMPACT TO LIFE/AVERAGE DAILY ACTIVITIES:"));
  sections.push(
    new Paragraph({
      children: [new TextRun({ text: "(As mentioned in Demand Letter and Medical Records)", italics: true })],
      spacing: { after: 100 },
    })
  );
  if (analysis.impactToLife) {
    sections.push(
      new Paragraph({
        children: [
          new TextRun({ text: "Claiming ", color: "FF0000", bold: true }),
          new TextRun({ text: analysis.impactToLife }),
        ],
        spacing: { after: 100 },
      })
    );
  } else {
    sections.push(
      new Paragraph({
        text: "No impact to life information documented.",
        spacing: { after: 100 },
      })
    );
  }

  // Claimed Wage Loss Section
  sections.push(createSectionHeading("CLAIMED WAGE LOSS:"));
  sections.push(
    new Paragraph({
      text: analysis.claimedWageLoss || "No wage loss information documented.",
      spacing: { after: 100 },
    })
  );

  // Medical Bill Breakdown Table
  sections.push(createSectionHeading("MEDICAL BILL BREAKDOWN:"));
  sections.push(
    new Paragraph({
      children: [new TextRun({ text: "(By provider, breakdown of diagnostic testing)", italics: true })],
      spacing: { after: 100 },
    })
  );

  // Helper to sanitize diagnosis text
  const sanitizeDiagnosis = (text: string | undefined): string => {
    if (!text) return '-';
    return text
      .replace(/all injuries related to mva/gi, '')
      .replace(/injuries related to mva/gi, '')
      .replace(/related to mva/gi, '')
      .replace(/all injuries related to accident/gi, '')
      .replace(/^\s*[,;]\s*/, '')
      .replace(/\s*[,;]\s*$/, '')
      .trim() || '-';
  };

  // Helper to classify non-medical
  const isNonMedicalBill = (bill: { provider?: string; type?: string; complaintsOrDiagnosis?: string }) => {
    const text = `${bill.provider || ''} ${bill.type || ''} ${bill.complaintsOrDiagnosis || ''}`.toLowerCase();
    return ['transportation', 'mileage', 'travel', 'parking', 'lodging', 'uber', 'lyft', 'taxi', 'gas'].some(kw => text.includes(kw));
  };

  const parseAmount = (val: string | undefined): number => {
    if (!val) return 0;
    const num = parseFloat(val.replace(/[^0-9.-]/g, ''));
    return isNaN(num) ? 0 : num;
  };
  const formatCurrency = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const allBills = analysis.medicalBillBreakdown || [];
  const medBills = allBills.filter(b => !isNonMedicalBill(b));
  const nonMedBills = allBills.filter(b => isNonMedicalBill(b));

  const createBillTableHeader = (): TableRow => new TableRow({
    children: [
      createTableCell("Date", true),
      createTableCell("Provider", true),
      createTableCell("Complaints, TX, Diagnosis", true),
      createTableCell("Type", true),
      createTableCell("Amount Billed", true),
      createTableCell("Health Ins Pay?", true),
      createTableCell("Page Ref", true),
    ],
  });

  const createBoldHighlightCell = (text: string): TableCell => new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text, bold: true, size: 18 })] })],
    shading: { fill: "FFE0E0" },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 1 },
      bottom: { style: BorderStyle.SINGLE, size: 1 },
      left: { style: BorderStyle.SINGLE, size: 1 },
      right: { style: BorderStyle.SINGLE, size: 1 },
    },
  });

  const createEmptyHighlightCell = (): TableCell => new TableCell({
    children: [new Paragraph({ text: "" })],
    shading: { fill: "FFE0E0" },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 1 },
      bottom: { style: BorderStyle.SINGLE, size: 1 },
      left: { style: BorderStyle.SINGLE, size: 1 },
      right: { style: BorderStyle.SINGLE, size: 1 },
    },
  });

  const buildBillSection = (bills: typeof allBills, label: string): (Paragraph | Table)[] => {
    const result: (Paragraph | Table)[] = [];
    if (bills.length === 0) return result;

    result.push(new Paragraph({
      children: [new TextRun({ text: label, bold: true, size: 22 })],
      spacing: { before: 200, after: 100 },
    }));

    const rows: TableRow[] = [createBillTableHeader()];

    // Group by provider
    const providerOrder: string[] = [];
    const providerGroups: Record<string, typeof bills> = {};
    bills.forEach(b => {
      const key = b.provider || 'Unknown';
      if (!providerGroups[key]) { providerGroups[key] = []; providerOrder.push(key); }
      providerGroups[key].push(b);
    });

    providerOrder.forEach(prov => {
      const group = providerGroups[prov];
      group.forEach(bill => {
        rows.push(new TableRow({
          children: [
            createTableCell(bill.date || "-"),
            createTableCell(bill.provider || "-"),
            createTableCell(sanitizeDiagnosis(bill.complaintsOrDiagnosis)),
            createTableCell(bill.type || "-"),
            createTableCell(bill.amountBilled || "-"),
            createTableCell(bill.healthInsurancePaid || "-"),
            createTableCell(bill.pageRef ? fmtPageRef(bill.pageRef) : "-"),
          ],
        }));
      });

      // Provider subtotal
      if (group.length > 1) {
        const provTotal = group.reduce((s, b) => s + parseAmount(b.amountBilled), 0);
        rows.push(new TableRow({
          children: [
            createEmptyHighlightCell(),
            createEmptyHighlightCell(),
            createEmptyHighlightCell(),
            createBoldHighlightCell(`${prov} Total:`),
            createBoldHighlightCell(formatCurrency(provTotal)),
            createEmptyHighlightCell(),
            createEmptyHighlightCell(),
          ],
        }));
      }
    });

    // Grand total
    const grandTotal = bills.reduce((s, b) => s + parseAmount(b.amountBilled), 0);
    rows.push(new TableRow({
      children: [
        createEmptyHighlightCell(),
        createEmptyHighlightCell(),
        createEmptyHighlightCell(),
        createBoldHighlightCell("GRAND TOTAL:"),
        createBoldHighlightCell(formatCurrency(grandTotal)),
        createEmptyHighlightCell(),
        createEmptyHighlightCell(),
      ],
    }));

    result.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    return result;
  };

  const medicalTableSection = buildBillSection(medBills, "Medical Expenses");
  const nonMedicalTableSection = buildBillSection(nonMedBills, "Non-Medical Expenses");

  // Fallback empty table if no bills at all
  const tableRows: TableRow[] = [createBillTableHeader()];
  if (allBills.length === 0) {
    tableRows.push(new TableRow({
      children: [
        createTableCell("-"), createTableCell("-"), createTableCell("-"),
        createTableCell("-"), createTableCell("-"), createTableCell("-"), createTableCell("-"),
      ],
    }));
  }
  const table = allBills.length === 0 
    ? new Table({ rows: tableRows, width: { size: 100, type: WidthType.PERCENTAGE } })
    : null;

  // Post Accident Recap Section
  const postAccidentSection: Paragraph[] = [createSectionHeading("POST ACCIDENT MEDICAL RECORD RECAP BY PROVIDER:")];
  
  if (analysis.postAccidentRecap && analysis.postAccidentRecap.length > 0) {
    analysis.postAccidentRecap.forEach((record) => {
      postAccidentSection.push(
        new Paragraph({
          children: [
            new TextRun({ text: record.provider, bold: true }),
            new TextRun({ text: fmtPageRef(record.pageRefs) ? ` (${fmtPageRef(record.pageRefs)})` : "", italics: true }),
          ],
          spacing: { before: 150, after: 50 },
        })
      );
      postAccidentSection.push(
        new Paragraph({
          text: record.summary,
          spacing: { after: 100 },
        })
      );
    });
  } else {
    postAccidentSection.push(new Paragraph({ text: "No post-accident records documented." }));
  }

  // Pre Accident Recap Section
  const preAccidentSection: Paragraph[] = [createSectionHeading("PRE-ACCIDENT MEDICAL RECORD RECAP BY PROVIDER:")];
  
  if (analysis.preAccidentRecap && analysis.preAccidentRecap.length > 0) {
    analysis.preAccidentRecap.forEach((record) => {
      preAccidentSection.push(
        new Paragraph({
          children: [
            new TextRun({ text: record.provider, bold: true }),
            new TextRun({ text: fmtPageRef(record.pageRefs) ? ` (${fmtPageRef(record.pageRefs)})` : "", italics: true }),
          ],
          spacing: { before: 150, after: 50 },
        })
      );
      preAccidentSection.push(
        new Paragraph({
          text: record.summary,
          spacing: { after: 100 },
        })
      );
    });
  } else {
    preAccidentSection.push(new Paragraph({ text: "No pre-accident records documented." }));
  }

  // Flags and Recommendations
  const flagsSection: Paragraph[] = [];
  
  if (analysis.flags && analysis.flags.length > 0) {
    flagsSection.push(createSectionHeading("ADDITIONAL REVIEW NOTES:"));
    analysis.flags.forEach((flag) => {
      flagsSection.push(
        new Paragraph({
          text: `→ ${flag}`,
          spacing: { after: 50 },
        })
      );
    });
  }

  if (analysis.recommendedActions && analysis.recommendedActions.length > 0) {
    flagsSection.push(createSectionHeading("RECOMMENDED ACTIONS:"));
    analysis.recommendedActions.forEach((action) => {
      flagsSection.push(
        new Paragraph({
          text: `→ ${action}`,
          spacing: { after: 50 },
        })
      );
    });
  }

  // Confidence Score
  if (analysis.confidenceScore !== undefined) {
    flagsSection.push(
      new Paragraph({
        children: [
          new TextRun({ text: "\nAnalysis Confidence Score: ", bold: true }),
          new TextRun({ text: `${Math.round(analysis.confidenceScore * 100)}%` }),
        ],
        spacing: { before: 200 },
      })
    );
  }

  // Create document
  const billChildren: (Paragraph | Table)[] = [];
  if (table) {
    billChildren.push(table);
  } else {
    billChildren.push(...medicalTableSection, ...nonMedicalTableSection);
  }

  const doc = new Document({
    sections: [
      {
        children: [
          ...sections,
          ...billChildren,
          ...postAccidentSection,
          ...preAccidentSection,
          ...flagsSection,
        ],
      },
    ],
  });

  // Generate and download
  const blob = await Packer.toBlob(doc);
  const fileName = `Demand_Review_${claimNumber}_${new Date().toISOString().split("T")[0]}.docx`;
  downloadBlob(blob, fileName);
};
