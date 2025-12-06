// Workflow Schema Type Definitions
// Based on JSON Schema Draft 7 specification

import { Condition, ConditionContext } from '../utils/condition-evaluator';

// =============================================================================
// CORE WORKFLOW TYPES
// =============================================================================

export interface Workflow {
  id: string;
  name: string;
  description: string;
  version: string;
  preconditions?: string[];
  clarificationPrompts?: string[];
  steps: (WorkflowStep | LoopStep)[];
  metaGuidance?: string[];
  functionDefinitions?: FunctionDefinition[];
}

export interface WorkflowStep {
  id: string;
  title: string;
  prompt: string;
  agentRole?: string;
  guidance?: string[];
  askForFiles?: boolean;
  requireConfirmation?: boolean;
  runCondition?: object;
  functionDefinitions?: FunctionDefinition[];
  functionCalls?: FunctionCall[];
  functionReferences?: string[];
}

// Loop-related types
export interface LoopStep extends WorkflowStep {
  type: 'loop';
  loop: LoopConfig;
  body: string | WorkflowStep[];
}

export interface LoopConfig {
  type: 'while' | 'until' | 'for' | 'forEach';
  condition?: Condition; // For while/until loops
  items?: string; // Context variable name for forEach
  count?: number | string; // Number or context variable for 'for' loops
  maxIterations: number; // Safety limit
  iterationVar?: string; // Custom iteration counter name
  itemVar?: string; // Custom item variable name (forEach)
  indexVar?: string; // Custom index variable name (forEach)
}

export interface LoopState {
  [loopId: string]: {
    iteration: number;
    started: number; // timestamp
    items?: any[]; // for forEach loops
    index?: number; // current array index
    warnings?: string[]; // accumulated warnings
  };
}

// Enhanced context for loops
export interface EnhancedContext extends ConditionContext {
  _loopState?: LoopState;
  _loopStack?: LoopStackFrame[]; // ✅ NEW: Explicit loop stack
  _warnings?: {
    loops?: {
      [loopId: string]: string[];
    };
  };
  _contextSize?: number; // tracked for validation
  _currentLoop?: {
    loopId: string;
    loopStep: LoopStep;
  };
}

/**
 * Loop execution states for structured logging and observability.
 * These states are implicit in the code flow but logged explicitly for debugging.
 * 
 * Enable state logging with: WORKRAIL_LOG_LEVEL=DEBUG
 */
export enum LoopExecutionState {
  // Main execution states (in getNextStepIterative)
  RECOVERING_LOOP_STATE = 'RECOVERING_LOOP_STATE',
  IN_LOOP = 'IN_LOOP',
  FINDING_NEXT_STEP = 'FINDING_NEXT_STEP',
  ENTERING_LOOP = 'ENTERING_LOOP',
  RETURNING_STEP = 'RETURNING_STEP',
  WORKFLOW_COMPLETE = 'WORKFLOW_COMPLETE',
  
  // Loop handling states (in handleCurrentLoop)
  CHECKING_LOOP_CONDITION = 'CHECKING_LOOP_CONDITION',
  SCANNING_BODY = 'SCANNING_BODY',
  CHECKING_ELIGIBILITY = 'CHECKING_ELIGIBILITY',
  RETURNING_BODY_STEP = 'RETURNING_BODY_STEP',
  VALIDATING_ITERATION_COMPLETE = 'VALIDATING_ITERATION_COMPLETE',
  INCREMENTING_ITERATION = 'INCREMENTING_ITERATION'
}

/**
 * Represents a single frame in the loop execution stack.
 * Each frame tracks the state of an active loop.
 * 
 * IMMUTABILITY INVARIANTS:
 * 1. All fields are readonly
 * 2. Frames are frozen via Object.freeze()
 * 3. bodySteps array is frozen (ReadonlyArray)
 * 4. loopContext is mutable (manages its own state) - SHALLOW IMMUTABILITY
 * 
 * MUTATION STRATEGY:
 * - Never mutate frames directly
 * - Create new frames via smart constructors (createLoopStackFrame, etc.)
 * - Replace in stack array using replaceTopFrame()
 * 
 * WHY SHALLOW IMMUTABLE:
 * - Frame structure (loopId, bodySteps, index) is immutable
 * - Loop execution state (iteration count, timers) lives in loopContext
 * - Separates "what the loop is" (immutable) from "where it is" (mutable state)
 * 
 * The loop stack is maintained in EnhancedContext._loopStack to keep
 * the WorkflowService stateless and concurrency-safe.
 */
export interface LoopStackFrame {
  /** Unique identifier of the loop */
  readonly loopId: string;
  
  /** The loop step definition */
  readonly loopStep: LoopStep;
  
  /** 
   * Execution context for this loop (tracks iteration, evaluates conditions).
   * 
   * NOTE: This is MUTABLE - loopContext manages its own internal state.
   * The frame is "shallow immutable" - frame structure is frozen but
   * loopContext internals can change (incrementIteration, etc.).
   */
  readonly loopContext: any; // LoopExecutionContext - avoid circular dependency
  
  /** Body steps normalized to array (even for single-step bodies) */
  readonly bodySteps: ReadonlyArray<WorkflowStep>;
  
  /** 
   * Current position in body steps array (0-based).
   * Now readonly - use advanceBodyIndex/resetBodyIndex/setBodyIndex to update.
   */
  readonly currentBodyIndex: number;
}

// =============================================================================
// LOOP STACK FRAME SMART CONSTRUCTORS
// =============================================================================

/**
 * Create a new loop stack frame.
 * 
 * This is the ONLY recommended way to create frames (enforces invariants).
 * All fields are frozen to prevent accidental mutation.
 * 
 * @param loopId - Unique identifier of the loop
 * @param loopStep - The loop step definition
 * @param loopContext - Loop execution context (mutable - manages iteration state)
 * @param bodySteps - Array of body steps (will be frozen if not already)
 * @param currentBodyIndex - Starting index (default: 0)
 * @returns Frozen LoopStackFrame
 */
export function createLoopStackFrame(
  loopId: string,
  loopStep: LoopStep,
  loopContext: any,
  bodySteps: WorkflowStep[] | ReadonlyArray<WorkflowStep>,
  currentBodyIndex: number = 0
): LoopStackFrame {
  // Normalize bodySteps to frozen array
  const frozenBodySteps = Array.isArray(bodySteps) && !Object.isFrozen(bodySteps)
    ? Object.freeze([...bodySteps])
    : bodySteps as ReadonlyArray<WorkflowStep>;
  
  return Object.freeze({
    loopId,
    loopStep,
    loopContext,
    bodySteps: frozenBodySteps,
    currentBodyIndex,
  });
}

/**
 * Create a new frame with currentBodyIndex incremented by 1.
 * 
 * Use when skipping steps or advancing through body.
 * Original frame is unchanged.
 * 
 * @param frame - Original frame (unchanged)
 * @returns New frame with index + 1
 */
export function advanceBodyIndex(frame: LoopStackFrame): LoopStackFrame {
  return createLoopStackFrame(
    frame.loopId,
    frame.loopStep,
    frame.loopContext,
    frame.bodySteps,
    frame.currentBodyIndex + 1
  );
}

/**
 * Create a new frame with currentBodyIndex reset to 0.
 * 
 * Use at iteration boundaries when restarting body scan.
 * Original frame is unchanged.
 * 
 * @param frame - Original frame (unchanged)
 * @returns New frame with index = 0
 */
export function resetBodyIndex(frame: LoopStackFrame): LoopStackFrame {
  return createLoopStackFrame(
    frame.loopId,
    frame.loopStep,
    frame.loopContext,
    frame.bodySteps,
    0
  );
}

/**
 * Create a new frame with currentBodyIndex set to specific value.
 * 
 * Use during loop recovery to resume from correct position.
 * Original frame is unchanged.
 * 
 * @param frame - Original frame (unchanged)
 * @param index - New index value
 * @returns New frame with specified index
 */
export function setBodyIndex(frame: LoopStackFrame, index: number): LoopStackFrame {
  return createLoopStackFrame(
    frame.loopId,
    frame.loopStep,
    frame.loopContext,
    frame.bodySteps,
    index
  );
}

/**
 * Replace the top frame in a loop stack with a new frame.
 * Returns the new frame for local variable assignment.
 * 
 * MUTABILITY NOTE:
 * This function mutates the stack array (replaces element at top).
 * The stack itself is mutable operational state - only frames are immutable.
 * 
 * This is intentional:
 * - Stack = operational state (where we are in execution)
 * - Frames = data (what we're executing)
 * - Immutable data in mutable collections is a common pattern
 * 
 * USAGE PATTERN:
 * ```typescript
 * frame = replaceTopFrame(loopStack, advanceBodyIndex(frame));
 * ```
 * 
 * @param stack - Loop stack (WILL BE MUTATED - top frame replaced)
 * @param newFrame - New frame to place at top of stack
 * @returns The new frame (for chaining: frame = replaceTopFrame(stack, newFrame))
 * @throws {LoopStackCorruptionError} if stack is empty
 */
export function replaceTopFrame(
  stack: LoopStackFrame[], 
  newFrame: LoopStackFrame
): LoopStackFrame {
  if (stack.length === 0) {
    throw new Error('Cannot replace frame in empty stack (LoopStackCorruptionError)');
  }
  stack[stack.length - 1] = newFrame;
  return newFrame;
}

// =============================================================================
// LOOP EXECUTION RESULT TYPES
// =============================================================================

/**
 * Result type for loop handling operations.
 * Uses discriminated union for type-safe handling.
 */
export type LoopHandlerResult =
  | { type: 'step'; result: any } // StepResult - avoid circular dependency
  | { type: 'continue' }
  | { type: 'complete' };

/**
 * PHASE 1 RESULT: Should loop continue executing?
 */
export type LoopContinuationResult =
  | { type: 'continue'; iteration: number }
  | { type: 'stop'; reason: 'condition-false' | 'max-iterations'; warnings?: string[] };

/**
 * PHASE 2 RESULT: What did body scan find?
 */
export type BodyScanResult =
  | { type: 'found-step'; result: { step: WorkflowStep; isComplete: boolean; guidance: any; context: any } }
  | { type: 'body-complete'; frame: LoopStackFrame }
  | { type: 'abort-loop'; reason: 'context-size'; sizeKB: number };

/**
 * PHASE 3 RESULT: Did iteration complete successfully?
 */
export type IterationCompletionResult =
  | { type: 'complete'; frame: LoopStackFrame; context: EnhancedContext }
  | { type: 'incomplete'; reason: 'waiting-for-steps'; missingSteps: string[] };

/**
 * Step eligibility check result.
 */
export type StepEligibilityResult =
  | { type: 'eligible'; context: EnhancedContext; guidance: any }
  | { type: 'skip'; reason: 'already-completed' | 'condition-false' }
  | { type: 'abort'; reason: 'context-size'; sizeKB: number };

/**
 * Type guard to validate LoopStackFrame structure.
 * Used for runtime invariant checking.
 */
export function isValidLoopStackFrame(frame: any): frame is LoopStackFrame {
  return (
    frame &&
    typeof frame.loopId === 'string' &&
    frame.loopStep &&
    typeof frame.loopStep === 'object' &&
    frame.loopContext &&
    typeof frame.loopContext === 'object' &&
    Array.isArray(frame.bodySteps) &&
    frame.bodySteps.length > 0 &&
    typeof frame.currentBodyIndex === 'number' &&
    frame.currentBodyIndex >= 0 &&
    frame.currentBodyIndex <= frame.bodySteps.length
  );
}

// Optimized context for loops with progressive disclosure
export interface OptimizedLoopContext extends ConditionContext {
  _loopState?: LoopState;
  _warnings?: {
    loops?: {
      [loopId: string]: string[];
    };
  };
  _contextSize?: number;
  _currentLoop?: {
    loopId: string;
    loopType: 'for' | 'forEach' | 'while' | 'until';
    iteration: number;
    isFirstIteration: boolean;
    phaseReference?: LoopPhaseReference;
  };
  _loopPhaseReference?: LoopPhaseReference;
}

// Reference to loop phase for subsequent iterations
export interface LoopPhaseReference {
  loopId: string;
  phaseTitle: string;
  totalSteps: number;
  functionDefinitions?: FunctionDefinition[];
}

// Function DSL support
export interface FunctionParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required?: boolean;
  description?: string;
  enum?: Array<string | number | boolean>;
  default?: unknown;
}

export interface FunctionDefinition {
  name: string;
  definition: string;
  parameters?: FunctionParameter[];
  scope?: 'workflow' | 'loop' | 'step';
}

export interface FunctionCall {
  name: string;
  args: Record<string, unknown>;
}

// Type guard for loop steps
export function isLoopStep(step: WorkflowStep | LoopStep): step is LoopStep {
  return 'type' in step && step.type === 'loop';
}

// Type guard for first loop iteration
export function isFirstLoopIteration(context: EnhancedContext | OptimizedLoopContext): boolean {
  if ('isFirstIteration' in (context._currentLoop || {})) {
    return (context as OptimizedLoopContext)._currentLoop?.isFirstIteration === true;
  }
  // For legacy EnhancedContext, check if it's in a loop state
  const loopState = context._loopState;
  if (loopState) {
    const currentLoopId = context._currentLoop?.loopId;
    if (currentLoopId && loopState[currentLoopId]) {
      return loopState[currentLoopId].iteration === 0;
    }
  }
  return false;
}

// =============================================================================
// WORKFLOW VALIDATION TYPES
// =============================================================================

export interface WorkflowValidationResult {
  valid: boolean;
  errors: WorkflowValidationError[];
  warnings?: WorkflowValidationWarning[];
}

export interface WorkflowValidationError {
  path: string;
  message: string;
  code: string;
  field?: string;
}

export interface WorkflowValidationWarning {
  path: string;
  message: string;
  code: string;
  field?: string;
}

export interface WorkflowValidationRule {
  type: 'required' | 'pattern' | 'length' | 'custom' | 'schema';
  field: string;
  message: string;
  validator?: (value: any, context?: any) => boolean;
  schema?: Record<string, any>;
}

// =============================================================================
// WORKFLOW EXECUTION TYPES
// =============================================================================

export interface WorkflowExecution {
  id: string;
  workflowId: string;
  status: WorkflowExecutionStatus;
  state: WorkflowExecutionState;
  startedAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  error?: WorkflowExecutionError;
}

export type WorkflowExecutionStatus = 
  | 'initialized'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface WorkflowExecutionState {
  currentStep?: string;
  completedSteps: string[];
  context: Record<string, any>;
  stepResults: Record<string, WorkflowStepResult>;
  metadata: WorkflowExecutionMetadata;
}

export interface WorkflowStepResult {
  stepId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt?: Date;
  completedAt?: Date;
  output?: string;
  error?: string;
  validationResult?: WorkflowValidationResult;
}

export interface WorkflowExecutionMetadata {
  totalSteps: number;
  completedSteps: number;
  progress: number; // 0-100
  estimatedTimeRemaining?: number;
  lastActivity: Date;
}

export interface WorkflowExecutionError {
  code: string;
  message: string;
  stepId?: string;
  details?: Record<string, any>;
}

// =============================================================================
// WORKFLOW GUIDANCE TYPES
// =============================================================================

export interface WorkflowGuidance {
  prompt: string;
  modelHint?: string;
  requiresConfirmation?: boolean;
  validationCriteria?: string[];
  context?: Record<string, any>;
  suggestions?: string[];
}

export interface WorkflowStepGuidance {
  step: WorkflowStep;
  guidance: WorkflowGuidance;
  isComplete: boolean;
  nextStep?: string;
  progress: number;
}

// =============================================================================
// WORKFLOW STORAGE TYPES
// =============================================================================

export interface WorkflowStorage {
  type: 'file' | 'database' | 'memory';
  path?: string;
  connectionString?: string;
}

export interface WorkflowMetadata {
  id: string;
  name: string;
  description: string;
  category: string;
  version: string;
  author?: string;
  tags?: string[];
  createdAt: Date;
  updatedAt: Date;
  usageCount: number;
  rating?: number;
  complexity: 'simple' | 'medium' | 'complex';
  estimatedDuration: number; // in minutes
}

export interface WorkflowSearchCriteria {
  category?: string;
  tags?: string[];
  complexity?: 'simple' | 'medium' | 'complex';
  maxDuration?: number;
  author?: string;
  rating?: number;
  searchTerm?: string;
}

// =============================================================================
// WORKFLOW CATEGORIES AND TAGS
// =============================================================================

export type WorkflowCategory = 
  | 'development'
  | 'review'
  | 'documentation'
  | 'testing'
  | 'deployment'
  | 'maintenance'
  | 'debugging'
  | 'optimization'
  | 'security'
  | 'migration'
  | 'custom';

export interface WorkflowTag {
  name: string;
  description: string;
  color?: string;
}

// =============================================================================
// WORKFLOW VERSIONING TYPES
// =============================================================================

export interface WorkflowVersion {
  version: string;
  changelog: string;
  breakingChanges: boolean;
  deprecated: boolean;
  minServerVersion?: string;
  maxServerVersion?: string;
}

export interface WorkflowVersionInfo {
  currentVersion: string;
  availableVersions: WorkflowVersion[];
  updateAvailable: boolean;
  latestVersion?: string;
}

// =============================================================================
// WORKFLOW TEMPLATE TYPES
// =============================================================================

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category: WorkflowCategory;
  template: Workflow;
  variables: WorkflowTemplateVariable[];
  examples: WorkflowTemplateExample[];
}

export interface WorkflowTemplateVariable {
  name: string;
  description: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required: boolean;
  defaultValue?: any;
  validation?: Record<string, any>;
}

export interface WorkflowTemplateExample {
  name: string;
  description: string;
  variables: Record<string, any>;
  result: Workflow;
}

// =============================================================================
// WORKFLOW ANALYTICS TYPES
// =============================================================================

export interface WorkflowAnalytics {
  workflowId: string;
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  averageExecutionTime: number;
  averageStepsCompleted: number;
  popularSteps: string[];
  commonErrors: string[];
  userSatisfaction: number;
  lastExecuted: Date;
}

export interface WorkflowExecutionAnalytics {
  executionId: string;
  workflowId: string;
  duration: number;
  stepsCompleted: number;
  totalSteps: number;
  success: boolean;
  error?: string;
  userFeedback?: number;
  performanceMetrics: WorkflowPerformanceMetrics;
}

export interface WorkflowPerformanceMetrics {
  stepExecutionTimes: Record<string, number>;
  memoryUsage: number;
  cpuUsage: number;
  networkRequests: number;
  cacheHits: number;
  cacheMisses: number;
}

// =============================================================================
// WORKFLOW PLUGIN TYPES
// =============================================================================

export interface WorkflowPlugin {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  hooks: WorkflowPluginHook[];
  commands: WorkflowPluginCommand[];
  dependencies?: string[];
}

export interface WorkflowPluginHook {
  name: string;
  event: 'beforeStep' | 'afterStep' | 'beforeWorkflow' | 'afterWorkflow' | 'onError';
  handler: (context: WorkflowPluginContext) => Promise<void>;
}

export interface WorkflowPluginCommand {
  name: string;
  description: string;
  parameters: Record<string, any>;
  handler: (params: Record<string, any>) => Promise<any>;
}

export interface WorkflowPluginContext {
  workflowId: string;
  executionId: string;
  stepId?: string;
  data: Record<string, any>;
  state: WorkflowExecutionState;
}

// =============================================================================
// UTILITY TYPES
// =============================================================================

export type WorkflowStepStatus = 
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export type WorkflowComplexity = 
  | 'simple'
  | 'medium'
  | 'complex';

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  category: WorkflowCategory;
  version: string;
  complexity: WorkflowComplexity;
  estimatedDuration: number;
  tags: string[];
  rating?: number;
  usageCount: number;
}

export interface WorkflowSearchResult {
  workflows: WorkflowSummary[];
  total: number;
  page: number;
  pageSize: number;
  filters: WorkflowSearchCriteria;
} 