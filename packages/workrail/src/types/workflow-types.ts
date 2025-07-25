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
export interface EnhancedContext extends Record<string, any> {
  _loopState?: LoopState;
  _warnings?: {
    loops?: {
      [loopId: string]: string[];
    };
  };
  _contextSize?: number; // tracked for validation
}

// Type guard for loop steps
export function isLoopStep(step: WorkflowStep | LoopStep): step is LoopStep {
  return 'type' in step && step.type === 'loop';
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