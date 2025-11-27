import { IWorkflowStorage } from '../../types/storage';
import { createDefaultWorkflowStorage } from '../storage';
import { ValidationEngine } from '../../application/services/validation-engine';
import { LoopStepResolver } from '../../application/services/loop-step-resolver';
import { LoopStackManager } from '../../application/services/loop-stack-manager';
import { DefaultWorkflowLoader } from '../../application/services/workflow-loader';
import { DefaultStepSelector } from '../../application/services/step-selector';
import { DefaultLoopRecoveryService } from '../../application/services/loop-recovery-service';
import { IterativeStepResolutionStrategy } from '../../application/services/step-resolution/iterative-step-resolution-strategy';
import { IWorkflowLoader } from '../../application/services/i-workflow-loader';
import { IStepSelector } from '../../application/services/i-step-selector';
import { ILoopRecoveryService } from '../../application/services/i-loop-recovery-service';
import { IStepResolutionStrategy } from '../../application/services/step-resolution/i-step-resolution-strategy';
import { ILoopContextOptimizer } from '../../types/loop-context-optimizer';

/**
 * Service container for workflow execution services.
 * Provides dependency injection without heavy framework.
 */
export interface ServiceContainer {
  workflowLoader: IWorkflowLoader;
  stepSelector: IStepSelector;
  loopRecoveryService: ILoopRecoveryService;
  loopStackManager: LoopStackManager;
  stepResolutionStrategy: IStepResolutionStrategy;
  storage: IWorkflowStorage;
  validationEngine: ValidationEngine;
}

/**
 * Creates a service container with all dependencies wired up.
 * 
 * Uses IterativeStepResolutionStrategy by default (zero recursion, better performance).
 * The recursive implementation was removed as it's no longer needed.
 * 
 * @param overrides - Optional overrides for testing
 * @returns Fully configured service container
 */
export function createServiceContainer(
  overrides: Partial<ServiceContainer & { loopContextOptimizer?: ILoopContextOptimizer }> = {}
): ServiceContainer {
  // Create infrastructure dependencies
  const storage = overrides.storage ?? createDefaultWorkflowStorage();
  const validationEngine = overrides.validationEngine ?? new ValidationEngine();
  const loopStepResolver = new LoopStepResolver();
  
  // Create core services
  const workflowLoader = overrides.workflowLoader 
    ?? new DefaultWorkflowLoader(storage, validationEngine);
  
  const stepSelector = overrides.stepSelector 
    ?? new DefaultStepSelector();
  
  const loopStackManager = overrides.loopStackManager 
    ?? new LoopStackManager(loopStepResolver, overrides.loopContextOptimizer);
  
  const loopRecoveryService = overrides.loopRecoveryService 
    ?? new DefaultLoopRecoveryService(loopStackManager);
  
  // Create iterative strategy (recursive implementation removed)
  const stepResolutionStrategy = overrides.stepResolutionStrategy 
    ?? new IterativeStepResolutionStrategy(
        workflowLoader,
        loopRecoveryService,
        loopStackManager,
        stepSelector
      );
  
  return {
    workflowLoader,
    stepSelector,
    loopRecoveryService,
    loopStackManager,
    stepResolutionStrategy,
    storage,
    validationEngine
  };
}
