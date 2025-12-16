import { singleton, inject } from 'tsyringe';
import { DI } from '../../di/tokens.js';
import type { ConditionContext } from '../../utils/condition-evaluator';
import type { Workflow, WorkflowSummary, WorkflowStepDefinition } from '../../types/workflow';
import { ValidationEngine } from './validation-engine';
import { WorkflowCompiler, CompiledWorkflow } from './workflow-compiler';
import { WorkflowInterpreter, NextStep } from './workflow-interpreter';
import type { ExecutionState } from '../../domain/execution/state';
import type { WorkflowEvent } from '../../domain/execution/event';
import type { DomainError } from '../../domain/execution/error';
import type { Result } from '../../domain/execution/result';
import { ok, err } from '../../domain/execution/result';
import { createLogger } from '../../utils/logger';

export interface WorkflowService {
  listWorkflowSummaries(): Promise<readonly WorkflowSummary[]>;
  getWorkflowById(id: string): Promise<Workflow | null>;

  getNextStep(
    workflowId: string,
    state: ExecutionState,
    event?: WorkflowEvent,
    context?: ConditionContext
  ): Promise<Result<{ state: ExecutionState; next: NextStep | null; isComplete: boolean }, DomainError>>;

  validateStepOutput(
    workflowId: string,
    stepId: string,
    output: string
  ): Promise<{
    valid: boolean;
    issues: readonly string[];
    suggestions: readonly string[];
  }>;
}

@singleton()
export class DefaultWorkflowService implements WorkflowService {
  private readonly logger = createLogger('WorkflowService');
  private readonly compiledCache = new Map<string, CompiledWorkflow>();
  private readonly COMPILED_CACHE_MAX = 1000;

  constructor(
    @inject(DI.Storage.Primary) private readonly storage: import('../../types/storage').IWorkflowReader,
    @inject(ValidationEngine) private readonly validationEngine: ValidationEngine,
    @inject(WorkflowCompiler) private readonly compiler: WorkflowCompiler,
    @inject(WorkflowInterpreter) private readonly interpreter: WorkflowInterpreter
  ) {}

  async listWorkflowSummaries(): Promise<readonly WorkflowSummary[]> {
    return this.storage.listWorkflowSummaries();
  }

  async getWorkflowById(id: string): Promise<Workflow | null> {
    return this.storage.getWorkflowById(id);
  }

  async getNextStep(
    workflowId: string,
    state: ExecutionState,
    event?: WorkflowEvent,
    context: ConditionContext = {}
  ): Promise<Result<{ state: ExecutionState; next: NextStep | null; isComplete: boolean }, DomainError>> {
    const workflow = await this.storage.getWorkflowById(workflowId);
    if (!workflow) return err({ kind: 'workflow_not_found', workflowId });

    const compiled = this.getOrCompile(workflowId, workflow);
    if (compiled.kind === 'err') return compiled;

    // Apply optional event (pure state transition)
    const advancedState = event ? this.interpreter.applyEvent(state, event) : ok(state);
    if (advancedState.kind === 'err') return advancedState;

    const next = this.interpreter.next(compiled.value, advancedState.value, context as any);
    if (next.kind === 'err') return next;

    return ok({
      state: next.value.state,
      next: next.value.next,
      isComplete: next.value.isComplete,
    });
  }

  async validateStepOutput(
    workflowId: string,
    stepId: string,
    output: string
  ): Promise<{ valid: boolean; issues: readonly string[]; suggestions: readonly string[] }> {
    const workflow = await this.storage.getWorkflowById(workflowId);
    if (!workflow) {
      // Validation is best-effort; treat missing workflow as invalid.
      return { valid: false, issues: [`Workflow '${workflowId}' not found`], suggestions: [] };
    }

    const step = workflow.definition.steps.find((s) => s.id === stepId) as WorkflowStepDefinition | undefined;
    if (!step) {
      return { valid: false, issues: [`Step '${stepId}' not found in workflow '${workflowId}'`], suggestions: [] };
    }

    const criteria = (step as any).validationCriteria;
    if (!criteria) return { valid: true, issues: [], suggestions: [] };

    return this.validationEngine.validate(output, criteria);
  }

  private getOrCompile(workflowId: string, workflow: Workflow): Result<CompiledWorkflow, DomainError> {
    const cached = this.compiledCache.get(workflowId);
    if (cached) return ok(cached);

    // Definition validation stays here: fail fast before compiling.
    const validation = this.validationEngine.validateWorkflow(workflow);
    if (!validation.valid) {
      return err({
        kind: 'invalid_state',
        message: `Invalid workflow structure: ${validation.issues.join('; ')}`,
      });
    }

    const compiled = this.compiler.compile(workflow);
    if (compiled.kind === 'err') return compiled;
    this.compiledCache.set(workflowId, compiled.value);
    this.evictCompiledCacheIfNeeded();
    return compiled;
  }

  /**
   * Debug/test-only hook: current compiled workflow cache size.
   * This exists to prevent regressions to unbounded caches in long-running servers.
   */
  __debugCompiledCacheSize(): number {
    return this.compiledCache.size;
  }

  /**
   * Debug/test-only hook: prime the cache with a tiny, valid workflow compilation.
   * Used by perf tests to simulate churn without depending on storage internals.
   */
  __debugPrimeCompiledWorkflow(id: string): void {
    if (this.compiledCache.has(id)) return;
    // Minimal compilation payload: keep it tiny and obviously synthetic.
    // Note: the compiled object shape is trusted-only inside the service.
    this.compiledCache.set(id, ({} as unknown) as CompiledWorkflow);
    this.evictCompiledCacheIfNeeded();
  }

  private evictCompiledCacheIfNeeded(): void {
    if (this.compiledCache.size <= this.COMPILED_CACHE_MAX) return;
    // FIFO eviction: remove oldest entries until bounded.
    while (this.compiledCache.size > this.COMPILED_CACHE_MAX) {
      const oldestKey = this.compiledCache.keys().next().value as string | undefined;
      if (!oldestKey) return;
      this.compiledCache.delete(oldestKey);
    }
  }
}
