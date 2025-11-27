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
 * The loop stack is maintained in EnhancedContext._loopStack to keep
 * the WorkflowService stateless and concurrency-safe.
 */
export interface LoopStackFrame {
  /** Unique identifier of the loop */
  readonly loopId: string;
  
  /** The loop step definition */
  readonly loopStep: LoopStep;
  
  /** Execution context for this loop (tracks iteration, evaluates conditions) */
  readonly loopContext: any; // LoopExecutionContext - avoid circular dependency
  
  /** Body steps normalized to array (even for single-step bodies) */
  readonly bodySteps: ReadonlyArray<WorkflowStep>;
  
  /** Current position in body steps array (0-based, mutable) */
  currentBodyIndex: number;
}

/**
 * Result type for loop handling operations.
 * Uses discriminated union for type-safe handling.
 */
export type LoopHandlerResult =
  | { type: 'step'; result: any } // StepResult - avoid circular dependency
  | { type: 'continue' }
  | { type: 'complete' };

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