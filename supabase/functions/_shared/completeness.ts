// Completeness Analysis & Quality Scoring for Multi-Pass Extraction Pipeline
// Calculates extraction quality and determines if self-healing retry is needed

import { log } from './utils.ts';
import {
  EXTRACTION_SCHEMA,
  FieldDefinition,
  getNestedValue,
  isEmptyValue
} from './extraction-schema.ts';

export interface CompletenessReport {
  overallScore: number; // 0.0 - 1.0
  requiredFieldsScore: number; // 0.0 - 1.0
  optionalFieldsScore: number; // 0.0 - 1.0
  fieldScores: Record<string, FieldScore>;
  recommendation: 'accept' | 'review' | 'retry';
  totalFields: number;
  completeFields: number;
  missingRequiredFields: string[];
  lowQualityFields: string[];
}

export interface FieldScore {
  fieldName: string;
  present: boolean;
  confidence: number; // 0.0 - 1.0
  quality: 'excellent' | 'good' | 'poor' | 'missing';
  reason?: string;
}

/**
 * Calculate extraction completeness and quality
 *
 * Scoring logic:
 * - excellent (1.0): Field present, high confidence (>=0.8), well-formed data
 * - good (0.7): Field present, medium confidence (>=0.5), acceptable data
 * - poor (0.3): Field present but low confidence (<0.5) or incomplete data
 * - missing (0.0): Field not present
 *
 * Overall score:
 * - Required fields weighted 2x more than optional fields
 * - Recommendation: accept (>=0.8), review (>=0.5), retry (<0.5)
 */
export function calculateCompleteness(
  analysis: any,
  schema: Record<string, FieldDefinition>
): CompletenessReport {
  log('INFO', 'COMPLETENESS', 'Calculating extraction completeness');

  const fieldScores: Record<string, FieldScore> = {};
  const missingRequiredFields: string[] = [];
  const lowQualityFields: string[] = [];

  let requiredScore = 0;
  let requiredCount = 0;
  let optionalScore = 0;
  let optionalCount = 0;

  // Analyze each field
  for (const [fieldName, fieldDef] of Object.entries(schema)) {
    const value = getNestedValue(analysis, fieldName);
    const confidence = getNestedValue(analysis, `${fieldName}Confidence`) || 1.0;

    const score: FieldScore = {
      fieldName,
      present: !isEmptyValue(value),
      confidence,
      quality: determineQuality(value, confidence, fieldDef)
    };

    // Add reason for poor/missing quality
    if (score.quality === 'missing') {
      score.reason = 'Field not present in analysis';
      if (fieldDef.required) {
        missingRequiredFields.push(fieldName);
      }
    } else if (score.quality === 'poor') {
      score.reason = confidence < 0.5 ? 'Low confidence score' : 'Incomplete or malformed data';
      lowQualityFields.push(fieldName);
    }

    fieldScores[fieldName] = score;

    // Calculate numeric score (0.0 - 1.0)
    const scoreValue = getScoreValue(score.quality);

    if (fieldDef.required) {
      requiredScore += scoreValue;
      requiredCount++;
    } else {
      optionalScore += scoreValue;
      optionalCount++;
    }
  }

  // Calculate overall scores
  const requiredFieldsScore = requiredCount > 0 ? requiredScore / requiredCount : 0;
  const optionalFieldsScore = optionalCount > 0 ? optionalScore / optionalCount : 0;

  // Weighted overall score (required fields count 2x)
  const overallScore = requiredCount > 0
    ? (requiredFieldsScore * 2 + optionalFieldsScore) / 3
    : optionalFieldsScore;

  // Determine recommendation
  const recommendation = getRecommendation(overallScore, missingRequiredFields.length);

  const completeFields = Object.values(fieldScores).filter(s => s.quality === 'excellent' || s.quality === 'good').length;
  const totalFields = Object.keys(schema).length;

  const report: CompletenessReport = {
    overallScore,
    requiredFieldsScore,
    optionalFieldsScore,
    fieldScores,
    recommendation,
    totalFields,
    completeFields,
    missingRequiredFields,
    lowQualityFields
  };

  log('INFO', 'COMPLETENESS', `Overall: ${(overallScore * 100).toFixed(1)}% | Required: ${(requiredFieldsScore * 100).toFixed(1)}% | Optional: ${(optionalFieldsScore * 100).toFixed(1)}%`);
  log('INFO', 'COMPLETENESS', `Complete: ${completeFields}/${totalFields} fields | Recommendation: ${recommendation.toUpperCase()}`);

  if (missingRequiredFields.length > 0) {
    log('WARN', 'COMPLETENESS', `Missing required fields: ${missingRequiredFields.join(', ')}`);
  }

  if (lowQualityFields.length > 0) {
    log('WARN', 'COMPLETENESS', `Low quality fields: ${lowQualityFields.join(', ')}`);
  }

  return report;
}

/**
 * Determine quality level for a field
 */
function determineQuality(
  value: any,
  confidence: number,
  fieldDef: FieldDefinition
): 'excellent' | 'good' | 'poor' | 'missing' {
  // Missing value
  if (isEmptyValue(value)) {
    return 'missing';
  }

  // Check confidence level first
  if (confidence < 0.5) {
    return 'poor';
  }

  // Check data completeness for arrays
  if (fieldDef.type === 'array' && Array.isArray(value)) {
    const avgFieldCompleteness = calculateArrayFieldCompleteness(value);

    if (avgFieldCompleteness < 0.5) {
      return 'poor';
    }

    if (avgFieldCompleteness >= 0.9 && confidence >= 0.8) {
      return 'excellent';
    }

    if (avgFieldCompleteness >= 0.7 || confidence >= 0.6) {
      return 'good';
    }

    return 'poor';
  }

  // Check minimum length for strings
  if (fieldDef.type === 'string' && fieldDef.validationRules?.minLength) {
    if (typeof value === 'string' && value.length < fieldDef.validationRules.minLength) {
      return 'poor';
    }
  }

  // Check format for strings
  if (fieldDef.type === 'string' && fieldDef.validationRules?.format) {
    if (typeof value === 'string' && !fieldDef.validationRules.format.test(value)) {
      return 'poor';
    }
  }

  // High confidence, all checks passed
  if (confidence >= 0.8) {
    return 'excellent';
  }

  // Medium confidence
  if (confidence >= 0.5) {
    return 'good';
  }

  return 'poor';
}

/**
 * Calculate field completeness for array items
 * Returns 0.0 - 1.0 representing average field population
 */
function calculateArrayFieldCompleteness(arr: any[]): number {
  if (!Array.isArray(arr) || arr.length === 0) {
    return 0;
  }

  let totalFields = 0;
  let filledFields = 0;

  for (const item of arr) {
    if (typeof item !== 'object' || item === null) continue;

    const keys = Object.keys(item);
    totalFields += keys.length;

    for (const key of keys) {
      const value = item[key];
      if (!isEmptyValue(value)) {
        filledFields++;
      }
    }
  }

  return totalFields > 0 ? filledFields / totalFields : 0;
}

/**
 * Convert quality level to numeric score
 */
function getScoreValue(quality: 'excellent' | 'good' | 'poor' | 'missing'): number {
  switch (quality) {
    case 'excellent': return 1.0;
    case 'good': return 0.7;
    case 'poor': return 0.3;
    case 'missing': return 0.0;
  }
}

/**
 * Determine recommendation based on scores
 */
function getRecommendation(
  overallScore: number,
  missingRequiredCount: number
): 'accept' | 'review' | 'retry' {
  // Any missing required fields = retry
  if (missingRequiredCount > 0) {
    return 'retry';
  }

  // High score = accept
  if (overallScore >= 0.8) {
    return 'accept';
  }

  // Medium score = review (human validation needed)
  if (overallScore >= 0.5) {
    return 'review';
  }

  // Low score = retry
  return 'retry';
}

/**
 * Get detailed quality summary for UI display
 */
export function getQualitySummary(report: CompletenessReport): string {
  const lines: string[] = [];

  lines.push(`Overall Quality: ${(report.overallScore * 100).toFixed(0)}% (${report.recommendation.toUpperCase()})`);
  lines.push(`Complete Fields: ${report.completeFields}/${report.totalFields}`);

  if (report.missingRequiredFields.length > 0) {
    lines.push(`Missing Required: ${report.missingRequiredFields.join(', ')}`);
  }

  if (report.lowQualityFields.length > 0) {
    lines.push(`Low Quality: ${report.lowQualityFields.join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * Get fields that need focused retry extraction
 * Returns only poor/missing fields, not excellent/good ones
 */
export function getFieldsForRetry(report: CompletenessReport): string[] {
  return Object.entries(report.fieldScores)
    .filter(([_, score]) => score.quality === 'missing' || score.quality === 'poor')
    .map(([fieldName, _]) => fieldName);
}

/**
 * Check if a specific field meets quality threshold
 */
export function isFieldQualityAcceptable(
  report: CompletenessReport,
  fieldName: string,
  minQuality: 'excellent' | 'good' | 'poor' = 'good'
): boolean {
  const score = report.fieldScores[fieldName];
  if (!score) return false;

  const qualityLevels = ['missing', 'poor', 'good', 'excellent'];
  const minIndex = qualityLevels.indexOf(minQuality);
  const actualIndex = qualityLevels.indexOf(score.quality);

  return actualIndex >= minIndex;
}

/**
 * Calculate improvement between two completeness reports
 * Useful for tracking Pass 1 → Pass 2 → Pass 3 improvements
 */
export function calculateImprovement(
  beforeReport: CompletenessReport,
  afterReport: CompletenessReport
): {
  scoreImprovement: number;
  fieldsImproved: string[];
  fieldsDegraded: string[];
} {
  const scoreImprovement = afterReport.overallScore - beforeReport.overallScore;
  const fieldsImproved: string[] = [];
  const fieldsDegraded: string[] = [];

  for (const fieldName of Object.keys(afterReport.fieldScores)) {
    const beforeScore = beforeReport.fieldScores[fieldName];
    const afterScore = afterReport.fieldScores[fieldName];

    if (!beforeScore || !afterScore) continue;

    const beforeValue = getScoreValue(beforeScore.quality);
    const afterValue = getScoreValue(afterScore.quality);

    if (afterValue > beforeValue) {
      fieldsImproved.push(fieldName);
    } else if (afterValue < beforeValue) {
      fieldsDegraded.push(fieldName);
    }
  }

  return { scoreImprovement, fieldsImproved, fieldsDegraded };
}

/**
 * Save completeness score to database
 */
export async function saveCompletenessScore(
  documentId: string,
  completeness: number
): Promise<void> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !supabaseServiceKey) {
    log('WARN', 'COMPLETENESS', 'Missing Supabase config, skipping save');
    return;
  }

  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const { error } = await supabase
    .from('claim_documents')
    .update({ extraction_completeness: completeness })
    .eq('id', documentId);

  if (error) {
    log('ERROR', 'COMPLETENESS', `Failed to save completeness score: ${error.message}`);
  } else {
    log('INFO', 'COMPLETENESS', `✅ Saved completeness score: ${(completeness * 100).toFixed(1)}%`);
  }
}

/**
 * Log extraction pass results for debugging
 */
export async function logExtractionPass(
  documentId: string,
  passNumber: number,
  fieldsExtracted: string[],
  completenessScore: number,
  extras?: { evaluatorVerdict?: unknown; triggeredBy?: string },
): Promise<void> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !supabaseServiceKey) {
    return;
  }

  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const row: Record<string, unknown> = {
    document_id: documentId,
    pass_number: passNumber,
    fields_extracted: fieldsExtracted,
    completeness_score: completenessScore,
  };
  if (extras?.evaluatorVerdict !== undefined) row.evaluator_verdict = extras.evaluatorVerdict;
  if (extras?.triggeredBy) row.triggered_by = extras.triggeredBy;

  const { error } = await supabase.from('extraction_passes').insert(row);

  if (error) {
    log('DEBUG', 'COMPLETENESS', `Failed to log extraction pass: ${error.message}`);
  } else {
    log('DEBUG', 'COMPLETENESS', `Logged Pass ${passNumber}: ${fieldsExtracted.length} fields, ${(completenessScore * 100).toFixed(1)}% complete`);
  }
}

/**
 * Persist the grounding evaluation outcome onto claim_documents.
 * Called once after the Pass 5 loop (or its early-exit failure paths) so the
 * frontend can render the verified / needs-review badge and humans have an
 * audit trail of the last verdict.
 */
export async function saveGroundingResult(
  documentId: string,
  result: {
    status: 'passed' | 'partial' | 'failed' | 'skipped_oversize' | 'not_run';
    score: number | null;
    iterations: number;
    evaluation: unknown | null;
  },
): Promise<void> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !supabaseServiceKey) {
    log('WARN', 'GROUNDING', 'Missing Supabase config, skipping save');
    return;
  }
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const { error } = await supabase
    .from('claim_documents')
    .update({
      grounding_status: result.status,
      grounding_score: result.score,
      grounding_iterations: result.iterations,
      grounding_evaluation: result.evaluation,
    })
    .eq('id', documentId);

  if (error) {
    log('ERROR', 'GROUNDING', `Failed to save grounding result: ${error.message}`);
  } else {
    log('INFO', 'GROUNDING', `✅ Saved grounding result: ${result.status} (score=${result.score ?? 'n/a'}, iterations=${result.iterations})`);
  }
}
