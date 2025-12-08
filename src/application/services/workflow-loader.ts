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
    @inject(DI.Repository.Ready) private readonly repository: any,  // IReadyRepository | legacy storage for tests
    @inject(ValidationEngine) private readonly validationEngine: ValidationEngine,
    @inject(DI.Logging.Factory) loggerFactory: ILoggerFactory,
  ) {
    this.logger = loggerFactory.create('WorkflowLoader');
  }

  async loadAndValidate(workflowId: WorkflowId): Promise<Result<LoadedWorkflow, AppError>> {
    this.logger.debug({ workflowId }, 'Loading workflow');
    console.log('[WorkflowLoader] loadAndValidate called with:', workflowId);
    
    // Load workflow from repository (handle legacy storage for tests)
    let workflow: any;
    if (typeof this.repository.getById === 'function') {
      // New repository interface
      console.log('[WorkflowLoader] Using new repository interface (getById)');
      const workflowResult = await this.repository.getById(workflowId);
      console.log('[WorkflowLoader] getById result:', workflowResult.isOk() ? 'OK' : 'ERR');
      if (workflowResult.isErr()) {
        console.log('[WorkflowLoader] Error:', workflowResult.error);
        return err(workflowResult.error);
      }
      workflow = workflowResult.value;
    } else if (typeof this.repository.getWorkflowById === 'function') {
      // Legacy storage interface (for tests)
      console.log('[WorkflowLoader] Using legacy storage interface (getWorkflowById)');
      workflow = await this.repository.getWorkflowById(workflowId);
      console.log('[WorkflowLoader] Legacy result:', workflow ? 'found' : 'not found');
      if (!workflow) {
        return err(Err.workflowNotFound(workflowId as any as string, [], 0, []));
      }
    } else if (typeof this.repository.fetchById === 'function') {
      // Provider interface (for tests using InMemoryWorkflowProvider)
      console.log('[WorkflowLoader] Using provider interface (fetchById)');
      const workflowResult = await this.repository.fetchById(workflowId);
      console.log('[WorkflowLoader] fetchById result:', workflowResult.isOk() ? 'OK' : 'ERR');
      if (workflowResult.isErr()) {
        console.log('[WorkflowLoader] Error:', workflowResult.error);
        return err(workflowResult.error);
      }
      workflow = workflowResult.value;
    } else {
      console.error('[WorkflowLoader] Invalid repository type - no recognized methods');
      console.error('[WorkflowLoader] Available methods:', Object.keys(this.repository));
      return err(Err.unexpectedError('workflow-load', new Error('Invalid repository type')));
    }

    // Validate workflow structure (TODO: Update ValidationEngine to use branded types)
    console.log('[WorkflowLoader] Validating workflow structure...');
    console.log('[WorkflowLoader] Workflow keys:', Object.keys(workflow));
    console.log('[WorkflowLoader] Steps count:', workflow.steps?.length);
    const validationResult = this.validationEngine.validateWorkflow(workflow as any);
    console.log('[WorkflowLoader] Validation result:', validationResult.valid ? 'VALID' : 'INVALID');
    if (!validationResult.valid) {
      console.log('[WorkflowLoader] Validation issues:', validationResult.issues);
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
