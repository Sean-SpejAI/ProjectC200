// Chunk merging utilities for split PDF analysis

import { log, extractClaimNumberFromText, extractPageNumber, removePageReference, isValidClaimNumber } from './utils.ts';

export function mergeChunkResults(chunkResults: any[], originalFileName: string): any {
  if (chunkResults.length === 0) throw new Error('No chunk results to merge');
  if (chunkResults.length === 1) return validateAndCleanResult(chunkResults[0]);
  
  log('INFO', 'MERGE_CHUNKS', `Merging ${chunkResults.length} chunk results`);
  
  const merged = { ...chunkResults[0] };
  
  let bestClaimNumber: string | null = null;
  let bestClaimNumberPage: number = Infinity;
  let bestPatientName: string | null = null;
  let bestPatientNamePage: number = Infinity;
  
  for (let i = 0; i < chunkResults.length; i++) {
    const chunk = chunkResults[i];
    
  if (chunk.headerInfo?.claimNumber) {
      const rawValue = chunk.headerInfo.claimNumber;
      const pageNum = extractPageNumber(rawValue) || (i * 30) + 1;
      const cleanValue = removePageReference(rawValue);
      
      // Validate claim number before accepting
      if (cleanValue && isValidClaimNumber(cleanValue) && pageNum < bestClaimNumberPage) {
        bestClaimNumber = cleanValue;
        bestClaimNumberPage = pageNum;
        log('INFO', 'MERGE_CHUNKS', `Found valid claim number "${cleanValue}" from page ${pageNum} (chunk ${i})`);
      } else if (cleanValue && !isValidClaimNumber(cleanValue)) {
        log('WARN', 'MERGE_CHUNKS', `Rejected invalid claim number "${cleanValue}" from chunk ${i}`);
      }
    }
    
    if (chunk.extractedClaimNumber) {
      const rawValue = chunk.extractedClaimNumber;
      const pageNum = extractPageNumber(rawValue) || (i * 30) + 1;
      const cleanValue = removePageReference(rawValue);
      
      // Validate claim number before accepting
      if (cleanValue && isValidClaimNumber(cleanValue) && pageNum < bestClaimNumberPage) {
        bestClaimNumber = cleanValue;
        bestClaimNumberPage = pageNum;
        log('INFO', 'MERGE_CHUNKS', `Found valid extractedClaimNumber "${cleanValue}" from page ${pageNum}`);
      }
    }
    
    if (i === 0 && !bestClaimNumber && chunk.rawContent) {
      const extracted = extractClaimNumberFromText(chunk.rawContent);
      if (extracted) {
        bestClaimNumber = extracted;
        bestClaimNumberPage = 1;
      }
    }
    
    const patientName = chunk.patientName || chunk.headerInfo?.namedobGender;
    if (patientName) {
      const pageNum = extractPageNumber(patientName) || (i * 30) + 1;
      if (pageNum < bestPatientNamePage) {
        bestPatientName = removePageReference(patientName);
        bestPatientNamePage = pageNum;
      }
    }
  }

  if (bestClaimNumber) {
    merged.extractedClaimNumber = bestClaimNumber;
    if (!merged.headerInfo) merged.headerInfo = {};
    merged.headerInfo.claimNumber = bestClaimNumber;
  }
  
  if (bestPatientName) merged.patientName = bestPatientName;
  
  for (const chunk of chunkResults) {
    if (chunk.headerInfo && !merged.headerInfo) {
      merged.headerInfo = { ...chunk.headerInfo };
    } else if (chunk.headerInfo && merged.headerInfo) {
      const preservedClaimNumber = merged.headerInfo.claimNumber;
      for (const key of Object.keys(chunk.headerInfo)) {
        if (!merged.headerInfo[key]) merged.headerInfo[key] = chunk.headerInfo[key];
      }
      if (preservedClaimNumber) merged.headerInfo.claimNumber = preservedClaimNumber;
    }
    
    if (chunk.extractedClaimType && !merged.extractedClaimType) {
      merged.extractedClaimType = chunk.extractedClaimType;
    }
  }

  for (let i = 1; i < chunkResults.length; i++) {
    const chunk = chunkResults[i];
    
    if (chunk.diagnosedInjuries && Array.isArray(chunk.diagnosedInjuries)) {
      merged.diagnosedInjuries = [...(merged.diagnosedInjuries || []), ...chunk.diagnosedInjuries];
    }
    
    if (chunk.medicalBillBreakdown && Array.isArray(chunk.medicalBillBreakdown)) {
      merged.medicalBillBreakdown = [...(merged.medicalBillBreakdown || []), ...chunk.medicalBillBreakdown];
    }
    
    if (chunk.postAccidentRecap && Array.isArray(chunk.postAccidentRecap)) {
      merged.postAccidentRecap = [...(merged.postAccidentRecap || []), ...chunk.postAccidentRecap];
    }
    
    if (chunk.preAccidentRecap && Array.isArray(chunk.preAccidentRecap)) {
      merged.preAccidentRecap = [...(merged.preAccidentRecap || []), ...chunk.preAccidentRecap];
    }
    
    if (chunk.flags && Array.isArray(chunk.flags)) {
      merged.flags = [...new Set([...(merged.flags || []), ...chunk.flags])];
    }
    
    if (chunk.recommendedActions && Array.isArray(chunk.recommendedActions)) {
      merged.recommendedActions = [...new Set([...(merged.recommendedActions || []), ...chunk.recommendedActions])];
    }
    
    if (chunk.treatmentRecap?.providers && Array.isArray(chunk.treatmentRecap.providers)) {
      merged.treatmentRecap = merged.treatmentRecap || {};
      merged.treatmentRecap.providers = [...new Set([...(merged.treatmentRecap.providers || []), ...chunk.treatmentRecap.providers])];
    }
    
    if (chunk.treatmentRecap?.narrative && merged.treatmentRecap?.narrative) {
      // Deduplicate paragraphs when merging narratives
      const combined = `${merged.treatmentRecap.narrative}\n\n${chunk.treatmentRecap.narrative}`;
      const paragraphs = combined.split('\n\n');
      const seen = new Set<string>();
      const unique = paragraphs.filter(p => {
        const fp = p.toLowerCase().trim().slice(0, 80);
        if (!fp || seen.has(fp)) return false;
        seen.add(fp);
        return true;
      });
      merged.treatmentRecap.narrative = unique.join('\n\n');
    }
    
    if (chunk.impactToLife && merged.impactToLife) {
      merged.impactToLife = `${merged.impactToLife}\n\n${chunk.impactToLife}`;
    }
    
    if (typeof chunk.confidenceScore === 'number') {
      merged.confidenceScore = Math.max(merged.confidenceScore || 0, chunk.confidenceScore);
    }
  }
  
  merged.summary = `Merged analysis from ${chunkResults.length} document parts: ${originalFileName}. ${merged.summary || ''}`;
  merged.processingMode = 'chunked';
  merged.chunksProcessed = chunkResults.length;
  
  log('INFO', 'MERGE_CHUNKS', 'Merge complete', {
    diagnosedInjuriesCount: merged.diagnosedInjuries?.length || 0,
    medicalBillsCount: merged.medicalBillBreakdown?.length || 0,
    flagsCount: merged.flags?.length || 0,
  });

  return validateAndCleanResult(merged);
}

// Validate and clean the final result to ensure claim number is valid
function validateAndCleanResult(result: any): any {
  // Validate claim number in header
  if (result.headerInfo?.claimNumber) {
    if (!isValidClaimNumber(result.headerInfo.claimNumber)) {
      log('WARN', 'MERGE_CHUNKS', `Removing invalid headerInfo.claimNumber: "${result.headerInfo.claimNumber}"`);
      result.headerInfo.claimNumber = 'Not found (searched p. 1)';
    }
  }
  
  // Validate extracted claim number
  if (result.extractedClaimNumber) {
    if (!isValidClaimNumber(result.extractedClaimNumber)) {
      log('WARN', 'MERGE_CHUNKS', `Removing invalid extractedClaimNumber: "${result.extractedClaimNumber}"`);
      result.extractedClaimNumber = null;
    }
  }
  
  return result;
}
