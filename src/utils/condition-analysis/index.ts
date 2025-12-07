/**
 * Condition Analysis Utilities
 * 
 * Pure functional utilities for diagnosing condition failures and
 * building actionable guidance messages for agents.
 * 
 * ARCHITECTURAL NOTE:
 * This system uses lenient comparison (case-insensitive, type-coercive)
 * to match evaluateCondition() behavior. This means:
 * - "Large" equals "large" (case doesn't matter)
 * - "10" equals 10 (string-to-number coercion)
 * - "yes"/"true"/"1" equals true (boolean coercion)
 * 
 * Diagnosis reflects ACTUAL failures under lenient comparison,
 * not what would fail under strict comparison.
 * 
 * Usage:
 * ```typescript
 * import { diagnoseConditionFailure, buildConditionGuidance } from '@/utils/condition-analysis';
 * 
 * const diagnosis = diagnoseConditionFailure(condition, context);
 * const guidance = buildConditionGuidance(blockedSteps);
 * ```
 */

// Re-export types
export type {
  ConditionDiagnosis,
  BlockedStepInfo,
  ConditionOperator,
  MissingVariableDiagnosis,
  WrongValueDiagnosis,
  WrongTypeDiagnosis,
  AndCompositionDiagnosis,
  OrCompositionDiagnosis,
  NotCompositionDiagnosis,
  EvaluationErrorDiagnosis
} from './types';

// Re-export diagnosis functions
export {
  diagnoseConditionFailure
} from './diagnosis';

// Re-export formatting functions
export {
  buildConditionGuidance,
  formatDiagnosis,
  formatBlockedStep
} from './formatting';
