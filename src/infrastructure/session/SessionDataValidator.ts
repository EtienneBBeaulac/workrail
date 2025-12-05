import { singleton } from 'tsyringe';

/**
 * SessionDataValidator
 * 
 * Validates normalized session data against workflow-specific schemas.
 * Returns structured warnings (never throws errors) to maintain system availability.
 * 
 * Philosophy:
 * - Validate critical invariants (required fields, types, ranges)
 * - Return actionable warnings, not cryptic errors
 * - Never block the workflow - log and continue
 */

export interface ValidationWarning {
  field: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  actual?: any;
  expected?: string;
}

export interface ValidationResult {
  valid: boolean;
  warnings: ValidationWarning[];
  errors: ValidationWarning[];
  metadata: {
    validatedAt: string;
    workflowId: string;
    sessionId?: string;
  };
}

@singleton()
export class SessionDataValidator {
  /**
   * Validate entire session data for a specific workflow
   */
  validate(workflowId: string, data: any, sessionId?: string): ValidationResult {
    const warnings: ValidationWarning[] = [];

    // Workflow-specific validation
    switch (workflowId) {
      case 'bug-investigation':
      case 'systematic-bug-investigation-with-loops':
        this.validateBugInvestigation(data, warnings);
        break;
      
      default:
        // Generic validation for unknown workflows
        this.validateGeneric(data, warnings);
    }

    const errors = warnings.filter(w => w.severity === 'error');

    return {
      valid: errors.length === 0,
      warnings,
      errors,
      metadata: {
        validatedAt: new Date().toISOString(),
        workflowId,
        sessionId
      }
    };
  }

  /**
   * Validate bug investigation workflow data
   */
  private validateBugInvestigation(data: any, warnings: ValidationWarning[]): void {
    // Dashboard validation
    if (data.dashboard) {
      this.validateDashboard(data.dashboard, warnings);
    } else {
      warnings.push({
        field: 'dashboard',
        severity: 'warning',
        message: 'Missing dashboard metadata - progress tracking unavailable'
      });
    }

    // Root cause validation (if investigation is complete)
    if (data.dashboard?.status === 'complete') {
      if (!data.rootCause) {
        warnings.push({
          field: 'rootCause',
          severity: 'error',
          message: 'Investigation marked complete but no root cause provided',
          expected: 'rootCause object with identified, location, description, confidence'
        });
      } else {
        this.validateRootCause(data.rootCause, warnings);
      }

      // Fix validation (recommended but not required)
      if (!data.fix) {
        warnings.push({
          field: 'fix',
          severity: 'warning',
          message: 'No fix/recommendation provided for completed investigation'
        });
      }
    }

    // Ruled out items validation
    if (data.ruledOut && Array.isArray(data.ruledOut)) {
      data.ruledOut.forEach((item: any, index: number) => {
        this.validateRuledOutItem(item, warnings, index);
      });
    }

    // Hypotheses validation
    if (data.hypotheses && Array.isArray(data.hypotheses)) {
      data.hypotheses.forEach((item: any, index: number) => {
        this.validateHypothesis(item, warnings, index);
      });
    }

    // Timeline validation (optional but if present, validate structure)
    if (data.timeline) {
      if (!Array.isArray(data.timeline)) {
        warnings.push({
          field: 'timeline',
          severity: 'warning',
          message: 'Timeline should be an array',
          actual: typeof data.timeline,
          expected: 'array'
        });
      }
    }
  }

  /**
   * Generic validation for unknown workflows
   */
  private validateGeneric(data: any, warnings: ValidationWarning[]): void {
    if (!data || typeof data !== 'object') {
      warnings.push({
        field: 'root',
        severity: 'error',
        message: 'Session data must be an object',
        actual: typeof data,
        expected: 'object'
      });
    }

    // Just basic sanity checks for unknown workflows
    if (Object.keys(data).length === 0) {
      warnings.push({
        field: 'root',
        severity: 'warning',
        message: 'Session data is empty'
      });
    }
  }

  /**
   * Validate dashboard metadata
   */
  private validateDashboard(dashboard: any, warnings: ValidationWarning[]): void {
    // Required fields
    this.validateRequired(dashboard, 'status', 'dashboard', warnings);
    this.validateRequired(dashboard, 'progress', 'dashboard', warnings);
    this.validateRequired(dashboard, 'confidence', 'dashboard', warnings);

    // Type validation
    if (dashboard.status && typeof dashboard.status !== 'string') {
      warnings.push({
        field: 'dashboard.status',
        severity: 'error',
        message: 'Status must be a string',
        actual: typeof dashboard.status,
        expected: 'string'
      });
    }

    // Range validation
    if (dashboard.progress !== undefined) {
      if (typeof dashboard.progress !== 'number') {
        warnings.push({
          field: 'dashboard.progress',
          severity: 'error',
          message: 'Progress must be a number',
          actual: typeof dashboard.progress,
          expected: 'number'
        });
      } else if (dashboard.progress < 0 || dashboard.progress > 100) {
        warnings.push({
          field: 'dashboard.progress',
          severity: 'warning',
          message: 'Progress should be between 0 and 100',
          actual: dashboard.progress,
          expected: '0-100'
        });
      }
    }

    if (dashboard.confidence !== undefined) {
      if (typeof dashboard.confidence !== 'number') {
        warnings.push({
          field: 'dashboard.confidence',
          severity: 'error',
          message: 'Confidence must be a number',
          actual: typeof dashboard.confidence,
          expected: 'number'
        });
      } else if (dashboard.confidence < 0 || dashboard.confidence > 10) {
        warnings.push({
          field: 'dashboard.confidence',
          severity: 'warning',
          message: 'Confidence should be between 0 and 10',
          actual: dashboard.confidence,
          expected: '0-10'
        });
      }
    }

    // Enum validation
    const validStatuses = ['in_progress', 'complete', 'blocked'];
    if (dashboard.status && !validStatuses.includes(dashboard.status)) {
      warnings.push({
        field: 'dashboard.status',
        severity: 'warning',
        message: 'Status should be one of: ' + validStatuses.join(', '),
        actual: dashboard.status,
        expected: validStatuses.join(' | ')
      });
    }
  }

  /**
   * Validate root cause object
   */
  private validateRootCause(rootCause: any, warnings: ValidationWarning[]): void {
    // Required fields for complete investigation
    this.validateRequired(rootCause, 'identified', 'rootCause', warnings);
    this.validateRequired(rootCause, 'location', 'rootCause', warnings);
    this.validateRequired(rootCause, 'description', 'rootCause', warnings);
    this.validateRequired(rootCause, 'confidence', 'rootCause', warnings);

    // Type validation
    if (rootCause.identified !== undefined && typeof rootCause.identified !== 'boolean') {
      warnings.push({
        field: 'rootCause.identified',
        severity: 'error',
        message: 'identified must be a boolean',
        actual: typeof rootCause.identified,
        expected: 'boolean'
      });
    }

    if (rootCause.location && typeof rootCause.location !== 'string') {
      warnings.push({
        field: 'rootCause.location',
        severity: 'error',
        message: 'location must be a string',
        actual: typeof rootCause.location,
        expected: 'string'
      });
    }

    // Confidence validation
    if (rootCause.confidence !== undefined) {
      if (typeof rootCause.confidence !== 'number') {
        warnings.push({
          field: 'rootCause.confidence',
          severity: 'error',
          message: 'confidence must be a number',
          actual: typeof rootCause.confidence,
          expected: 'number'
        });
      } else if (rootCause.confidence < 0 || rootCause.confidence > 10) {
        warnings.push({
          field: 'rootCause.confidence',
          severity: 'warning',
          message: 'confidence should be between 0 and 10',
          actual: rootCause.confidence,
          expected: '0-10'
        });
      }
    }

    // Semantic validation
    if (rootCause.description && rootCause.description.length < 10) {
      warnings.push({
        field: 'rootCause.description',
        severity: 'warning',
        message: 'Description seems very short - provide more detail',
        actual: `${rootCause.description.length} characters`
      });
    }

    if (rootCause.evidence && (!Array.isArray(rootCause.evidence) || rootCause.evidence.length === 0)) {
      warnings.push({
        field: 'rootCause.evidence',
        severity: 'info',
        message: 'No evidence provided for root cause'
      });
    }
  }

  /**
   * Validate ruled out item
   */
  private validateRuledOutItem(item: any, warnings: ValidationWarning[], index: number): void {
    const prefix = `ruledOut[${index}]`;

    this.validateRequired(item, 'title', prefix, warnings);
    this.validateRequired(item, 'reason', prefix, warnings);

    if (item.title && typeof item.title !== 'string') {
      warnings.push({
        field: `${prefix}.title`,
        severity: 'error',
        message: 'title must be a string',
        actual: typeof item.title,
        expected: 'string'
      });
    }

    if (item.reason && item.reason.length < 10) {
      warnings.push({
        field: `${prefix}.reason`,
        severity: 'warning',
        message: 'Reason seems very short - provide more detail',
        actual: `${item.reason.length} characters`
      });
    }
  }

  /**
   * Validate hypothesis
   */
  private validateHypothesis(item: any, warnings: ValidationWarning[], index: number): void {
    const prefix = `hypotheses[${index}]`;

    this.validateRequired(item, 'id', prefix, warnings);
    this.validateRequired(item, 'description', prefix, warnings);
    this.validateRequired(item, 'status', prefix, warnings);

    if (item.status) {
      const validStatuses = ['active', 'confirmed', 'ruled_out'];
      if (!validStatuses.includes(item.status)) {
        warnings.push({
          field: `${prefix}.status`,
          severity: 'warning',
          message: 'Status should be one of: ' + validStatuses.join(', '),
          actual: item.status,
          expected: validStatuses.join(' | ')
        });
      }
    }
  }

  /**
   * Helper: Check if required field exists
   */
  private validateRequired(
    obj: any, 
    field: string, 
    path: string, 
    warnings: ValidationWarning[]
  ): void {
    if (obj[field] === undefined || obj[field] === null || obj[field] === '') {
      warnings.push({
        field: `${path}.${field}`,
        severity: 'error',
        message: `Required field '${field}' is missing or empty`
      });
    }
  }
}

