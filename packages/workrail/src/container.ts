import { createDefaultWorkflowStorage } from './infrastructure/storage/storage.js';
import { DefaultWorkflowService, WorkflowService } from './application/services/workflow-service.js';
import { createServiceContainer } from './infrastructure/di/service-container.js';
import { ValidationEngine } from './application/services/validation-engine.js';
import { IWorkflowStorage } from './types/storage.js';
import { createWorkflowLookupServer } from './infrastructure/rpc/server.js';
import { WorkflowLookupServer } from './types/server.js';
import { ILoopContextOptimizer } from './types/loop-context-optimizer.js';
import { LoopContextOptimizer } from './application/services/loop-context-optimizer.js';
import { 
  IFeatureFlagProvider, 
  createFeatureFlagProvider 
} from './config/feature-flags.js';

/**
 * Centralized composition root / dependency-injection helper.
 * Allows overriding individual dependencies (storage, services) for
 * testing or alternative implementations.
 */
export interface AppContainer {
  featureFlags: IFeatureFlagProvider;
  storage: IWorkflowStorage;
  validationEngine: ValidationEngine;
  loopContextOptimizer: ILoopContextOptimizer;
  workflowService: WorkflowService;
  server: WorkflowLookupServer;
}

/**
 * Build the application container.
 * @param overrides  Optionally replace core components, e.g. provide an
 *                   in-memory storage for tests.
 */
export function createAppContainer(overrides: Partial<AppContainer> = {}): AppContainer {
  const featureFlags = overrides.featureFlags ?? createFeatureFlagProvider();
  const storage = overrides.storage ?? createDefaultWorkflowStorage();
  const validationEngine = overrides.validationEngine ?? new ValidationEngine();
  const loopContextOptimizer = overrides.loopContextOptimizer ?? new LoopContextOptimizer();
  
  // Create service container for workflow service dependencies
  const serviceContainer = createServiceContainer({ storage, validationEngine, loopContextOptimizer });
  
  const workflowService =
    overrides.workflowService ?? new DefaultWorkflowService(
      serviceContainer.storage,
      serviceContainer.validationEngine,
      serviceContainer.stepResolutionStrategy
    );
  const server = overrides.server ?? createWorkflowLookupServer(workflowService);

  return {
    featureFlags,
    storage,
    validationEngine,
    loopContextOptimizer,
    workflowService,
    server
  };
} 