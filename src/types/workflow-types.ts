/**
 * Workflow Schema Type Definitions
 * 
 * This file contains LEGACY and RUNTIME types that extend the core workflow types.
 * For core workflow types (Workflow, WorkflowDefinition, WorkflowStep), use ./workflow.ts
 */

import { Condition, ConditionContext } from '../utils/condition-evaluator';
import {
  WorkflowStepDefinition,
  LoopStepDefinition,
  LoopConfigDefinition,
  FunctionDefinition,
  FunctionParameter,
  FunctionCall
} from './workflow-definition';

// =============================================================================
// RE-EXPORTS FROM CANONICAL SOURCES
// =============================================================================

// Re-export core types from workflow.ts (primary source of truth)
export type {
  Workflow,
  WorkflowDefinition,
  WorkflowStepDefinition,
  LoopStepDefinition,
  LoopConfigDefinition,
  FunctionDefinition,
  FunctionParameter,
  FunctionCall,
  WorkflowSummary,
  WorkflowSource,
  WorkflowSourceInfo
} from './workflow';

export {
  createWorkflow,
  toWorkflowSummary,
  isWorkflow,
  isWorkflowDefinition,
  isLoopStepDefinition,
  isWorkflowStepDefinition
} from './workflow';

// =============================================================================
// LEGACY TYPE ALIASES (for backward compatibility)
// =============================================================================

/** @deprecated Use WorkflowStepDefinition from ./workflow */
export type WorkflowStep = WorkflowStepDefinition;

/** @deprecated Use LoopStepDefinition from ./workflow */
export type LoopStep = LoopStepDefinition;

/** @deprecated Use LoopConfigDefinition from ./workflow */
export type LoopConfig = LoopConfigDefinition;

/** @deprecated Use isLoopStepDefinition from ./workflow */
export function isLoopStep(step: WorkflowStepDefinition | LoopStepDefinition): step is LoopStepDefinition {
  return 'type' in step && step.type === 'loop';
}

// =============================================================================
// LOOP EXECUTION TYPES (Runtime-specific, not in definition)
// =============================================================================

export interface LoopState {
  [loopId: string]: {
    iteration: number;
    started: number;
    items?: unknown[];
    index?: number;
    warnings?: string[];
  };
}

export interface EnhancedContext extends ConditionContext {
  _loopState?: LoopState;
  _loopStack?: LoopStackFrame[];
  _warnings?: {
    loops?: {
      [loopId: string]: string[];
    };
  };
  _contextSize?: number;
  _currentLoop?: {
    loopId: string;
    loopStep: LoopStepDefinition;
  };
}

export enum LoopExecutionState {
  RECOVERING_LOOP_STATE = 'RECOVERING_LOOP_STATE',
  IN_LOOP = 'IN_LOOP',
  FINDING_NEXT_STEP = 'FINDING_NEXT_STEP',
  ENTERING_LOOP = 'ENTERING_LOOP',
  RETURNING_STEP = 'RETURNING_STEP',
  WORKFLOW_COMPLETE = 'WORKFLOW_COMPLETE',
  CHECKING_LOOP_CONDITION = 'CHECKING_LOOP_CONDITION',
  SCANNING_BODY = 'SCANNING_BODY',
  CHECKING_ELIGIBILITY = 'CHECKING_ELIGIBILITY',
  RETURNING_BODY_STEP = 'RETURNING_BODY_STEP',
  VALIDATING_ITERATION_COMPLETE = 'VALIDATING_ITERATION_COMPLETE',
  INCREMENTING_ITERATION = 'INCREMENTING_ITERATION'
}

export interface LoopStackFrame {
  readonly loopId: string;
  readonly loopStep: LoopStepDefinition;
  readonly loopContext: LoopExecutionContextLike;
  readonly bodySteps: readonly WorkflowStepDefinition[];
  currentBodyIndex: number;
}

/**
 * State snapshot from a loop execution.
 */
export interface LoopStateSnapshot {
  readonly iteration: number;
  readonly started: number;
  readonly items?: unknown[];
  readonly index?: number;
  readonly warnings?: string[];
}

/**
 * Minimal interface for loop execution context.
 * Avoids circular dependency while providing type safety.
 * Only includes methods actually called on the interface.
 */
export interface LoopExecutionContextLike {
  getCurrentState(): LoopStateSnapshot;
  incrementIteration(): void;
  shouldContinue(context: ConditionContext): boolean;
  isFirstIteration(): boolean;
  injectVariables(context: ConditionContext, minimal?: boolean): EnhancedContext | OptimizedLoopContext;
  initializeForEach(context: ConditionContext): void;
}

export interface StepResult {
  step: WorkflowStepDefinition;
  isComplete: boolean;
  context: EnhancedContext;
  guidance: import('./mcp-types').WorkflowGuidance;
}

export type LoopHandlerResult =
  | { type: 'step'; result: StepResult }
  | { type: 'continue' }
  | { type: 'complete' };

export function isValidLoopStackFrame(frame: unknown): frame is LoopStackFrame {
  if (!frame || typeof frame !== 'object') return false;
  const f = frame as Record<string, unknown>;
  
  return (
    typeof f['loopId'] === 'string' &&
    f['loopStep'] !== null &&
    typeof f['loopStep'] === 'object' &&
    f['loopContext'] !== null &&
    typeof f['loopContext'] === 'object' &&
    Array.isArray(f['bodySteps']) &&
    f['bodySteps'].length > 0 &&
    typeof f['currentBodyIndex'] === 'number' &&
    f['currentBodyIndex'] >= 0
  );
}

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

export interface LoopPhaseReference {
  loopId: string;
  phaseTitle: string;
  totalSteps: number;
  functionDefinitions?: readonly FunctionDefinition[];
}

export function isFirstLoopIteration(context: EnhancedContext | OptimizedLoopContext): boolean {
  if ('isFirstIteration' in (context._currentLoop || {})) {
    return (context as OptimizedLoopContext)._currentLoop?.isFirstIteration === true;
  }
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
  validator?: (value: unknown, context?: unknown) => boolean;
  schema?: Record<string, unknown>;
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
  context: Record<string, unknown>;
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
  progress: number;
  estimatedTimeRemaining?: number;
  lastActivity: Date;
}

export interface WorkflowExecutionError {
  code: string;
  message: string;
  stepId?: string;
  details?: Record<string, unknown>;
}

// =============================================================================
// WORKFLOW GUIDANCE TYPES
// =============================================================================

export interface WorkflowGuidance {
  prompt: string;
  modelHint?: string;
  requiresConfirmation?: boolean;
  validationCriteria?: string[];
  context?: Record<string, unknown>;
  suggestions?: string[];
}

export interface WorkflowStepGuidance {
  step: WorkflowStepDefinition;
  guidance: WorkflowGuidance;
  isComplete: boolean;
  nextStep?: string;
  progress: number;
}

// =============================================================================
// WORKFLOW SEARCH AND METADATA TYPES
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

export type WorkflowComplexity = 
  | 'simple'
  | 'medium'
  | 'complex';

export type WorkflowStepStatus = 
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface WorkflowTag {
  name: string;
  description: string;
  color?: string;
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

export interface WorkflowSearchResult {
  workflows: import('./workflow').WorkflowSummary[];
  total: number;
  page: number;
  pageSize: number;
  filters: WorkflowSearchCriteria;
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
  complexity: WorkflowComplexity;
  estimatedDuration: number;
}

export interface WorkflowStorage {
  type: 'file' | 'database' | 'memory';
  path?: string;
  connectionString?: string;
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
  template: import('./workflow').Workflow;
  variables: WorkflowTemplateVariable[];
  examples: WorkflowTemplateExample[];
}

export interface WorkflowTemplateVariable {
  name: string;
  description: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required: boolean;
  defaultValue?: unknown;
  validation?: Record<string, unknown>;
}

export interface WorkflowTemplateExample {
  name: string;
  description: string;
  variables: Record<string, unknown>;
  result: import('./workflow').Workflow;
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
  parameters: Record<string, unknown>;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

export interface WorkflowPluginContext {
  workflowId: string;
  executionId: string;
  stepId?: string;
  data: Record<string, unknown>;
  state: WorkflowExecutionState;
}
