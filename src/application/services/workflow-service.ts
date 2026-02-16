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
import { Err } from '../../domain/execution/error';
import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';
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
    warnings?: readonly string[];
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
    if (!workflow) return err(Err.workflowNotFound(workflowId));

    const compiled = this.getOrCompile(workflowId, workflow);
    if (compiled.isErr()) return err(compiled.error);

    // Apply optional event (pure state transition)
    const advancedState = event ? this.interpreter.applyEvent(state, event) : ok(state);
    if (advancedState.isErr()) return err(advancedState.error);

    const next = this.interpreter.next(compiled.value, advancedState.value, context as any);
    if (next.isErr()) return err(next.error);

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
  ): Promise<{ valid: boolean; issues: readonly string[]; suggestions: readonly string[]; warnings?: readonly string[] }> {
    const workflow = await this.storage.getWorkflowById(workflowId);
    if (!workflow) {
      // Validation is best-effort; treat missing workflow as invalid.
      return { valid: false, issues: [`Workflow '${workflowId}' not found`], suggestions: [], warnings: undefined };
    }

    const step = workflow.definition.steps.find((s) => s.id === stepId) as WorkflowStepDefinition | undefined;
    if (!step) {
      return { valid: false, issues: [`Step '${stepId}' not found in workflow '${workflowId}'`], suggestions: [], warnings: undefined };
    }

    // Fail-fast: steps using outputContract must be validated via v2 execution path,
    // not this v1 prose validator. Prevents silent contract bypass.
    const outputContract = (step as any).outputContract;
    if (outputContract) {
      return {
        valid: false,
        issues: [`Step '${stepId}' uses outputContract (artifact validation); validate via v2 continue_workflow path, not v1 validateStepOutput`],
        suggestions: ['Use the v2 continue_workflow tool with output.artifacts[] to validate against the artifact contract.'],
        warnings: undefined,
      };
    }

    const criteria = (step as any).validationCriteria;
    if (!criteria) return { valid: true, issues: [], suggestions: [], warnings: undefined };

    const result = await this.validationEngine.validate(output, criteria);
    if (result.isErr()) {
      return {
        valid: false,
        issues: [`Validation engine error: ${result.error.kind} (${result.error.message})`],
        suggestions: ['Check validationCriteria for invalid schema/format, and retry.'],
        warnings: undefined,
      };
    }

    // Add context to warnings for better debuggability
    const contextualizedWarnings = result.value.warnings?.map((w) => `Step '${workflowId}/${stepId}': ${w}`);

    return {
      ...result.value,
      warnings: contextualizedWarnings,
    };
  }

  private getOrCompile(workflowId: string, workflow: Workflow): Result<CompiledWorkflow, DomainError> {
    const cached = this.compiledCache.get(workflowId);
    if (cached) return ok(cached);

    // Definition validation stays here: fail fast before compiling.
    const validation = this.validationEngine.validateWorkflow(workflow);
    if (!validation.valid) {
      return err(Err.invalidState(`Invalid workflow structure: ${validation.issues.join('; ')}`));
    }

    const compiled = this.compiler.compile(workflow);
    if (compiled.isErr()) return err(compiled.error);
    this.compiledCache.set(workflowId, compiled.value);
    this.evictCompiledCacheIfNeeded();
    return ok(compiled.value);
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
