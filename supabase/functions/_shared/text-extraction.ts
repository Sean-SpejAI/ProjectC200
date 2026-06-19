// Text Extraction and Persistence for Multi-Pass Extraction Pipeline
// Captures document structure and stores to database for auditability and targeted extraction

import { log } from './utils.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface ExtractedPage {
  page: number;
  text: string;
  wordCount: number;
  documentType?: string; // e.g., "medical_record", "bill", "correspondence"
}

export interface DocumentSection {
  pages: number[];
  text: string;
  keywords: string[];
}

export interface ExtractedTextStructure {
  extractedAt: string;
  totalPages: number;
  pages: ExtractedPage[];
  sections: {
    providers?: DocumentSection;
    imaging?: DocumentSection;
    bills?: DocumentSection;
    correspondence?: DocumentSection;
  };
}

/**
 * Extract and persist structured text from AI analysis
 *
 * NOTE: This is a simplified implementation that works with the current architecture.
 * Future enhancement: Add direct PDF text extraction library (e.g., pdf-parse for Deno)
 *
 * Current approach: Capture the full AI response text and structure it for targeted extraction
 */
export async function extractAndPersistText(
  documentId: string,
  aiAnalysisRaw: any,
  totalPages: number = 0
): Promise<ExtractedTextStructure> {
  log('INFO', 'TEXT_EXTRACT', `Extracting text structure from document ${documentId}`);

  // Build structure from AI analysis
  const structure: ExtractedTextStructure = {
    extractedAt: new Date().toISOString(),
    totalPages: totalPages || estimateTotalPages(aiAnalysisRaw),
    pages: extractPagesFromAnalysis(aiAnalysisRaw, totalPages),
    sections: identifyDocumentSections(aiAnalysisRaw)
  };

  log('INFO', 'TEXT_EXTRACT', `Identified ${structure.pages.length} pages, ${Object.keys(structure.sections).length} sections`);

  // Persist to database
  await persistToDatabase(documentId, structure);

  return structure;
}

/**
 * Extract page-level information from AI analysis
 * Looks for page references and organizes content by page
 */
function extractPagesFromAnalysis(aiAnalysisRaw: any, totalPages: number): ExtractedPage[] {
  const pages: ExtractedPage[] = [];

  // If we have page count, create placeholder pages
  // In future: extract actual text from PDF
  if (totalPages > 0) {
    for (let i = 1; i <= totalPages; i++) {
      pages.push({
        page: i,
        text: '', // Future: actual page text
        wordCount: 0
      });
    }
  }

  // Extract text from various analysis sections to build context
  const fullText = extractFullTextFromAnalysis(aiAnalysisRaw);

  // Create a single "virtual page" with all content for now
  // This enables targeted extraction even without per-page text
  if (pages.length === 0 && fullText) {
    pages.push({
      page: 1,
      text: fullText,
      wordCount: fullText.split(/\s+/).length
    });
  }

  return pages;
}

/**
 * Extract all text content from AI analysis for context
 */
function extractFullTextFromAnalysis(aiAnalysisRaw: any): string {
  if (!aiAnalysisRaw) return '';

  const textParts: string[] = [];

  // Extract from common fields
  if (aiAnalysisRaw.summary) textParts.push(aiAnalysisRaw.summary);
  if (aiAnalysisRaw.incidentDescription) textParts.push(aiAnalysisRaw.incidentDescription);
  if (aiAnalysisRaw.treatmentRecap?.narrative) textParts.push(aiAnalysisRaw.treatmentRecap.narrative);
  if (aiAnalysisRaw.impactToLife) textParts.push(aiAnalysisRaw.impactToLife);

  // Extract from arrays
  if (Array.isArray(aiAnalysisRaw.diagnosedInjuries)) {
    textParts.push(...aiAnalysisRaw.diagnosedInjuries.map((i: any) => i.injury || '').filter(Boolean));
  }

  if (Array.isArray(aiAnalysisRaw.treatmentRecap?.providerDetails)) {
    textParts.push(...aiAnalysisRaw.treatmentRecap.providerDetails.map((p: any) =>
      `${p.name || ''} ${p.specialty || ''} ${p.treatmentsProvided?.join(', ') || ''}`.trim()
    ).filter(Boolean));
  }

  return textParts.filter(Boolean).join('\n\n');
}

/**
 * Identify document sections from AI analysis
 * Groups related content for targeted extraction
 */
function identifyDocumentSections(aiAnalysisRaw: any): ExtractedTextStructure['sections'] {
  const sections: ExtractedTextStructure['sections'] = {};

  // Provider section
  if (aiAnalysisRaw.treatmentRecap?.providerDetails || aiAnalysisRaw.treatmentRecap?.narrative) {
    const providerText = [
      aiAnalysisRaw.treatmentRecap?.narrative || '',
      ...(aiAnalysisRaw.treatmentRecap?.providerDetails || []).map((p: any) =>
        `Provider: ${p.name}, Specialty: ${p.specialty}, Date Range: ${p.dateRange}, Visits: ${p.visits}, Treatments: ${p.treatmentsProvided?.join(', ')}`
      )
    ].filter(Boolean).join('\n');

    if (providerText) {
      sections.providers = {
        pages: extractPageReferences(providerText),
        text: providerText,
        keywords: extractKeywords(providerText, ['hospital', 'clinic', 'doctor', 'dr', 'physician', 'chiropractor'])
      };
    }
  }

  // Imaging section
  if (aiAnalysisRaw.treatmentRecap?.imagingResults) {
    const imagingText = aiAnalysisRaw.treatmentRecap.imagingResults.map((i: any) =>
      `${i.type}: ${i.bodyPart}, Date: ${i.date}, Findings: ${i.findings}`
    ).join('\n');

    if (imagingText) {
      sections.imaging = {
        pages: extractPageReferences(imagingText),
        text: imagingText,
        keywords: extractKeywords(imagingText, ['CT', 'MRI', 'X-ray', 'ultrasound', 'radiology', 'impression'])
      };
    }
  }

  // Bills section
  if (aiAnalysisRaw.medicalBillBreakdown) {
    const billsText = aiAnalysisRaw.medicalBillBreakdown.map((b: any) =>
      `Date: ${b.date}, Provider: ${b.provider}, Type: ${b.type}, Amount: ${b.amountBilled}`
    ).join('\n');

    if (billsText) {
      sections.bills = {
        pages: extractPageReferences(billsText),
        text: billsText,
        keywords: extractKeywords(billsText, ['CPT', 'bill', 'charge', 'amount', 'insurance', '$'])
      };
    }
  }

  return sections;
}

/**
 * Extract page numbers from text (e.g., "p. 5", "pp. 10-20")
 */
function extractPageReferences(text: string): number[] {
  const pages: Set<number> = new Set();

  // Match patterns like "p. 5", "pp. 10-20", "(p. 15)"
  const singlePagePattern = /\bp\.?\s*(\d+)\b/gi;
  const rangePattern = /\bpp\.?\s*(\d+)[-–](\d+)\b/gi;

  let match;
  while ((match = singlePagePattern.exec(text)) !== null) {
    pages.add(parseInt(match[1], 10));
  }

  while ((match = rangePattern.exec(text)) !== null) {
    const start = parseInt(match[1], 10);
    const end = parseInt(match[2], 10);
    for (let i = start; i <= end; i++) {
      pages.add(i);
    }
  }

  return Array.from(pages).sort((a, b) => a - b);
}

/**
 * Extract keywords from text based on a list of target terms
 */
function extractKeywords(text: string, targetKeywords: string[]): string[] {
  const lowerText = text.toLowerCase();
  return targetKeywords.filter(keyword => lowerText.includes(keyword.toLowerCase()));
}

/**
 * Estimate total pages from analysis if not provided
 */
function estimateTotalPages(aiAnalysisRaw: any): number {
  // Try to find the highest page number mentioned
  const fullText = JSON.stringify(aiAnalysisRaw);
  const pageRefs = extractPageReferences(fullText);

  if (pageRefs.length > 0) {
    return Math.max(...pageRefs);
  }

  return 0;
}

/**
 * Persist extracted text structure to database
 */
async function persistToDatabase(documentId: string, structure: ExtractedTextStructure): Promise<void> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !supabaseServiceKey) {
    log('WARN', 'TEXT_EXTRACT', 'Missing Supabase config, skipping persistence');
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const { error } = await supabase
    .from('claim_documents')
    .update({ extracted_text: structure })
    .eq('id', documentId);

  if (error) {
    log('ERROR', 'TEXT_EXTRACT', `Failed to persist extracted text: ${error.message}`);
    throw error;
  }

  log('INFO', 'TEXT_EXTRACT', `✅ Persisted ${structure.pages.length} pages to database`);
}

/**
 * Retrieve extracted text from database
 */
export async function getExtractedText(documentId: string): Promise<ExtractedTextStructure | null> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Missing Supabase configuration');
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const { data, error } = await supabase
    .from('claim_documents')
    .select('extracted_text')
    .eq('id', documentId)
    .single();

  if (error) {
    log('ERROR', 'TEXT_EXTRACT', `Failed to retrieve extracted text: ${error.message}`);
    return null;
  }

  return data?.extracted_text as ExtractedTextStructure | null;
}
