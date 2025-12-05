/**
 * Data Normalizer
 * 
 * Normalizes diverse data structures from different workflows into consistent formats.
 * Handles field name variations, data type inference, and structure reconstruction.
 */

import { intentAnalyzer } from './intent-analyzer.js';
import { schemaRegistry } from './schema-registry.js';

export class DataNormalizer {
  constructor() {
    this.intentAnalyzer = intentAnalyzer;
    this.schemaRegistry = schemaRegistry;
    
    // Common field name mappings
    this.fieldAliases = {
      'bugSummary': ['bug_summary', 'Bug Summary', 'bug-summary', 'bugSummary', 'bug summary'],
      'hypotheses': ['hypotheses', 'hypothesis', 'theories', 'guesses', 'assumptions'],
      'confidence': ['confidence', 'certainty', 'likelihood', 'probability', 'score'],
      'timeline': ['timeline', 'history', 'events', 'log', 'activity'],
      'phases': ['phases', 'steps', 'stages', 'milestones'],
      'recommendations': ['recommendations', 'suggestions', 'next_steps', 'nextSteps', 'actions'],
      'rootCause': ['rootCause', 'root_cause', 'root cause', 'cause', 'origin']
    };
  }
  
  /**
   * Normalize field names to canonical format
   * Converts: "Bug Summary", "bug_summary", "bug-summary" → "bugSummary"
   * @param {string} key - Field name to normalize
   * @returns {string} Normalized field name
   */
  normalizeKey(key) {
    try {
      if (!key || typeof key !== 'string') return key;
      
      const lower = key.toLowerCase().replace(/[_\s-]+/g, '');
      
      // Check for known aliases
      for (const [canonical, aliases] of Object.entries(this.fieldAliases)) {
        const aliasesLower = aliases.map(a => a.toLowerCase().replace(/[_\s-]+/g, ''));
        if (aliasesLower.includes(lower)) {
          return canonical;
        }
      }
      
      // Convert to camelCase
      return key
        .replace(/[_\s-]+(.)?/g, (_, char) => char ? char.toUpperCase() : '')
        .replace(/^[A-Z]/, char => char.toLowerCase());
        
    } catch (error) {
      console.error('Error normalizing key:', error);
      return key;
    }
  }
  
  /**
   * Normalize entire data object (keys)
   * @param {Object} data - Data object to normalize
   * @param {boolean} deep - Whether to normalize nested objects
   * @returns {Object} Normalized data
   */
  normalizeKeys(data, deep = true) {
    try {
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return data;
      }
      
      const normalized = {};
      
      for (const [key, value] of Object.entries(data)) {
        const normalizedKey = this.normalizeKey(key);
        
        if (deep && value && typeof value === 'object' && !Array.isArray(value)) {
          normalized[normalizedKey] = this.normalizeKeys(value, deep);
        } else if (deep && Array.isArray(value)) {
          normalized[normalizedKey] = value.map(item => 
            (item && typeof item === 'object' && !Array.isArray(item)) 
              ? this.normalizeKeys(item, deep) 
              : item
          );
        } else {
          normalized[normalizedKey] = value;
        }
      }
      
      return normalized;
      
    } catch (error) {
      console.error('Error normalizing keys:', error);
      return data;
    }
  }
  
  /**
   * Reconstruct nested structures from dot-notation
   * Enhanced version with better error handling
   * @param {Object} data - Flat data with dot-notation keys
   * @returns {Object} Nested structure
   */
  reconstructNested(data) {
    try {
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return data;
      }
      
      const result = {};
      const dotKeys = [];
      
      // First pass: separate regular and dot-notation keys
      for (const key of Object.keys(data)) {
        if (typeof key === 'string' && key.includes('.') && !key.startsWith('.') && !key.endsWith('.')) {
          dotKeys.push(key);
        } else {
          result[key] = data[key];
        }
      }
      
      // Second pass: build nested structure
      for (const dotKey of dotKeys) {
        const parts = dotKey.split('.');
        let current = result;
        
        for (let i = 0; i < parts.length - 1; i++) {
          const part = parts[i];
          
          if (!current[part]) {
            current[part] = {};
          } else if (typeof current[part] !== 'object' || Array.isArray(current[part])) {
            // Can't nest into non-object, skip this key
            console.warn(`Cannot nest ${dotKey} into non-object ${part}`);
            break;
          }
          
          current = current[part];
        }
        
        // Set the final value
        const lastPart = parts[parts.length - 1];
        if (current && typeof current === 'object' && !Array.isArray(current)) {
          current[lastPart] = data[dotKey];
        }
      }
      
      return result;
      
    } catch (error) {
      console.error('Error reconstructing nested structure:', error);
      return data;
    }
  }
  
  /**
   * Infer data type for ambiguous values
   * @param {any} value - Value to analyze
   * @returns {string} Inferred type
   */
  inferType(value) {
    try {
      if (value === null) return 'null';
      if (value === undefined) return 'undefined';
      
      const baseType = typeof value;
      
      if (baseType !== 'string') {
        return baseType;
      }
      
      // String type refinement
      const str = value.trim();
      
      // Empty string
      if (str.length === 0) return 'empty-string';
      
      // Boolean-like strings
      if (/^(true|false|yes|no|on|off)$/i.test(str)) return 'boolean-string';
      
      // Number-like strings
      if (/^-?\d+$/.test(str)) return 'integer-string';
      if (/^-?\d*\.?\d+$/.test(str)) return 'float-string';
      
      // Date-like strings
      if (/^\d{4}-\d{2}-\d{2}/.test(str)) return 'date-string';
      
      // URL
      if (/^https?:\/\//i.test(str)) return 'url';
      
      // File path
      if (/[\/\\]/.test(str) && /\.\w+$/.test(str)) return 'file-path';
      
      // JSON
      if ((str.startsWith('{') && str.endsWith('}')) || (str.startsWith('[') && str.endsWith(']'))) {
        return 'json-string';
      }
      
      // Code
      if (str.includes('\n') && /[{};()]/.test(str)) return 'code';
      
      // Long text
      if (str.length > 200) return 'long-text';
      
      return 'string';
      
    } catch (error) {
      console.error('Error inferring type:', error);
      return 'unknown';
    }
  }
  
  /**
   * Clean and sanitize values
   * @param {any} value - Value to clean
   * @returns {any} Cleaned value
   */
  cleanValue(value) {
    try {
      if (value === null || value === undefined) {
        return value;
      }
      
      // String cleaning
      if (typeof value === 'string') {
        let cleaned = value.trim();
        
        // Remove zero-width characters
        cleaned = cleaned.replace(/[\u200B-\u200D\uFEFF]/g, '');
        
        // Normalize whitespace
        cleaned = cleaned.replace(/\s+/g, ' ');
        
        return cleaned;
      }
      
      // Number cleaning
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
          console.warn('Non-finite number detected:', value);
          return null;
        }
        return value;
      }
      
      // Array cleaning
      if (Array.isArray(value)) {
        return value
          .filter(item => item !== null && item !== undefined)
          .map(item => this.cleanValue(item));
      }
      
      // Object cleaning
      if (typeof value === 'object') {
        const cleaned = {};
        for (const [key, val] of Object.entries(value)) {
          // Skip null/undefined values
          if (val === null || val === undefined) {
            continue;
          }
          const cleanedVal = this.cleanValue(val);
          if (cleanedVal !== undefined && cleanedVal !== null) {
            cleaned[key] = cleanedVal;
          }
        }
        return cleaned;
      }
      
      return value;
      
    } catch (error) {
      console.error('Error cleaning value:', error);
      return value;
    }
  }
  
  /**
   * Extract metadata from data structure
   * @param {Object} data - Data to analyze
   * @returns {Object} Metadata object
   */
  extractMetadata(data) {
    try {
      if (!data || typeof data !== 'object') {
        return {};
      }
      
      const metadata = {
        fieldCount: 0,
        hasTimeline: false,
        hasPhases: false,
        hasHypotheses: false,
        hasConfidence: false,
        hasProgress: false,
        arrayFields: [],
        objectFields: [],
        primitiveFields: []
      };
      
      const analyze = (obj, path = '') => {
        for (const [key, value] of Object.entries(obj)) {
          const fullPath = path ? `${path}.${key}` : key;
          metadata.fieldCount++;
          
          // Check for known patterns
          const normalizedKey = this.normalizeKey(key);
          if (normalizedKey === 'timeline') metadata.hasTimeline = true;
          if (normalizedKey === 'phases') metadata.hasPhases = true;
          if (normalizedKey === 'hypotheses') metadata.hasHypotheses = true;
          if (normalizedKey === 'confidence') metadata.hasConfidence = true;
          if (normalizedKey === 'progress') metadata.hasProgress = true;
          
          // Track field types
          if (Array.isArray(value)) {
            metadata.arrayFields.push(fullPath);
          } else if (value && typeof value === 'object') {
            metadata.objectFields.push(fullPath);
          } else {
            metadata.primitiveFields.push(fullPath);
          }
        }
      };
      
      analyze(data);
      
      return metadata;
      
    } catch (error) {
      console.error('Error extracting metadata:', error);
      return {};
    }
  }
  
  /**
   * Validate data structure with optional schema validation
   * @param {Object} data - Data to validate
   * @param {string} workflowType - Optional workflow type for schema validation
   * @returns {Object} Validation result with errors and warnings
   */
  validateStructure(data, workflowType = null) {
    const result = {
      valid: true,
      errors: [],
      warnings: []
    };
    
    try {
      if (!data) {
        result.valid = false;
        result.errors.push('Data is null or undefined');
        return result;
      }
      
      if (typeof data !== 'object' || Array.isArray(data)) {
        result.valid = false;
        result.errors.push('Data must be an object, not ' + typeof data);
        return result;
      }
      
      // Check for circular references
      try {
        JSON.stringify(data);
      } catch (e) {
        result.valid = false;
        result.errors.push('Data contains circular references');
      }
      
      // Check for empty object
      if (Object.keys(data).length === 0) {
        result.warnings.push('Data object is empty');
      }
      
      // Check for dashboard field
      if (!data.dashboard) {
        result.warnings.push('No dashboard field found - hero section will not be rendered');
      }
      
      // Check dashboard structure if present
      if (data.dashboard) {
        if (typeof data.dashboard !== 'object' || Array.isArray(data.dashboard)) {
          result.errors.push('dashboard field must be an object');
          result.valid = false;
        } else {
          if (!data.dashboard.title) {
            result.warnings.push('dashboard.title is missing');
          }
        }
      }
      
      // Check for malformed arrays
      for (const [key, value] of Object.entries(data)) {
        if (Array.isArray(value)) {
          const nullCount = value.filter(item => item === null || item === undefined).length;
          if (nullCount > 0) {
            result.warnings.push(`Array field "${key}" contains ${nullCount} null/undefined items`);
          }
          
          if (value.length === 0) {
            result.warnings.push(`Array field "${key}" is empty`);
          }
        }
      }
      
      // Schema validation if workflow type provided
      if (workflowType && this.schemaRegistry.has(workflowType)) {
        const schemaResult = this.schemaRegistry.validate(data, workflowType);
        
        // Merge schema validation results
        result.errors.push(...schemaResult.errors.map(e => e.message || e));
        result.warnings.push(...schemaResult.warnings);
        result.valid = result.valid && schemaResult.valid;
        
        // Store detailed schema errors for inspection
        result.schemaErrors = schemaResult.errors;
      }
      
      return result;
      
    } catch (error) {
      console.error('Error validating structure:', error);
      result.valid = false;
      result.errors.push(`Validation error: ${error.message}`);
      return result;
    }
  }
  
  /**
   * Normalize entire session data
   * Complete pipeline: clean → reconstruct → normalize keys → intent analysis → schema validation
   * @param {Object} data - Raw session data
   * @param {Object} options - Normalization options
   * @returns {Object} Fully normalized data
   */
  normalize(data, options = {}) {
    const {
      cleanValues = true,
      reconstructNested = true,
      normalizeKeys = false, // Off by default to preserve exact field names
      validate = true,
      analyzeIntent = true,  // Analyze field intent and provide suggestions
      workflowType = null    // Optional workflow type for schema validation
    } = options;
    
    try {
      // Handle null/undefined data early
      if (data === null || data === undefined) {
        if (validate) {
          const validation = this.validateStructure(data, workflowType);
          if (!validation.valid) {
            console.error('Data validation failed:', validation.errors);
          }
        }
        return {};
      }
      
      let normalized = data;
      
      // Validate (includes schema validation if workflowType provided)
      if (validate) {
        const validation = this.validateStructure(normalized, workflowType);
        if (!validation.valid) {
          console.error('Data validation failed:', validation.errors);
          if (validation.schemaErrors && validation.schemaErrors.length > 0) {
            console.group('Schema Validation Details:');
            validation.schemaErrors.forEach(err => {
              console.error(`  ${err.path}: ${err.message}`);
            });
            console.groupEnd();
          }
        }
        if (validation.warnings.length > 0) {
          console.warn('Data validation warnings:', validation.warnings);
        }
      }
      
      // Clean values
      if (cleanValues) {
        normalized = this.cleanValue(normalized);
      }
      
      // Reconstruct nested structures
      if (reconstructNested) {
        normalized = this.reconstructNested(normalized);
      }
      
      // Normalize keys (optional)
      if (normalizeKeys) {
        normalized = this.normalizeKeys(normalized, true);
      }
      
      // Analyze intent and provide suggestions (non-destructive)
      if (analyzeIntent) {
        this.analyzeAndSuggest(normalized);
      }
      
      return normalized;
      
    } catch (error) {
      console.error('Error in normalization pipeline:', error);
      return data ?? {}; // Return original on error, or empty object if null/undefined
    }
  }
  
  /**
   * Analyze field intent and log helpful suggestions
   * @param {Object} data - Data to analyze
   */
  analyzeAndSuggest(data) {
    try {
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return;
      }
      
      const suggestions = this.intentAnalyzer.getSuggestions(data);
      
      if (suggestions.length > 0) {
        console.group('%c💡 Dashboard Field Suggestions', 'color: #8b5cf6; font-weight: bold;');
        console.log('The dashboard can better understand these fields if renamed:');
        console.log('');
        
        for (const suggestion of suggestions) {
          console.log(`  • ${suggestion.field} → ${suggestion.canonical}`);
          console.log(`    Confidence: ${Math.round(suggestion.confidence * 100)}%`);
        }
        
        console.log('');
        console.log('These are suggestions only - your current fields will work fine!');
        console.groupEnd();
      }
    } catch (error) {
      console.warn('Error analyzing intent:', error);
    }
  }
}

