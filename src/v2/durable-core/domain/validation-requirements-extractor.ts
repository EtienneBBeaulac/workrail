import type { ValidationCriteria, ValidationRule } from '../../../types/validation.js';
import { isValidationRule, isValidationComposition } from '../../../types/validation.js';

/**
 * Extract human-readable validation requirements from ValidationCriteria.
 * 
 * Supports:
 * - contains rules (51% of usage)
 * - regex rules (36% of usage)  
 * - length rules (13% of usage)
 * - and compositions
 * 
 * Returns top 5 requirements max to prevent prompt bloat.
 * Fail-safe: returns empty array if parsing fails.
 * 
 * Lock: §18.3 Agent execution guidance - prompt-based requirement injection
 * Related: §19 Evidence-based validation design
 * 
 * @param criteria - ValidationCriteria from workflow step (optional)
 * @returns Array of human-readable requirement strings (max 5)
 */
export function extractValidationRequirements(
  criteria: ValidationCriteria | undefined
): readonly string[] {
  if (!criteria) return [];
  
  try {
    const requirements = extractRequirementsRecursive(criteria);
    return requirements.slice(0, 5); // Cap at 5 to prevent prompt bloat
  } catch {
    // Fail-safe: if extraction fails, return empty (don't break prompt rendering)
    return [];
  }
}

/**
 * Recursive extraction helper (handles compositions).
 * Not exported - internal implementation detail.
 */
function extractRequirementsRecursive(criteria: ValidationCriteria): readonly string[] {
  // Handle single rule
  if (isValidationRule(criteria)) {
    const formatted = formatRule(criteria);
    return formatted ? [formatted] : [];
  }
  
  // Handle compositions
  if (isValidationComposition(criteria)) {
    // and: flatten all sub-requirements
    if (criteria.and) {
      return criteria.and.flatMap(extractRequirementsRecursive);
    }
    
    // or: currently skip (complex to explain in prompt)
    // not: currently skip (complex to explain in prompt)
    // Future: could add support with clear phrasing like "Must NOT contain X"
  }
  
  return [];
}

/**
 * Format a single ValidationRule into human-readable requirement text.
 */
function formatRule(rule: ValidationRule): string | null {
  switch (rule.type) {
    case 'contains':
      if (!rule.value) return null;
      return `Must contain: "${rule.value}"`;
      
    case 'regex': {
      if (!rule.pattern) return null;
      const flags = rule.flags ? ` (flags: ${rule.flags})` : '';
      return `Must match pattern: ${rule.pattern}${flags}`;
    }
      
    case 'length': {
      const constraints = [
        rule.min !== undefined ? `≥${rule.min} chars` : null,
        rule.max !== undefined ? `≤${rule.max} chars` : null,
      ].filter((c): c is string => c !== null);
      return constraints.length > 0 ? `Length: ${constraints.join(', ')}` : null;
    }
      
    case 'schema':
      // Schema validation is complex - skip for now (0% usage empirically)
      return null;
      
    default: {
      const _exhaustive: never = rule;
      return _exhaustive;
    }
  }
}
