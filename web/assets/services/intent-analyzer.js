/**
 * IntentAnalyzer
 * 
 * Analyzes data structure and field names to infer semantic intent,
 * enabling the dashboard to understand variations in field naming and structure.
 * 
 * Multi-signal analysis approach:
 * 1. Semantic - Field name meaning and synonyms
 * 2. Structural - Data type and shape
 * 3. Content - Actual values and patterns
 * 4. Contextual - Surrounding fields and workflow type
 * 5. Historical - Common patterns from past workflows (future)
 */

export class IntentAnalyzer {
  constructor() {
    this.fieldAliases = this.buildFieldAliases();
    this.semanticCategories = this.buildSemanticCategories();
  }
  
  /**
   * Build field alias mappings
   * Maps variations of field names to canonical forms
   */
  buildFieldAliases() {
    return {
      // Bug/Issue terminology
      'bug': ['issue', 'defect', 'problem', 'error', 'fault'],
      'bugSummary': ['issueSummary', 'problemDescription', 'errorDescription', 'defectSummary'],
      'rootCause': ['cause', 'reason', 'origin', 'source', 'underlying_cause'],
      'fix': ['solution', 'remedy', 'resolution', 'patch', 'correction'],
      
      // Analysis terminology
      'findings': ['issues', 'problems', 'discoveries', 'observations', 'results'],
      'hypothesis': ['theory', 'assumption', 'conjecture', 'supposition'],
      'hypotheses': ['theories', 'assumptions', 'conjectures'],
      'recommendations': ['suggestions', 'advice', 'proposals', 'actions'],
      
      // Metadata
      'summary': ['description', 'overview', 'abstract', 'synopsis'],
      'details': ['information', 'data', 'specifics', 'particulars'],
      'timeline': ['history', 'events', 'log', 'chronology', 'activity'],
      'phases': ['steps', 'stages', 'milestones', 'progression'],
      
      // Status and progress
      'status': ['state', 'condition', 'situation'],
      'progress': ['completion', 'advancement', 'percentage'],
      'confidence': ['certainty', 'likelihood', 'probability'],
      
      // Code review
      'codeReview': ['review', 'inspection', 'audit'],
      'changes': ['modifications', 'edits', 'updates', 'alterations'],
      
      // Testing
      'tests': ['testResults', 'testSuite', 'testCases'],
      'failures': ['errors', 'failed', 'broken'],
      'passes': ['passed', 'successful', 'succeeded']
    };
  }
  
  /**
   * Build semantic category mappings
   * Groups fields by their semantic purpose
   */
  buildSemanticCategories() {
    return {
      temporal: ['timestamp', 'time', 'date', 'datetime', 'created', 'updated', 'modified', 'when'],
      identification: ['id', 'identifier', 'key', 'reference', 'name', 'title'],
      severity: ['severity', 'priority', 'importance', 'criticality', 'urgency', 'level'],
      location: ['file', 'path', 'location', 'line', 'column', 'position'],
      measurement: ['count', 'total', 'number', 'quantity', 'amount', 'size'],
      quality: ['confidence', 'score', 'rating', 'quality', 'accuracy'],
      status: ['status', 'state', 'phase', 'stage', 'condition'],
      description: ['description', 'summary', 'details', 'text', 'content', 'message']
    };
  }
  
  /**
   * Normalize field name to canonical form
   * Handles camelCase, snake_case, kebab-case, and spaces
   */
  normalizeFieldName(fieldName) {
    if (!fieldName || typeof fieldName !== 'string') return '';
    
    // Convert to lowercase and remove special characters
    let normalized = fieldName
      .toLowerCase()
      .replace(/[-_\s]+/g, '')  // Remove separators
      .replace(/[^a-z0-9]/g, '');  // Remove non-alphanumeric
    
    return normalized;
  }
  
  /**
   * Find canonical field name from alias
   */
  findCanonicalName(fieldName) {
    const normalized = this.normalizeFieldName(fieldName);
    
    // Check if it's already canonical
    if (this.fieldAliases[fieldName]) {
      return fieldName;
    }
    
    // Search through aliases
    for (const [canonical, aliases] of Object.entries(this.fieldAliases)) {
      const canonicalNorm = this.normalizeFieldName(canonical);
      
      // Check if normalized names match
      if (normalized === canonicalNorm) {
        return canonical;
      }
      
      // Check aliases
      for (const alias of aliases) {
        const aliasNorm = this.normalizeFieldName(alias);
        if (normalized === aliasNorm) {
          return canonical;
        }
      }
    }
    
    return null;
  }
  
  /**
   * Calculate similarity between two strings (Levenshtein distance based)
   */
  calculateSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    
    const s1 = str1.toLowerCase();
    const s2 = str2.toLowerCase();
    
    if (s1 === s2) return 1;
    
    // Quick substring check
    if (s1.includes(s2) || s2.includes(s1)) {
      return 0.8;
    }
    
    // Levenshtein distance
    const len1 = s1.length;
    const len2 = s2.length;
    const matrix = [];
    
    for (let i = 0; i <= len1; i++) {
      matrix[i] = [i];
    }
    
    for (let j = 0; j <= len2; j++) {
      matrix[0][j] = j;
    }
    
    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        if (s1[i - 1] === s2[j - 1]) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,  // substitution
            matrix[i][j - 1] + 1,       // insertion
            matrix[i - 1][j] + 1        // deletion
          );
        }
      }
    }
    
    const distance = matrix[len1][len2];
    const maxLen = Math.max(len1, len2);
    
    return 1 - (distance / maxLen);
  }
  
  /**
   * Find best matching canonical name using fuzzy matching
   */
  findBestMatch(fieldName, threshold = 0.6) {
    const normalized = this.normalizeFieldName(fieldName);
    let bestMatch = null;
    let bestScore = 0;
    
    // Check all canonical names and aliases
    for (const [canonical, aliases] of Object.entries(this.fieldAliases)) {
      // Check canonical name
      const canonicalScore = this.calculateSimilarity(normalized, this.normalizeFieldName(canonical));
      if (canonicalScore > bestScore && canonicalScore >= threshold) {
        bestScore = canonicalScore;
        bestMatch = canonical;
      }
      
      // Check aliases
      for (const alias of aliases) {
        const aliasScore = this.calculateSimilarity(normalized, this.normalizeFieldName(alias));
        if (aliasScore > bestScore && aliasScore >= threshold) {
          bestScore = aliasScore;
          bestMatch = canonical;
        }
      }
    }
    
    return bestMatch ? { canonical: bestMatch, confidence: bestScore } : null;
  }
  
  /**
   * Infer semantic category of a field
   */
  inferCategory(fieldName, value) {
    const normalized = this.normalizeFieldName(fieldName);
    
    // Check semantic categories
    for (const [category, keywords] of Object.entries(this.semanticCategories)) {
      for (const keyword of keywords) {
        if (normalized.includes(this.normalizeFieldName(keyword))) {
          return category;
        }
      }
    }
    
    // Infer from value type
    if (value !== null && value !== undefined) {
      // Temporal
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
        return 'temporal';
      }
      
      // Measurement
      if (typeof value === 'number' && !fieldName.toLowerCase().includes('id')) {
        return 'measurement';
      }
      
      // Location (file paths)
      if (typeof value === 'string' && (value.startsWith('/') || value.includes('\\'))) {
        return 'location';
      }
    }
    
    return 'description';  // Default
  }
  
  /**
   * Analyze field intent using multiple signals
   */
  analyzeIntent(fieldName, value, context = {}) {
    const analysis = {
      originalName: fieldName,
      normalizedName: this.normalizeFieldName(fieldName),
      canonical: null,
      category: null,
      confidence: 0,
      suggestions: []
    };
    
    // Signal 1: Exact match
    const canonical = this.findCanonicalName(fieldName);
    if (canonical) {
      analysis.canonical = canonical;
      analysis.confidence = 1.0;
    }
    
    // Signal 2: Fuzzy match
    if (!canonical) {
      const fuzzyMatch = this.findBestMatch(fieldName);
      if (fuzzyMatch) {
        analysis.canonical = fuzzyMatch.canonical;
        analysis.confidence = fuzzyMatch.confidence;
        analysis.suggestions.push(`Did you mean '${fuzzyMatch.canonical}'?`);
      }
    }
    
    // Signal 3: Semantic category
    analysis.category = this.inferCategory(fieldName, value);
    
    // Signal 4: Contextual inference
    if (context.workflowType) {
      analysis.workflowContext = context.workflowType;
    }
    
    // Signal 5: Structural analysis
    if (value !== null && value !== undefined) {
      analysis.valueType = typeof value;
      analysis.isArray = Array.isArray(value);
      analysis.isObject = typeof value === 'object' && !Array.isArray(value);
    }
    
    return analysis;
  }
  
  /**
   * Enhance field mapping with intent analysis
   * Returns enhanced mapping with canonical names and confidence scores
   */
  enhanceFieldMapping(data, context = {}) {
    const enhanced = {};
    
    for (const [key, value] of Object.entries(data)) {
      const intent = this.analyzeIntent(key, value, context);
      
      enhanced[key] = {
        value,
        intent,
        // Use canonical name if confidence is high enough
        suggestedKey: intent.confidence >= 0.7 ? intent.canonical : key
      };
    }
    
    return enhanced;
  }
  
  /**
   * Get suggestions for improving field names
   */
  getSuggestions(data) {
    const suggestions = [];
    
    for (const [key, value] of Object.entries(data)) {
      const intent = this.analyzeIntent(key, value);
      
      if (intent.canonical && intent.confidence < 1.0 && intent.confidence >= 0.6) {
        suggestions.push({
          field: key,
          canonical: intent.canonical,
          confidence: intent.confidence,
          message: `Consider renaming '${key}' to '${intent.canonical}' for better recognition`
        });
      }
    }
    
    return suggestions;
  }
}

// Export singleton instance
export const intentAnalyzer = new IntentAnalyzer();






