/**
 * Workflow Loader Service
 * 
 * Loads and validates workflows.
 * Result-based, branded types.
 */

import { singleton, inject } from 'tsyringe';
import { Result, ok, err } from 'neverthrow';
import { DI } from '../../di/tokens.js';
import type { Workflow, WorkflowId } from '../../types/schemas.js';
import type { IReadyRepository } from '../../types/repository.js';
import type { AppError } from '../../core/errors/index.js';
import { Err } from '../../core/errors/index.js';
import { ValidationEngine } from './validation-engine.js';
import { isLoopStep, type LoopStep } from '../../types/workflow-types.js';
import type { Logger, ILoggerFactory } from '../../core/logging/index.js';

export interface IWorkflowLoader {
  loadAndValidate(workflowId: WorkflowId): Promise<Result<LoadedWorkflow, AppError>>;
}

export interface LoadedWorkflow {
  workflow: Workflow;
  loopBodySteps: Set<string>;  // TODO: Set<StepId>
}

@singleton()
export class DefaultWorkflowLoader implements IWorkflowLoader {
  private readonly logger: Logger;

  constructor(
    @inject(DI.Repository.Ready) private readonly repository: IReadyRepository,
    @inject(ValidationEngine) private readonly validationEngine: ValidationEngine,
    @inject(DI.Logging.Factory) loggerFactory: ILoggerFactory,
  ) {
    this.logger = loggerFactory.create('WorkflowLoader');
  }

  async loadAndValidate(workflowId: WorkflowId): Promise<Result<LoadedWorkflow, AppError>> {
    this.logger.debug({ workflowId }, 'Loading workflow');
    
    // Load workflow from repository
    const workflowResult = await this.repository.getById(workflowId);
    if (workflowResult.isErr()) {
      return err(workflowResult.error);
    }
    
    const workflow = workflowResult.value;

    // Validate workflow structure (TODO: Update ValidationEngine to use branded types)
    const validationResult = this.validationEngine.validateWorkflow(workflow as any);
    if (!validationResult.valid) {
      return err(Err.validationFailed(
        'workflow',
        workflowId as any as string,
        validationResult.issues.join('; ')
      ));
    }

    // Build loop body step map
    const loopBodySteps = this.buildLoopBodyStepSet(workflow);
    
    this.logger.debug({
      workflowId,
      stepCount: workflow.steps.length,
      loopBodyStepCount: loopBodySteps.size,
    }, 'Workflow loaded and validated');

    return ok({ workflow, loopBodySteps });
  }

  private buildLoopBodyStepSet(workflow: Workflow): Set<string> {
    const bodySteps = new Set<string>();
    
    for (const step of workflow.steps) {
      if (isLoopStep(step)) {
        const loopStep = step as LoopStep;
        
        if (typeof loopStep.body === 'string') {
          bodySteps.add(loopStep.body as any);  // TODO: StepId
        } else if (Array.isArray(loopStep.body)) {
          loopStep.body.forEach(bodyStep => {
            bodySteps.add(bodyStep.id as any);  // TODO: StepId
          });
        }
      }
    }
    
    return bodySteps;
  }
}
