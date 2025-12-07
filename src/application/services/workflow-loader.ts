import { singleton, inject } from 'tsyringe';
import { Workflow } from '../../types/mcp-types';
import { IWorkflowLoader, LoadedWorkflow } from './i-workflow-loader';
import { IWorkflowStorage } from '../../types/storage';
import { ValidationEngine } from './validation-engine';
import { WorkflowNotFoundError } from '../../core/error-handler';
import { isLoopStep, LoopStep } from '../../types/workflow-types';
import type { Logger, ILoggerFactory } from '../../core/logging/index.js';
import { DI } from '../../di/tokens.js';

/**
 * Default implementation of workflow loading and validation.
 * 
 * Responsibilities:
 * - Load workflow from storage
 * - Validate workflow structure
 * - Pre-compute loop body step map
 */
@singleton()
export class DefaultWorkflowLoader implements IWorkflowLoader {
  private readonly logger: Logger;

  constructor(
    @inject(DI.Storage.Primary) private readonly storage: IWorkflowStorage,
    @inject(ValidationEngine) private readonly validationEngine: ValidationEngine,
    @inject(DI.Logging.Factory) loggerFactory: ILoggerFactory,
  ) {
    this.logger = loggerFactory.create('WorkflowLoader');
  }

  async loadAndValidate(workflowId: string): Promise<LoadedWorkflow> {
    this.logger.debug({ workflowId }, 'Loading workflow');
    
    // Load workflow from storage
    const workflow = await this.storage.getWorkflowById(workflowId);
    if (!workflow) {
      throw new WorkflowNotFoundError(workflowId);
    }

    // Validate workflow structure
    const validationResult = this.validationEngine.validateWorkflow(workflow);
    if (!validationResult.valid) {
      throw new Error(`Invalid workflow structure: ${validationResult.issues.join('; ')}`);
    }

    // Build loop body step map for efficient filtering
    const loopBodySteps = this.buildLoopBodyStepSet(workflow);
    
    this.logger.debug({
      workflowId,
      stepCount: workflow.steps.length,
      loopBodyStepCount: loopBodySteps.size,
    }, 'Workflow loaded and validated');

    return { workflow, loopBodySteps };
  }

  /**
   * Builds a set of all step IDs that are loop bodies.
   * Used to skip body steps when not in the corresponding loop.
   * 
   * @param workflow - The workflow to analyze
   * @returns Set of step IDs that are loop body steps
   */
  private buildLoopBodyStepSet(workflow: Workflow): Set<string> {
    const bodySteps = new Set<string>();
    
    for (const step of workflow.steps) {
      if (isLoopStep(step)) {
        const loopStep = step as LoopStep;
        
        if (typeof loopStep.body === 'string') {
          bodySteps.add(loopStep.body);
        } else if (Array.isArray(loopStep.body)) {
          loopStep.body.forEach(bodyStep => {
            bodySteps.add(bodyStep.id);
          });
        }
      }
    }
    
    return bodySteps;
  }
}
