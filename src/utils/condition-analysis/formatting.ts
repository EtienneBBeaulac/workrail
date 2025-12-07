/**
 * Condition guidance formatting functions.
 * 
 * Pure functions that transform diagnoses into human-readable guidance.
 * All functions are side-effect free: Diagnosis → Formatted String
 */

import { 
  ConditionDiagnosis, 
  BlockedStepInfo,
  MissingVariableDiagnosis,
  WrongValueDiagnosis,
  WrongTypeDiagnosis,
  AndCompositionDiagnosis,
  OrCompositionDiagnosis,
  NotCompositionDiagnosis,
  EvaluationErrorDiagnosis
} from './types';
import { WorkflowGuidance } from '../../types/mcp-types';

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Build comprehensive guidance message for blocked steps.
 * 
 * Pure function that transforms blocked step info into actionable guidance
 * for agents to understand and fix condition failures.
 * 
 * @param blockedSteps - Array of blocked steps with diagnoses
 * @returns Guidance message with explanations and fixes, or null if no blocked steps
 * 
 * @example
 * const blocked = [{
 *   stepId: 'step-1',
 *   diagnosis: { type: 'missing-variable', variable: 'mode', ... }
 * }];
 * const guidance = buildConditionGuidance(blocked);
 * // Returns formatted message with fixes
 */
export function buildConditionGuidance(
  blockedSteps: BlockedStepInfo[]
): WorkflowGuidance | null {
  if (blockedSteps.length === 0) {
    return null;
  }
  
  const sections: string[] = [];
  
  // Header
  sections.push(buildHeader(blockedSteps.length));
  sections.push('');
  
  // Each blocked step
  blockedSteps.forEach((step, index) => {
    if (index > 0) sections.push('');  // Spacing between steps
    sections.push(formatBlockedStep(step));
  });
  
  // Quick fix suggestions
  const suggestions = buildQuickFixSuggestions(blockedSteps);
  if (suggestions) {
    sections.push('');
    sections.push(suggestions);
  }
  
  return {
    prompt: sections.join('\n')
  };
}

/**
 * Format a single blocked step with diagnosis.
 * Public for use in debugging/logging.
 */
export function formatBlockedStep(step: BlockedStepInfo): string {
  const lines: string[] = [];
  
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`STEP: ${step.stepId}`);
  lines.push(`Title: ${step.stepTitle}`);
  lines.push('');
  
  const diagnosisText = formatDiagnosis(step.diagnosis);
  lines.push(diagnosisText);
  
  return lines.join('\n');
}

/**
 * Format diagnosis based on type.
 * Public for use in other contexts (CLI, web UI, etc.).
 */
export function formatDiagnosis(diagnosis: ConditionDiagnosis): string {
  switch (diagnosis.type) {
    case 'match':
      return '✅ Condition met';
    
    case 'missing-variable':
      return formatMissingVariable(diagnosis);
    
    case 'wrong-value':
      return formatWrongValue(diagnosis);
    
    case 'wrong-type':
      return formatWrongType(diagnosis);
    
    case 'and-composition':
      return formatAndComposition(diagnosis);
    
    case 'or-composition':
      return formatOrComposition(diagnosis);
    
    case 'not-composition':
      return formatNotComposition(diagnosis);
    
    case 'evaluation-error':
      return formatEvaluationError(diagnosis);
  }
}

// =============================================================================
// DIAGNOSIS FORMATTERS
// =============================================================================

function formatMissingVariable(
  d: MissingVariableDiagnosis
): string {
  const expectedStr = d.expectedValues.join(' or ');
  
  return [
    '❌ Missing Required Variable',
    `   Variable: ${d.variable}`,
    `   Expected: ${expectedStr}`,
    `   Current:  undefined`,
    `   `,
    `   Fix: Set ${d.variable} = ${d.expectedValues[0]}`
  ].join('\n');
}

function formatWrongValue(
  d: WrongValueDiagnosis
): string {
  const lines = [
    '❌ Incorrect Value',
    `   Variable: ${d.variable}`,
    `   Expected: ${formatValue(d.expected)}`,
    `   Current:  ${formatValue(d.current)}`,
    `   Operator: ${d.operator}`
  ];
  
  if (d.hint) {
    lines.push(`   `,`   Note: ${d.hint}`);
  }
  
  lines.push(`   `, `   Fix: Set ${d.variable} = ${formatValue(d.expected)}`);
  
  return lines.join('\n');
}

function formatWrongType(
  d: WrongTypeDiagnosis
): string {
  return [
    '❌ Type Mismatch',
    `   Variable: ${d.variable}`,
    `   Expected Type: ${d.expectedType}`,
    `   Current Type:  ${d.currentType}`,
    `   Current Value: ${formatValue((undefined as any))}`,
    `   Operator: ${d.operator}`,
    `   `,
    `   Fix: Ensure ${d.variable} is a ${d.expectedType}`
  ].join('\n');
}

function formatAndComposition(
  d: AndCompositionDiagnosis
): string {
  const lines: string[] = [];
  
  lines.push('❌ Composite Condition (AND)');
  lines.push(`   ${d.description}`);
  lines.push('   ');
  lines.push(`   All ${d.totalConditions} conditions must pass:`);
  
  d.failures.forEach((failure, index) => {
    const formatted = formatDiagnosis(failure);
    const indented = formatted
      .split('\n')
      .map((line, lineIndex) => {
        if (lineIndex === 0) return `   ${index + 1}. ${line}`;
        return `      ${line}`;
      })
      .join('\n');
    lines.push(indented);
  });
  
  return lines.join('\n');
}

function formatOrComposition(
  d: OrCompositionDiagnosis
): string {
  const lines: string[] = [];
  
  lines.push('❌ Composite Condition (OR)');
  lines.push(`   ${d.description}`);
  lines.push('   ');
  lines.push(`   To enable this step, satisfy ANY ONE of these options:`);
  lines.push('   ');
  
  d.failures.forEach((failure, index) => {
    const summary = summarizeRequirement(failure);
    lines.push(`   OPTION ${index + 1}: ${summary}`);
    
    // Show details for complex failures
    if (failure.type === 'and-composition') {
      const formatted = formatDiagnosis(failure);
      const indented = formatted
        .split('\n')
        .map(line => `      ${line}`)
        .join('\n');
      lines.push(indented);
    }
  });
  
  return lines.join('\n');
}

function formatNotComposition(
  d: NotCompositionDiagnosis
): string {
  const lines: string[] = [];
  
  lines.push('❌ Negated Condition (NOT)');
  lines.push(`   ${d.description}`);
  lines.push('   ');
  lines.push('   The following condition should be FALSE but is TRUE:');
  
  const formatted = formatDiagnosis(d.negatedDiagnosis);
  const indented = formatted.split('\n').map(line => `   ${line}`).join('\n');
  lines.push(indented);
  
  return lines.join('\n');
}

function formatEvaluationError(
  d: EvaluationErrorDiagnosis
): string {
  return [
    '❌ Condition Evaluation Error',
    `   Error: ${d.error}`,
    `   `,
    `   The condition has a syntax error or invalid pattern.`,
    `   Check the workflow definition.`
  ].join('\n');
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function buildHeader(count: number): string {
  const plural = count === 1 ? 'step is' : 'steps are';
  return `No eligible step found. ${count} conditional ${plural} blocked:`;
}

function buildQuickFixSuggestions(blockedSteps: BlockedStepInfo[]): string | null {
  const fixes: string[] = [];
  
  // Collect quick fixes from simple failures
  blockedSteps.forEach((step, index) => {
    const fix = getQuickFix(step);
    if (fix) {
      fixes.push(`${index + 1}. ${fix}`);
    }
  });
  
  if (fixes.length === 0) {
    return null;
  }
  
  return [
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'QUICK FIXES (choose one):',
    ...fixes
  ].join('\n');
}

function getQuickFix(step: BlockedStepInfo): string | null {
  const d = step.diagnosis;
  
  switch (d.type) {
    case 'missing-variable':
      return `Set ${d.variable} = ${d.expectedValues[0]} → Enables "${step.stepTitle}"`;
    
    case 'wrong-value':
      return `Change ${d.variable} from ${formatValue(d.current)} to ${formatValue(d.expected)} → Enables "${step.stepTitle}"`;
    
    case 'wrong-type':
      return `Fix ${d.variable} type (currently ${d.currentType}, needs ${d.expectedType}) → Enables "${step.stepTitle}"`;
    
    case 'or-composition':
      // For OR, show first simple option
      const firstSimple = d.failures.find(f => f.type === 'missing-variable' || f.type === 'wrong-value');
      if (firstSimple) {
        const summary = summarizeRequirement(firstSimple);
        return `${summary} → Enables "${step.stepTitle}"`;
      }
      return null;
    
    default:
      return null;
  }
}

/**
 * Summarize a requirement in one line (for OR options).
 */
function summarizeRequirement(diagnosis: ConditionDiagnosis): string {
  switch (diagnosis.type) {
    case 'missing-variable':
      return `Set ${diagnosis.variable} = ${diagnosis.expectedValues[0]}`;
    
    case 'wrong-value':
      return `Set ${diagnosis.variable} = ${formatValue(diagnosis.expected)}`;
    
    case 'wrong-type':
      return `Fix ${diagnosis.variable} type (needs ${diagnosis.expectedType})`;
    
    case 'and-composition':
      const summaries = diagnosis.failures.map(summarizeRequirement);
      return summaries.join(' AND ');
    
    default:
      return '(complex condition)';
  }
}

function formatValue(value: any): string {
  if (typeof value === 'string') return `"${value}"`;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  return String(value);
}
