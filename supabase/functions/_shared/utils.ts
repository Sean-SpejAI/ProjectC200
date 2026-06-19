// Utility functions for document analysis

import { ERROR_CODES } from './types.ts';

export function log(level: 'INFO' | 'DEBUG' | 'WARN' | 'ERROR', context: string, message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level}] [${context}]`;
  
  if (data !== undefined) {
    console.log(`${prefix} ${message}`, typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

export function logStep(step: number, total: number, context: string, message: string) {
  log('INFO', context, `[STEP ${step}/${total}] ${message}`);
}

export function logTiming(context: string, operation: string, startTime: number) {
  const duration = Date.now() - startTime;
  log('DEBUG', context, `⏱️ ${operation} took ${duration}ms (${(duration / 1000).toFixed(2)}s)`);
}

export function getErrorCode(error: Error): string {
  const msg = error.message.toLowerCase();
  if (msg.includes('timeout')) return ERROR_CODES.TIMEOUT;
  if (msg.includes('503') || msg.includes('service unavailable')) return ERROR_CODES.GEMINI_503;
  if (msg.includes('rate limit') || msg.includes('429')) return ERROR_CODES.GEMINI_RATE_LIMIT;
  if (msg.includes('download') || msg.includes('storage')) return ERROR_CODES.DOWNLOAD_FAILED;
  if (msg.includes('invalid') || msg.includes('corrupt')) return ERROR_CODES.INVALID_FILE;
  if (msg.includes('credits') || msg.includes('402')) return ERROR_CODES.AI_CREDITS_EXHAUSTED;
  if (msg.includes('parse') || msg.includes('json')) return ERROR_CODES.PARSE_ERROR;
  return 'UNKNOWN';
}

export function normalizeFieldName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_\s\-\.:#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isClaimNumberField(fieldName: string): boolean {
  const normalized = normalizeFieldName(fieldName);
  const aliases = [
    "claim number", "claim no", "claim num", "claim #", "claim",
    "file number", "file no", "file #", "file num",
    "reference number", "reference no", "ref number", "ref no",
    "case number", "case no", "case #",
    "policy claim", "claim id", "claim ref"
  ];
  
  const normalizedAliases = aliases.map(normalizeFieldName);
  
  if (normalizedAliases.includes(normalized)) return true;
  
  for (const alias of normalizedAliases) {
    if (normalized.startsWith(alias)) return true;
  }
  
  const strictContainAliases = ["claim number", "claim no", "claim num", "file number", "case number"];
  for (const alias of strictContainAliases.map(normalizeFieldName)) {
    if (normalized.includes(alias)) return true;
  }
  
  return false;
}

export function extractClaimNumberFromText(text: string): string | null {
  if (!text) return null;
  
  // Prioritize text from first ~2000 characters (likely page 1)
  const priorityText = text.substring(0, 2000);
  
  const patterns = [
    // Primary patterns - look for explicit labels first
    /(?:CLAIM\s*(?:NO\.?|NUMBER|NUM|#)\s*:?\s*)([A-Z0-9][\w\-]{3,20})/i,
    /(?:CLAIM\s*#\s*:?\s*)([A-Z0-9][\w\-]{3,20})/i,
    /(?:FILE\s*(?:NO\.?|NUMBER|#)\s*:?\s*)([A-Z0-9][\w\-]{3,20})/i,
    /(?:REFERENCE\s*(?:NO\.?|NUMBER|#)\s*:?\s*)([A-Z0-9][\w\-]{3,20})/i,
    /(?:CASE\s*(?:NO\.?|NUMBER|#)\s*:?\s*)([A-Z0-9][\w\-]{3,20})/i,
    // Structured claim number patterns
    /\b(\d{2,4}[-](?:CV|CL|CLM|AUTO|BI|PIP)[-]\d{4,8})\b/i,
    /\b([A-Z]{2,4}[-]\d{6,12})\b/i,
    /\b(\d{2,3}[-\s]?[A-Z0-9]{3,6}[-\s]?[A-Z0-9]{2,4})\b/i,
  ];
  
  // First try priority text (page 1)
  for (const pattern of patterns) {
    const match = priorityText.match(pattern);
    if (match && match[1]) {
      const claimNum = match[1].trim();
      if (isValidClaimNumber(claimNum)) {
        log('DEBUG', 'UTILS', `Found claim number in priority text: ${claimNum}`);
        return claimNum;
      }
    }
  }
  
  // Then try full text
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const claimNum = match[1].trim();
      if (isValidClaimNumber(claimNum)) {
        log('DEBUG', 'UTILS', `Found claim number in full text: ${claimNum}`);
        return claimNum;
      }
    }
  }
  
  return null;
}

export function isValidClaimNumber(value: string): boolean {
  if (!value || value.length < 5 || value.length > 25) return false;
  
  // Reject common false positives
  const rejectedPatterns = [
    /^\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}$/, // Dates
    /^p\.?\s*\d+$/i, // Page references
    /^pp\.?\s*\d+/i, // Page ranges
    /^\d+\s*(after|before|and|or|of|per|from)\s*/i, // Phrases like "99 after PIP"
    /^(not\s*found|unknown|n\/a|none|pending)/i, // Placeholder values
    /^NDK-/i, // Auto-generated placeholders (legacy)
    /^TEMP-/i, // Temporary placeholders (new)
    /^[a-z\s]+$/i, // Pure text (no numbers)
    /^\d{1,4}$/, // Too short/simple numbers
  ];
  
  for (const pattern of rejectedPatterns) {
    if (pattern.test(value)) return false;
  }
  
  // Must contain at least one digit
  if (!/\d/.test(value)) return false;
  
  return true;
}

export function extractPageNumber(value: string): number | null {
  if (!value) return null;
  const match = value.match(/\(p\.?\s*(\d+)\)/i) || value.match(/\(pp\.?\s*(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

export function removePageReference(value: string): string {
  if (!value) return value;
  return value.replace(/\s*\(p\.?\s*\d+\)/gi, '').replace(/\s*\(pp\.?\s*\d+[-–]\d+\)/gi, '').trim();
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  log('DEBUG', 'UTILS', `Converting ArrayBuffer to base64`, { 
    sizeMB: `${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB` 
  });
  
  const uint8Array = new Uint8Array(buffer);
  let binaryStr = '';
  for (let i = 0; i < uint8Array.length; i++) {
    binaryStr += String.fromCharCode(uint8Array[i]);
  }
  
  const result = btoa(binaryStr);
  log('DEBUG', 'UTILS', `Base64 conversion complete`, { resultLength: result.length });
  
  return result;
}

// Tag a SALVAGED (non-clean) parse so downstream can flag the doc for review.
// A clean first-pass JSON.parse is NOT tagged; only the repair/truncation/
// force-close recovery paths are, since those imply the model output was
// truncated and the persisted extraction is partial.
function tagRecovered<T>(parsed: T): T {
  if (parsed && typeof parsed === 'object') {
    try { (parsed as Record<string, unknown>)._partialJsonRecovery = true; } catch { /* frozen */ }
  }
  return parsed;
}

export function repairAndParseJSON(jsonStr: string): any {
  try {
    // SAFETY: Strip JavaScript-style comments before parsing
    // This prevents issues if AI returns JSON with comments (which breaks JSON.parse)
    const cleanedContent = jsonStr
      .replace(/\/\*[\s\S]*?\*\//g, '')  // Remove /* */ block comments
      .replace(/\/\/.*/g, '');            // Remove // line comments

    return JSON.parse(cleanedContent);
  } catch (e) {
    log('DEBUG', 'PARSE', 'Direct parse failed, attempting repair...');
  }
  
  const braceCount = (jsonStr.match(/{/g) || []).length - (jsonStr.match(/}/g) || []).length;
  
  if (braceCount > 0) {
    log('DEBUG', 'PARSE', `Detected ${braceCount} unmatched opening braces, attempting repair`);
    const repaired = jsonStr + '}'.repeat(braceCount);
    try {
      return tagRecovered(JSON.parse(repaired));
    } catch (e) {
      log('DEBUG', 'PARSE', 'Repair with braces failed, trying truncation point detection');
    }
  }
  
  let lastValidPos = -1;
  let braceBalance = 0;
  let inString = false;
  let escaped = false;
  
  for (let i = 0; i < jsonStr.length; i++) {
    const char = jsonStr[i];
    const prev = i > 0 ? jsonStr[i - 1] : '';
    
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && inString) { escaped = true; continue; }
    if (char === '"' && prev !== '\\') { inString = !inString; }
    
    if (!inString) {
      if (char === '{') braceBalance++;
      if (char === '}') {
        braceBalance--;
        if (braceBalance === 0) { lastValidPos = i; }
      }
    }
  }
  
  if (lastValidPos > 0) {
    const truncated = jsonStr.substring(0, lastValidPos + 1);
    log('DEBUG', 'PARSE', `Found complete structure at position ${lastValidPos}, length: ${truncated.length}`);
    try {
      return tagRecovered(JSON.parse(truncated));
    } catch (e) {
      log('DEBUG', 'PARSE', 'Parse of truncated section failed');
    }
  }

  // Force-close repair: at the truncation point, close an open string and every
  // unclosed object/array (in reverse). Recovers FAR more of a
  // maxOutputTokens-truncated response than the last-fully-balanced-brace pass
  // above (which can sit very early in a deeply-nested doc). The rare
  // truncated-mid-key case still falls through to the throw below.
  {
    const stack: string[] = [];
    let inStr = false;
    let esc2 = false;
    for (let i = 0; i < jsonStr.length; i++) {
      const ch = jsonStr[i];
      if (esc2) { esc2 = false; continue; }
      if (ch === '\\' && inStr) { esc2 = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{' || ch === '[') stack.push(ch);
      else if (ch === '}' || ch === ']') stack.pop();
    }
    let repaired = jsonStr;
    if (inStr) repaired += '"';                      // close a truncated string value
    repaired = repaired.replace(/\s*[,:]\s*$/, '');  // drop a dangling , or :
    for (let k = stack.length - 1; k >= 0; k--) {
      repaired += stack[k] === '{' ? '}' : ']';
    }
    try {
      const parsed = tagRecovered(JSON.parse(repaired));
      log('INFO', 'PARSE', `✅ Recovered truncated JSON via force-close (${stack.length} open structures closed)`);
      return parsed;
    } catch (_e) {
      log('DEBUG', 'PARSE', 'Force-close repair failed');
    }
  }

  throw new Error('Could not repair JSON: response appears severely truncated');
}

export function parseAIResponse(aiContent: string) {
  log('DEBUG', 'PARSE', 'Parsing AI response', { contentLength: aiContent.length });
  
  let jsonStr = aiContent.trim();
  
  if (jsonStr.startsWith('```')) {
    const firstNewline = jsonStr.indexOf('\n');
    if (firstNewline !== -1) { jsonStr = jsonStr.substring(firstNewline + 1); }
    if (jsonStr.endsWith('```')) { jsonStr = jsonStr.slice(0, -3); }
    jsonStr = jsonStr.trim();
  }
  
  if (!jsonStr.startsWith('{')) {
    const jsonStart = jsonStr.indexOf('{');
    const jsonEnd = jsonStr.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      jsonStr = jsonStr.substring(jsonStart, jsonEnd + 1);
    }
  }
  
  const result = repairAndParseJSON(jsonStr);
  log('INFO', 'PARSE', '✅ JSON parsed successfully');
  
  return result;
}

export function parseToISODate(dateStr: string): string | null {
  if (!dateStr) return null;
  
  const cleaned = dateStr.replace(/\([^)]*\)/g, '').trim();
  if (!cleaned) return null;
  
  // Format: MM/DD/YY or MM/DD/YYYY
  const slashMatch = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashMatch) {
    const [, month, day, year] = slashMatch;
    const fullYear = year.length === 2 ? (parseInt(year) > 50 ? `19${year}` : `20${year}`) : year;
    return `${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  
  // Format: YYYY-MM-DD (already ISO)
  const isoMatch = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return cleaned;
  
  // Format: Month DD, YYYY (e.g., "June 27, 2025")
  const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 
                     'july', 'august', 'september', 'october', 'november', 'december'];
  const namedMatch = cleaned.toLowerCase().match(/^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (namedMatch) {
    const [, monthName, day, year] = namedMatch;
    const monthIndex = monthNames.indexOf(monthName);
    if (monthIndex !== -1) {
      return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
  }
  
  // Try native Date parsing as fallback
  try {
    const parsed = new Date(cleaned);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString().split('T')[0];
    }
  } catch {
    // Parsing failed
  }
  
  return null;
}
