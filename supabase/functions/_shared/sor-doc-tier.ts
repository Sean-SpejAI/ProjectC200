// Processing tier for an Sor document, decided from its type code.
//
// Sor returns many small documents per claim. Low-value administrative
// types — declarations, statements, routine correspondence/mail — get the
// 'light' tier: extraction only, with the expensive grounding (and gap-fill)
// passes skipped. Everything else — medical / BI / demand records (BIDO, PIPR,
// PIPB, PIPC, MATD, IME, POLDEM, BILLS, MED, …) — gets the 'full' pipeline.
//
// This is the single source of truth for the mapping; tune the set here.
// Stored on claim_documents.sor_processing_tier at pull time and read
// back by analyze-claim-document to branch the staged pipeline.

export type ProcessingTier = "full" | "light";

// Sor type codes (ObjType.Name) routed to the light tier.
export const LIGHT_TYPE_CODES = new Set<string>([
  "SG11", // Declarations
  "STAT", // Statement
  "CORR", // Correspondence
  "MAIL", // New Mail
]);

export function tierForType(typeCode: string | null | undefined): ProcessingTier {
  if (!typeCode) return "full";
  return LIGHT_TYPE_CODES.has(typeCode.toUpperCase().trim()) ? "light" : "full";
}
