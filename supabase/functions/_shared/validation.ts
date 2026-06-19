// Pass 3: Validation, Deduplication & Aggregation for Multi-Pass Extraction Pipeline
// Cross-checks Pass 1 vs Pass 2, deduplicates providers, calculates aggregated fields

import { log } from './utils.ts';
import {
  EXTRACTION_SCHEMA,
  FieldDefinition,
  getNestedValue,
  setNestedValue,
  isEmptyValue
} from './extraction-schema.ts';

export interface ValidationReport {
  fieldsChecked: number;
  fieldsPassed: number;
  fieldsFailed: number;
  issues: ValidationIssue[];
}

export interface ValidationIssue {
  field: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

/**
 * Validate and aggregate results from Pass 1 and Pass 2
 *
 * Pass 3 Strategy:
 * - Merge Pass 2 results into Pass 1 (fill gaps only)
 * - Deduplicate providers (e.g., "Tampa General" === "Tampa General Hospital ER")
 * - Calculate aggregated fields (e.g., total visits = sum of provider visits)
 * - Validate required fields and data quality
 */
export function validateAndAggregateResults(
  pass1: any,
  pass2: any,
  schema: Record<string, FieldDefinition>
): { merged: any; validation: ValidationReport } {

  log('INFO', 'VALIDATION', 'Starting Pass 3 validation and aggregation');

  const merged = { ...pass1 };
  const validation: ValidationReport = {
    fieldsChecked: 0,
    fieldsPassed: 0,
    fieldsFailed: 0,
    issues: []
  };

  // Step 1: Merge Pass 2 results into Pass 1 (only fill empty fields)
  mergePass2IntoPass1(merged, pass2, validation);

  // Step 2: Deduplicate providers
  if (merged.treatmentRecap?.providerDetails) {
    const originalCount = merged.treatmentRecap.providerDetails.length;
    merged.treatmentRecap.providerDetails = deduplicateProviders(merged.treatmentRecap.providerDetails);
    const dedupedCount = merged.treatmentRecap.providerDetails.length;

    if (dedupedCount < originalCount) {
      validation.issues.push({
        field: 'treatmentRecap.providerDetails',
        severity: 'info',
        message: `Deduplicated ${originalCount - dedupedCount} duplicate provider(s)`
      });
      log('INFO', 'VALIDATION', `✅ Deduplicated ${originalCount} → ${dedupedCount} providers`);
    }
  }

  // Step 3: Calculate aggregated fields
  calculateAggregatedFields(merged, validation);

  // Step 4: Validate required fields
  validateRequiredFields(merged, schema, validation);

  // Step 5: Validate data quality
  validateDataQuality(merged, schema, validation);

  log('INFO', 'VALIDATION', `Pass 3 complete: ${validation.fieldsPassed}/${validation.fieldsChecked} fields passed, ${validation.fieldsFailed} failed`);

  return { merged, validation };
}

/**
 * Merge Pass 2 results into Pass 1
 * Only fills empty fields, doesn't overwrite existing data
 */
function mergePass2IntoPass1(
  pass1: any,
  pass2: any,
  validation: ValidationReport
): void {
  if (!pass2 || Object.keys(pass2).length === 0) {
    log('DEBUG', 'VALIDATION', 'No Pass 2 results to merge');
    return;
  }

  for (const [fieldName, pass2Value] of Object.entries(pass2)) {
    if (!isEmptyValue(pass2Value)) {
      const pass1Value = getNestedValue(pass1, fieldName);

      if (isEmptyValue(pass1Value)) {
        setNestedValue(pass1, fieldName, pass2Value);
        validation.issues.push({
          field: fieldName,
          severity: 'info',
          message: 'Gap-filled from Pass 2'
        });
        log('INFO', 'VALIDATION', `Merged ${fieldName} from Pass 2`);
      }
    }
  }
}

/**
 * Deduplicate providers by normalizing names
 *
 * Examples:
 * - "Tampa General Hospital" === "Tampa General Hospital ER"
 * - "Dr. Smith" === "Dr. Robert Smith"
 * - "Chambers Medical Group" === "Chambers Medical"
 */
export function deduplicateProviders(providers: any[]): any[] {
  if (!Array.isArray(providers) || providers.length === 0) {
    return providers;
  }

  const seen = new Map<string, any>();

  for (const provider of providers) {
    const normalizedName = normalizeProviderName(provider.name || '');

    if (seen.has(normalizedName)) {
      // Merge visits and treatments
      const existing = seen.get(normalizedName)!;

      // Sum visits
      existing.visits = sumVisits(existing.visits, provider.visits);

      // Merge treatments (deduplicate)
      const existingTreatments = Array.isArray(existing.treatmentsProvided) ? existing.treatmentsProvided : [];
      const newTreatments = Array.isArray(provider.treatmentsProvided) ? provider.treatmentsProvided : [];
      existing.treatmentsProvided = [...new Set([...existingTreatments, ...newTreatments])];

      // Merge date ranges (use earliest start, latest end)
      existing.dateRange = mergeDateRanges(existing.dateRange, provider.dateRange);

      // Merge page references
      existing.pageRefs = mergePageRefs(existing.pageRefs, provider.pageRefs);

      log('DEBUG', 'VALIDATION', `Merged duplicate provider: ${normalizedName}`);
    } else {
      seen.set(normalizedName, { ...provider });
    }
  }

  return Array.from(seen.values());
}

/**
 * Normalize provider name for comparison
 * Removes common words and non-alphanumeric characters
 */
export function normalizeProviderName(name: string): string {
  if (!name) return '';

  return name.toLowerCase()
    // Remove common words
    .replace(/\b(dr|doctor|mr|mrs|ms|hospital|clinic|medical group|center|centre|llc|inc|pa|md|do|dc)\b/g, '')
    // Remove non-alphanumeric
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/**
 * Sum visit counts from two providers
 */
function sumVisits(visits1: string | number, visits2: string | number): string {
  const num1 = parseVisitCount(visits1);
  const num2 = parseVisitCount(visits2);
  return (num1 + num2).toString();
}

/**
 * Parse visit count from string or number
 */
function parseVisitCount(visits: string | number): number {
  if (typeof visits === 'number') return visits;
  if (typeof visits !== 'string') return 0;

  // Extract first number from string (e.g., "12 visits" → 12)
  const match = visits.match(/\d+/);
  return match ? parseInt(match[0], 10) : 0;
}

/**
 * Merge date ranges (use earliest start, latest end)
 */
function mergeDateRanges(range1: string, range2: string): string {
  if (!range1) return range2;
  if (!range2) return range1;

  // Parse date ranges (formats: "MM/DD/YYYY" or "MM/DD/YYYY - MM/DD/YYYY")
  const dates1 = extractDatesFromRange(range1);
  const dates2 = extractDatesFromRange(range2);

  const allDates = [...dates1, ...dates2].sort();

  if (allDates.length === 0) return range1;
  if (allDates.length === 1) return allDates[0];

  return `${allDates[0]} - ${allDates[allDates.length - 1]}`;
}

/**
 * Extract dates from a date range string
 */
function extractDatesFromRange(range: string): string[] {
  if (!range) return [];

  // Match MM/DD/YYYY format
  const datePattern = /\d{1,2}\/\d{1,2}\/\d{4}/g;
  const matches = range.match(datePattern);

  return matches || [];
}

/**
 * Merge page references
 */
function mergePageRefs(refs1: string, refs2: string): string {
  if (!refs1) return refs2;
  if (!refs2) return refs1;

  // Combine and deduplicate
  const combined = `${refs1}, ${refs2}`;
  return combined;
}

/**
 * Calculate aggregated fields
 * Example: totalVisits = sum of all provider visits
 */
function calculateAggregatedFields(
  merged: any,
  validation: ValidationReport
): void {
  // Calculate total visits from all providers
  if (merged.treatmentRecap?.providerDetails && Array.isArray(merged.treatmentRecap.providerDetails)) {
    const totalVisits = calculateTotalVisits(merged.treatmentRecap.providerDetails);

    if (totalVisits > 0) {
      merged.treatmentRecap.totalVisits = totalVisits.toString();
      validation.issues.push({
        field: 'treatmentRecap.totalVisits',
        severity: 'info',
        message: `Calculated from ${merged.treatmentRecap.providerDetails.length} provider(s): ${totalVisits} total visits`
      });
      log('INFO', 'VALIDATION', `✅ Calculated total visits: ${totalVisits}`);
    }
  }
}

/**
 * Calculate total visits from all providers
 */
export function calculateTotalVisits(providers: any[]): number {
  if (!Array.isArray(providers) || providers.length === 0) {
    return 0;
  }

  let total = 0;

  for (const provider of providers) {
    const visits = provider.visits || '0';
    const parsed = parseVisitCount(visits);
    total += parsed;
  }

  return total;
}

/**
 * Validate required fields are present
 */
function validateRequiredFields(
  merged: any,
  schema: Record<string, FieldDefinition>,
  validation: ValidationReport
): void {
  for (const [fieldName, fieldDef] of Object.entries(schema)) {
    if (!fieldDef.required) continue;

    validation.fieldsChecked++;

    const value = getNestedValue(merged, fieldName);

    if (isEmptyValue(value)) {
      validation.fieldsFailed++;
      validation.issues.push({
        field: fieldName,
        severity: 'error',
        message: 'Required field missing even after Pass 2 gap-fill'
      });
      log('ERROR', 'VALIDATION', `❌ Required field missing: ${fieldName}`);
    } else {
      validation.fieldsPassed++;
      log('DEBUG', 'VALIDATION', `✅ Required field present: ${fieldName}`);
    }
  }
}

/**
 * Validate data quality (format, length, etc.)
 */
function validateDataQuality(
  merged: any,
  schema: Record<string, FieldDefinition>,
  validation: ValidationReport
): void {
  for (const [fieldName, fieldDef] of Object.entries(schema)) {
    const value = getNestedValue(merged, fieldName);

    if (isEmptyValue(value)) continue; // Already checked in required fields

    validation.fieldsChecked++;

    // Validate array minimum length
    if (fieldDef.type === 'array' && fieldDef.validationRules?.minLength) {
      if (!Array.isArray(value) || value.length < fieldDef.validationRules.minLength) {
        validation.fieldsFailed++;
        validation.issues.push({
          field: fieldName,
          severity: 'error',
          message: `Array has ${Array.isArray(value) ? value.length : 0} items but requires at least ${fieldDef.validationRules.minLength}`
        });
        log('ERROR', 'VALIDATION', `❌ ${fieldName}: insufficient array length`);
        continue;
      }
    }

    // Validate string format
    if (fieldDef.type === 'string' && fieldDef.validationRules?.format) {
      if (typeof value === 'string' && !fieldDef.validationRules.format.test(value)) {
        validation.fieldsFailed++;
        validation.issues.push({
          field: fieldName,
          severity: 'warning',
          message: `Value does not match expected format: ${fieldDef.validationRules.format}`
        });
        log('WARN', 'VALIDATION', `⚠️ ${fieldName}: format mismatch`);
        continue;
      }
    }

    // Validate string minimum length
    if (fieldDef.type === 'string' && fieldDef.validationRules?.minLength) {
      if (typeof value === 'string' && value.length < fieldDef.validationRules.minLength) {
        validation.fieldsFailed++;
        validation.issues.push({
          field: fieldName,
          severity: 'warning',
          message: `String has ${value.length} characters but requires at least ${fieldDef.validationRules.minLength}`
        });
        log('WARN', 'VALIDATION', `⚠️ ${fieldName}: insufficient string length`);
        continue;
      }
    }

    validation.fieldsPassed++;
  }
}

/**
 * Helper: Check if provider details array is well-formed
 */
export function validateProviderDetails(providers: any[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!Array.isArray(providers)) {
    issues.push({
      field: 'treatmentRecap.providerDetails',
      severity: 'error',
      message: 'Provider details is not an array'
    });
    return issues;
  }

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];

    if (!provider.name) {
      issues.push({
        field: `treatmentRecap.providerDetails[${i}].name`,
        severity: 'error',
        message: 'Provider name is required'
      });
    }

    if (!provider.visits) {
      issues.push({
        field: `treatmentRecap.providerDetails[${i}].visits`,
        severity: 'warning',
        message: 'Provider visits count is missing'
      });
    }
  }

  return issues;
}

/**
 * Helper: Check if imaging results array is well-formed
 */
export function validateImagingResults(imaging: any[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!Array.isArray(imaging)) {
    issues.push({
      field: 'treatmentRecap.imagingResults',
      severity: 'error',
      message: 'Imaging results is not an array'
    });
    return issues;
  }

  for (let i = 0; i < imaging.length; i++) {
    const study = imaging[i];

    if (!study.type) {
      issues.push({
        field: `treatmentRecap.imagingResults[${i}].type`,
        severity: 'error',
        message: 'Imaging type is required'
      });
    }

    if (!study.findings) {
      issues.push({
        field: `treatmentRecap.imagingResults[${i}].findings`,
        severity: 'warning',
        message: 'Imaging findings are missing'
      });
    }
  }

  return issues;
}
