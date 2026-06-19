// Shared display helpers for claim documents (used by the documents tree and
// the claim-details panel). Extracted from ClaimDetailsPanel so the tree can
// reuse the exact same labels/badges.

export function getDocumentTypeLabel(type: string | null | undefined): string {
  if (!type) return "Document";
  const labels: Record<string, string> = {
    medical_record: "Medical Record",
    receipt: "Receipt/Bill",
    police_report: "Police Report",
    photo: "Photo",
    other: "Other",
    user_upload: "Document",
    "imageright-import": "ImageRight Document",
  };
  return labels[type] || type;
}

export interface VerificationBadge {
  className: string;
  label: string;
}

export function getVerificationBadge(analysis: unknown): VerificationBadge | null {
  const status = (analysis as { correspondenceVerification?: { status?: string } } | null)
    ?.correspondenceVerification?.status;
  if (!status) return null;
  const configs: Record<string, VerificationBadge> = {
    verified: { className: "bg-success/15 text-success", label: "Verified" },
    needs_review: { className: "bg-warning/15 text-warning", label: "Review" },
    rejected: { className: "bg-destructive/15 text-destructive", label: "Issue" },
  };
  return configs[status] || null;
}
