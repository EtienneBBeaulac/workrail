import { singleton } from 'tsyringe';

/**
 * SessionDataNormalizer
 * 
 * Transforms flexible agent input into a strict, normalized internal schema.
 * Handles common field name variations, type conversions, and defaults.
 * 
 * Philosophy:
 * - Be liberal in what you accept (flexible field names)
 * - Be conservative in what you produce (strict normalized output)
 * - Never throw errors (always return something valid)
 */

export interface NormalizedRootCause {
  identified: boolean;
  location: string;
  description: string;
  confidence: number;
  code: string | undefined;
  mechanism: string | undefined;
  evidence: string[] | undefined;
  whyNotCaughtBefore: string | undefined;
  whyNowDiscovered: string | undefined;
}

export interface NormalizedRuledOutItem {
  id: string | null;
  title: string;
  reason: string;
  timestamp: string;
  phase: string | undefined;
}

export interface NormalizedHypothesis {
  id: string;
  description: string;
  status: 'active' | 'confirmed' | 'ruled_out';
  confidence: number | undefined;
  evidence: string[] | undefined;
}

export interface NormalizedFix {
  approach: string;
  steps: string[] | undefined;
  risks: string[] | undefined;
  testingStrategy: string | undefined;
}

export interface NormalizedDashboard {
  status: 'in_progress' | 'complete' | 'blocked';
  progress: number;
  confidence: number;
  currentPhase: string | undefined;
  currentStep: string | undefined;
  startedAt: string | undefined;
  completedAt: string | undefined;
}

@singleton()
export class SessionDataNormalizer {
  /**
   * Normalize the entire session data object
   */
  normalize(workflowId: string, data: any): any {
    if (!data || typeof data !== 'object') {
      return {};
    }

    const normalized: any = {};

    // Normalize each top-level section
    if (data.dashboard) {
      normalized.dashboard = this.normalizeDashboard(data.dashboard);
    }

    if (data.rootCause) {
      normalized.rootCause = this.normalizeRootCause(data.rootCause);
    }

    if (data.fix) {
      normalized.fix = this.normalizeFix(data.fix);
    }

    if (data.ruledOut) {
      normalized.ruledOut = this.normalizeRuledOut(data.ruledOut);
    }

    if (data.hypotheses) {
      normalized.hypotheses = this.normalizeHypotheses(data.hypotheses);
    }

    // Pass through other fields as-is (timeline, confidenceJourney, etc.)
    Object.keys(data).forEach(key => {
      if (!['dashboard', 'rootCause', 'fix', 'ruledOut', 'hypotheses'].includes(key)) {
        normalized[key] = data[key];
      }
    });

    return normalized;
  }

  /**
   * Normalize dashboard metadata
   */
  normalizeDashboard(data: any): NormalizedDashboard {
    return {
      status: this.normalizeStatus(data.status),
      progress: this.normalizeNumber(data.progress, 0, 100, 0),
      confidence: this.normalizeNumber(data.confidence, 0, 10, 0),
      currentPhase: this.normalizeString(data.currentPhase),
      currentStep: this.normalizeString(data.currentStep),
      startedAt: this.normalizeTimestamp(data.startedAt),
      completedAt: this.normalizeTimestamp(data.completedAt)
    };
  }

  /**
   * Normalize root cause object
   */
  normalizeRootCause(data: any): NormalizedRootCause {
    return {
      identified: this.normalizeBoolean(data.identified, false),
      location: this.normalizeString(
        data.location || data.file || data.path,
        'Unknown location'
      ),
      description: this.normalizeString(
        data.description || data.explanation || data.summary,
        'No description provided'
      ),
      confidence: this.normalizeNumber(data.confidence, 0, 10, 0),
      code: this.normalizeString(data.code),
      mechanism: this.normalizeString(data.mechanism),
      evidence: this.normalizeStringArray(data.evidence),
      whyNotCaughtBefore: this.normalizeString(data.whyNotCaughtBefore),
      whyNowDiscovered: this.normalizeString(data.whyNowDiscovered)
    };
  }

  /**
   * Normalize fix/recommendation object
   */
  normalizeFix(data: any): NormalizedFix {
    return {
      approach: this.normalizeString(
        data.approach || data.description || data.summary,
        'No fix approach provided'
      ),
      steps: this.normalizeStringArray(data.steps || data.actions),
      risks: this.normalizeStringArray(data.risks || data.caveats),
      testingStrategy: this.normalizeString(data.testingStrategy || data.testing)
    };
  }

  /**
   * Normalize ruled out items array
   */
  normalizeRuledOut(data: any[]): NormalizedRuledOutItem[] {
    if (!Array.isArray(data)) {
      return [];
    }

    return data.map(item => this.normalizeRuledOutItem(item));
  }

  /**
   * Normalize a single ruled out item
   */
  normalizeRuledOutItem(data: any): NormalizedRuledOutItem {
    return {
      id: data.id || data.hypothesisId || null,
      title: this.normalizeString(
        data.item || data.title || data.hypothesis,
        'Untitled Hypothesis'
      ),
      reason: this.normalizeString(data.reason, 'No reason provided'),
      timestamp: this.normalizeTimestamp(data.timestamp, new Date().toISOString()),
      phase: this.normalizeString(data.phase)
    };
  }

  /**
   * Normalize hypotheses array
   */
  normalizeHypotheses(data: any[]): NormalizedHypothesis[] {
    if (!Array.isArray(data)) {
      return [];
    }

    return data.map(item => this.normalizeHypothesis(item));
  }

  /**
   * Normalize a single hypothesis
   */
  normalizeHypothesis(data: any): NormalizedHypothesis {
    return {
      id: this.normalizeString(data.id || data.hypothesisId, 'unknown'),
      description: this.normalizeString(
        data.description || data.hypothesis || data.text,
        'No description'
      ),
      status: this.normalizeHypothesisStatus(data.status),
      confidence: data.confidence !== undefined 
        ? this.normalizeNumber(data.confidence, 0, 10, undefined)
        : undefined,
      evidence: this.normalizeStringArray(data.evidence)
    };
  }

  // ============================================
  // PRIMITIVE NORMALIZERS
  // ============================================

  /**
   * Normalize string values
   * Overload: With defaultValue, always returns string
   */
  private normalizeString(value: any, defaultValue: string): string;
  private normalizeString(value: any, defaultValue?: string): string | undefined;
  private normalizeString(value: any, defaultValue?: string): string | undefined {
    if (value === null || value === undefined) {
      return defaultValue;
    }

    if (typeof value === 'string') {
      return value.trim() || defaultValue;
    }

    // Convert to string
    return String(value) || defaultValue;
  }

  /**
   * Normalize number values with optional range clamping
   */
  private normalizeNumber(
    value: any, 
    min?: number, 
    max?: number, 
    defaultValue?: number
  ): number {
    let num: number;

    if (typeof value === 'number' && !isNaN(value)) {
      num = value;
    } else if (typeof value === 'string') {
      // Handle "85%" -> 85
      const cleaned = value.replace(/[^\d.-]/g, '');
      num = parseFloat(cleaned);
    } else {
      return defaultValue ?? 0;
    }

    // Clamp to range if specified
    if (min !== undefined && num < min) num = min;
    if (max !== undefined && num > max) num = max;

    return isNaN(num) ? (defaultValue ?? 0) : num;
  }

  /**
   * Normalize boolean values
   */
  private normalizeBoolean(value: any, defaultValue: boolean = false): boolean {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      if (lower === 'true' || lower === 'yes' || lower === '1') return true;
      if (lower === 'false' || lower === 'no' || lower === '0') return false;
    }

    if (typeof value === 'number') {
      return value !== 0;
    }

    return defaultValue;
  }

  /**
   * Normalize timestamp (ISO string)
   * Overload: With defaultValue, always returns string
   */
  private normalizeTimestamp(value: any, defaultValue: string): string;
  private normalizeTimestamp(value: any, defaultValue?: string): string | undefined;
  private normalizeTimestamp(value: any, defaultValue?: string): string | undefined {
    if (!value) {
      return defaultValue;
    }

    if (typeof value === 'string') {
      // Validate it's a valid date
      const date = new Date(value);
      if (!isNaN(date.getTime())) {
        return date.toISOString();
      }
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (typeof value === 'number') {
      // Assume unix timestamp
      return new Date(value).toISOString();
    }

    return defaultValue;
  }

  /**
   * Normalize string array
   */
  private normalizeStringArray(value: any): string[] | undefined {
    if (!value) {
      return undefined;
    }

    if (Array.isArray(value)) {
      return value
        .filter(item => item !== null && item !== undefined)
        .map(item => String(item).trim())
        .filter(item => item.length > 0);
    }

    // Single string -> array
    if (typeof value === 'string') {
      return [value.trim()].filter(s => s.length > 0);
    }

    return undefined;
  }

  /**
   * Normalize status enum
   */
  private normalizeStatus(value: any): 'in_progress' | 'complete' | 'blocked' {
    if (typeof value !== 'string') {
      return 'in_progress';
    }

    const normalized = value.toLowerCase().replace(/[_\s-]/g, '_');

    switch (normalized) {
      case 'complete':
      case 'completed':
      case 'done':
      case 'finished':
        return 'complete';
      
      case 'blocked':
      case 'stuck':
      case 'waiting':
        return 'blocked';
      
      default:
        return 'in_progress';
    }
  }

  /**
   * Normalize hypothesis status enum
   */
  private normalizeHypothesisStatus(value: any): 'active' | 'confirmed' | 'ruled_out' {
    if (typeof value !== 'string') {
      return 'active';
    }

    const normalized = value.toLowerCase().replace(/[_\s-]/g, '_');

    switch (normalized) {
      case 'confirmed':
      case 'verified':
      case 'proven':
        return 'confirmed';
      
      case 'ruled_out':
      case 'ruledout':
      case 'rejected':
      case 'disproven':
        return 'ruled_out';
      
      default:
        return 'active';
    }
  }
}

