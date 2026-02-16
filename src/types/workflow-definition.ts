/**
 * Workflow Definition Types
 * 
 * Pure workflow definition - exactly what's in the JSON file.
 * Validated against spec/workflow.schema.json.
 * Immutable value object.
 * 
 * This type represents the SCHEMA of a workflow file.
 * It does NOT include runtime metadata like source.
 */

import { ValidationCriteria } from './validation';

// =============================================================================
// STEP TYPES
// =============================================================================

/**
 * Output contract for typed artifact validation.
 * When specified, step output must include artifacts matching the contract.
 * 
 * Lock: §19 Evidence-based validation - typed artifacts over prose validation
 */
export interface OutputContract {
  /** Reference to the artifact contract (e.g., 'wr.contracts.loop_control') */
  readonly contractRef: string;
  /** Whether the artifact is required (default: true) */
  readonly required?: boolean;
}

export interface WorkflowStepDefinition {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly agentRole?: string;
  readonly guidance?: readonly string[];
  readonly askForFiles?: boolean;
  readonly requireConfirmation?: boolean;
  readonly runCondition?: Readonly<Record<string, unknown>>;
  /** 
   * @deprecated Use outputContract for typed artifact validation instead.
   * validationCriteria will be removed once workflows are migrated.
   */
  readonly validationCriteria?: ValidationCriteria;
  /** 
   * Output contract for typed artifact validation.
   * Replaces validationCriteria with machine-checkable artifacts.
   */
  readonly outputContract?: OutputContract;
  readonly functionDefinitions?: readonly FunctionDefinition[];
  readonly functionCalls?: readonly FunctionCall[];
  readonly functionReferences?: readonly string[];
}

export interface LoopStepDefinition extends WorkflowStepDefinition {
  readonly type: 'loop';
  readonly loop: LoopConfigDefinition;
  readonly body: string | readonly WorkflowStepDefinition[];
}

/**
 * Loop condition source: discriminated union controlling how loop
 * continuation is determined.
 * 
 * Lock: §9 Loops authoring — "while loop continuation MUST NOT be controlled
 * by mutable ad-hoc context keys." New workflows MUST use 'artifact_contract'.
 * Legacy workflows auto-derive 'context_variable' during compilation.
 * 
 * Why closed: exhaustive switch in interpreter prevents silent fallback chains.
 */
export type LoopConditionSource =
  | { readonly kind: 'artifact_contract'; readonly contractRef: string; readonly loopId: string }
  | { readonly kind: 'context_variable'; readonly condition: Readonly<Record<string, unknown>> };

export interface LoopConfigDefinition {
  readonly type: 'while' | 'until' | 'for' | 'forEach';
  readonly condition?: Readonly<Record<string, unknown>>;
  /**
   * Explicit condition source for while/until loops.
   * When present, the interpreter uses this instead of the implicit
   * condition + context fallback chain.
   * 
   * Derived automatically by the compiler when absent:
   * - Step has outputContract → artifact_contract
   * - Step has condition only → context_variable (deprecated)
   */
  readonly conditionSource?: LoopConditionSource;
  readonly items?: string;
  readonly count?: number | string;
  readonly maxIterations: number;
  readonly iterationVar?: string;
  readonly itemVar?: string;
  readonly indexVar?: string;
}

// =============================================================================
// FUNCTION TYPES
// =============================================================================

export interface FunctionParameter {
  readonly name: string;
  readonly type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  readonly required?: boolean;
  readonly description?: string;
  readonly enum?: readonly (string | number | boolean)[];
  readonly default?: unknown;
}

export interface FunctionDefinition {
  readonly name: string;
  readonly definition: string;
  readonly parameters?: readonly FunctionParameter[];
  readonly scope?: 'workflow' | 'loop' | 'step';
}

export interface FunctionCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

// =============================================================================
// WORKFLOW DEFINITION
// =============================================================================

/**
 * Pure workflow definition - exactly what's stored in JSON files.
 * 
 * This is a VALUE OBJECT:
 * - Immutable (all fields readonly)
 * - No runtime state
 * - Defined entirely by its fields
 * - Can be serialized/deserialized without loss
 */
export interface WorkflowDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly steps: readonly (WorkflowStepDefinition | LoopStepDefinition)[];
  readonly preconditions?: readonly string[];
  readonly clarificationPrompts?: readonly string[];
  readonly metaGuidance?: readonly string[];
  readonly functionDefinitions?: readonly FunctionDefinition[];
}

// =============================================================================
// TYPE GUARDS
// =============================================================================

export function isLoopStepDefinition(
  step: WorkflowStepDefinition | LoopStepDefinition
): step is LoopStepDefinition {
  return 'type' in step && step.type === 'loop';
}

export function isWorkflowStepDefinition(
  step: WorkflowStepDefinition | LoopStepDefinition
): step is WorkflowStepDefinition {
  return !isLoopStepDefinition(step);
}

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

/**
 * Check if an object has the shape of a WorkflowDefinition.
 * This is a structural check, not schema validation.
 */
export function hasWorkflowDefinitionShape(obj: unknown): obj is WorkflowDefinition {
  if (!obj || typeof obj !== 'object') return false;
  
  const candidate = obj as Record<string, unknown>;
  
  return (
    typeof candidate['id'] === 'string' &&
    typeof candidate['name'] === 'string' &&
    typeof candidate['description'] === 'string' &&
    typeof candidate['version'] === 'string' &&
    Array.isArray(candidate['steps']) &&
    candidate['steps'].length > 0
  );
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

/**
 * Create an immutable WorkflowDefinition with deep freezing.
 * Enforces immutability at runtime to match the readonly type.
 */
export function createWorkflowDefinition(
  definition: WorkflowDefinition
): WorkflowDefinition {
  return Object.freeze({
    ...definition,
    steps: Object.freeze(definition.steps.map(step => Object.freeze({ ...step }))),
    preconditions: definition.preconditions ? Object.freeze([...definition.preconditions]) : undefined,
    clarificationPrompts: definition.clarificationPrompts ? Object.freeze([...definition.clarificationPrompts]) : undefined,
    metaGuidance: definition.metaGuidance ? Object.freeze([...definition.metaGuidance]) : undefined,
    functionDefinitions: definition.functionDefinitions ? Object.freeze([...definition.functionDefinitions]) : undefined,
  }) as WorkflowDefinition;
}
