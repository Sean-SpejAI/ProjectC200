// Shared types for analyze-claim-document edge function

export interface AnalyzeRequest {
  documentId?: string;
  async?: boolean;
  documentContent?: string;
  documentType?: string;
  fileName?: string;
  mimeType?: string;
  fileBase64?: string;
  fileUrl?: string;
  storagePath?: string;
  claimDetails?: ClaimDetails;
}

export interface ClaimDetails {
  claimNumber: string;
  claimType: string;
  incidentDate: string;
  incidentDescription: string;
  claimantName: string;
  accidentLocation?: string;
}

export interface JobProgress {
  jobId: string;
  supabase: any;
}

// Document classification types for semantic understanding
export type DocumentSectionType = 
  | 'legal_demand_letter'
  | 'attorney_summary'
  | 'hospital_facesheet'
  | 'hospital_er_record'
  | 'physician_notes'
  | 'operative_report'
  | 'radiology_report'
  | 'physical_therapy'
  | 'medical_bills'
  | 'police_report'
  | 'pharmacy_records'
  | 'employment_records'
  | 'unknown';

export interface DocumentSection {
  pageRange: string;
  type: DocumentSectionType;
  description: string;
  provider?: string;
  keyDataFound?: string[];
}

export interface DocumentStructure {
  totalPages: number;
  sections: DocumentSection[];
}

export interface ExtractedIdentifier {
  value: string;
  source: string;
  pageRef: string;
  confidence: number;
  variations?: string[];
}

export interface ExtractedIdentifiers {
  claimNumber?: ExtractedIdentifier;
  claimantName?: ExtractedIdentifier;
  dateOfBirth?: ExtractedIdentifier;
  gender?: ExtractedIdentifier;
  dateOfLoss?: ExtractedIdentifier;
}

export interface CrossDocumentValidation {
  nameConsistency: 'verified' | 'discrepancy';
  dobConsistency: 'verified' | 'discrepancy';
  dateOfLossAlignment: 'verified' | 'discrepancy';
  discrepancies: string[];
}

export interface SemanticAnalysisResult {
  summary: string;
  documentStructure?: DocumentStructure;
  extractedIdentifiers?: ExtractedIdentifiers;
  crossDocumentValidation?: CrossDocumentValidation;
  // Legacy fields for backward compatibility
  extractedClaimNumber?: string;
  extractedClaimantName?: string;
  extractedDateOfBirth?: string;
  extractedGender?: string;
  extractedClaimType?: string;
  headerInfo?: Record<string, any>;
  [key: string]: any;
}

export const ERROR_CODES = {
  TIMEOUT: 'TIMEOUT',
  GEMINI_503: 'GEMINI_503',
  GEMINI_RATE_LIMIT: 'GEMINI_RATE_LIMIT',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  INVALID_FILE: 'INVALID_FILE',
  AI_CREDITS_EXHAUSTED: 'AI_CREDITS_EXHAUSTED',
  PARSE_ERROR: 'PARSE_ERROR',
} as const;

// File size constants
export const MAX_FILE_SIZE = 300 * 1024 * 1024; // 300MB
// Any PDF over this threshold routes through GCS → Vertex fileData (gs://) instead
// of inline base64. Set deliberately low so a 250 MB PDF can never inline-embed
// (which would balloon to ~333 MB base64 + JSON envelope — well over worker heap).
export const GEMINI_FILE_API_THRESHOLD = 5 * 1024 * 1024; // 5MB
export const PRO_MODEL_THRESHOLD = 50 * 1024 * 1024; // 50MB
export const STREAMING_THRESHOLD = 40 * 1024 * 1024; // 40MB
// Hard cap on what Vertex AI Gemini will accept via gs:// fileData (docs say 2 GB).
// We pick 300 MB to match MAX_FILE_SIZE and leave headroom above the 250 MB client docs.
export const GEMINI_PDF_INFERENCE_LIMIT = 300 * 1024 * 1024; // 300MB

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
  'X-Content-Type-Options': 'nosniff',
};
