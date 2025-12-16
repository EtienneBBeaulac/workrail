import { singleton, inject } from 'tsyringe';
import { Workflow, isLoopStepDefinition, LoopStepDefinition } from '../../types/workflow';
import { IWorkflowLoader, LoadedWorkflow } from './i-workflow-loader';
import { IWorkflowStorage, ICompositeWorkflowStorage } from '../../types/storage';
import { ValidationEngine } from './validation-engine';
import { WorkflowNotFoundError } from '../../core/error-handler';
import { createLogger } from '../../utils/logger';
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
  private readonly logger = createLogger('WorkflowLoader');

  constructor(
    @inject(DI.Storage.Primary) private readonly storage: import('../../types/storage').IWorkflowReader,
    @inject(ValidationEngine) private readonly validationEngine: ValidationEngine
  ) {}

  async loadAndValidate(workflowId: string): Promise<LoadedWorkflow> {
    this.logger.debug('Loading workflow', { workflowId });
    
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
    
    this.logger.debug('Workflow loaded and validated', {
      workflowId,
      stepCount: workflow.definition.steps.length,
      loopBodyStepCount: loopBodySteps.size
    });

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
    
    for (const step of workflow.definition.steps) {
      if (isLoopStepDefinition(step)) {
        if (typeof step.body === 'string') {
          bodySteps.add(step.body);
        } else if (Array.isArray(step.body)) {
          step.body.forEach(bodyStep => {
            bodySteps.add(bodyStep.id);
          });
        }
      }
    }
    
    return bodySteps;
  }
}
