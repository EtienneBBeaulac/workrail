/**
 * Public exports for workflow execution services.
 * 
 * These services follow Clean Architecture and Single Responsibility Principle.
 * They can be used independently or composed via the DI container.
 */

// Main service
export { WorkflowService, DefaultWorkflowService, createWorkflowService } from './workflow-service';

// Service interfaces (for DI and testing)
export { IWorkflowLoader, LoadedWorkflow } from './i-workflow-loader';
export { IStepSelector } from './i-step-selector';
export { ILoopRecoveryService } from './i-loop-recovery-service';
export { IStepResolutionStrategy, StepResolutionResult } from './step-resolution/i-step-resolution-strategy';

// Default implementations (for direct use or custom DI)
export { DefaultWorkflowLoader } from './workflow-loader';
export { DefaultStepSelector } from './step-selector';
export { DefaultLoopRecoveryService } from './loop-recovery-service';
export { IterativeStepResolutionStrategy } from './step-resolution/iterative-step-resolution-strategy';

// Other services
export { ValidationEngine } from './validation-engine';
export { LoopStackManager } from './loop-stack-manager';
export { LoopStepResolver } from './loop-step-resolver';
export { LoopExecutionContext } from './loop-execution-context';
export { ContextOptimizer } from './context-optimizer';
