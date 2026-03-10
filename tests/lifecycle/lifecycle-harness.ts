import type { Workflow, WorkflowDefinition } from '../../src/types/workflow.js';
import { createWorkflow } from '../../src/types/workflow.js';
import { createBundledSource } from '../../src/types/workflow-source.js';
import type { WorkflowCompiler } from '../../src/application/services/workflow-compiler.js';
import type { WorkflowInterpreter } from '../../src/application/services/workflow-interpreter.js';
import type { DomainError } from '../../src/domain/execution/error.js';
import type { ExecutionState, LoopFrame } from '../../src/domain/execution/state.js';
import type { PromptRenderError } from '../../src/v2/durable-core/domain/prompt-renderer.js';
import { renderPendingPrompt } from '../../src/v2/durable-core/domain/prompt-renderer.js';
import type { LoopPathFrame } from '../../src/domain/execution/ids.js';
import type { LoopPathFrameV1 } from '../../src/v2/durable-core/schemas/execution-snapshot/step-instance-key.js';
import { asDelimiterSafeIdV1 } from '../../src/v2/durable-core/schemas/execution-snapshot/step-instance-key.js';
import { asRunId, asNodeId } from '../../src/v2/durable-core/ids/index.js';
import type { LoadedSessionTruthV2 } from '../../src/v2/ports/session-event-log-store.port.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fixture data for a single step.
 */
export interface StepFixture {
  /** Notes the "agent" would produce for this step. */
  readonly notesMarkdown: string;
  /** Artifacts the "agent" would produce (e.g., loop control artifacts). */
  readonly artifacts?: readonly unknown[];
  /** Context variables available when evaluating conditions. */
  readonly context?: Record<string, unknown>;
}

/**
 * Loop context passed to dynamic fixture resolvers.
 */
export interface LoopContext {
  /** Current loop stack from ExecutionState. Empty for non-loop steps. */
  readonly loopStack: readonly LoopFrame[];
  /** Number of times this step ID has been visited so far (before this visit). */
  readonly stepVisitCount: number;
}

/**
 * Fixture resolver: either a static map or a dynamic function for loop-aware fixtures.
 */
export type FixtureResolver =
  | Record<string, StepFixture>
  | ((stepId: string, loopContext: LoopContext) => StepFixture | undefined);

/**
 * Workflow fixture (inline, hermetic).
 */
export interface WorkflowFixture {
  /** Must match the inline definition's id. */
  readonly workflowId: string;
  /** The workflow definition (inline, hermetic). */
  readonly definition: WorkflowDefinition;
  /** Per-step fixture data (static record or dynamic resolver function). */
  readonly stepFixtures: FixtureResolver;
  /** Max iterations for the driver loop (safety guard). Default: 100. */
  readonly maxDriverIterations?: number;
}

/**
 * Lifecycle test result.
 */
export type LifecycleTestResult =
  | {
      readonly kind: 'compilation_failed';
      readonly error: DomainError;
    }
  | {
      readonly kind: 'integrity_failure';
      readonly stepId: string;
      readonly error: DomainError;
      readonly stepsVisited: readonly string[];
    }
  | {
      readonly kind: 'prompt_render_failed';
      readonly stepId: string;
      readonly error: PromptRenderError;
      readonly stepsVisited: readonly string[];
    }
  | {
      readonly kind: 'missing_fixture';
      readonly stepId: string;
      readonly stepsVisited: readonly string[];
    }
  | {
      readonly kind: 'driver_exceeded_iterations';
      readonly iterations: number;
      readonly stepsVisited: readonly string[];
    }
  | {
      readonly kind: 'success';
      readonly stepsVisited: readonly string[];
      readonly totalSteps: number;
    };

/**
 * Harness dependencies (compiler + interpreter).
 */
export interface LifecycleHarnessDeps {
  readonly compiler: WorkflowCompiler;
  readonly interpreter: WorkflowInterpreter;
}

/**
 * Harness options.
 */
export interface LifecycleHarnessOptions {
  /** If true, call renderPendingPrompt on each step (default: true). */
  readonly checkPromptRendering?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_TRUTH: LoadedSessionTruthV2 = { events: [], manifest: [] };
const FAKE_RUN_ID = asRunId('lifecycle-test');
const FAKE_NODE_ID = asNodeId('lifecycle-node');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert v1 LoopPathFrame[] to v2 LoopPathFrameV1[].
 * The difference: loopId is a branded DelimiterSafeIdV1 in v2, plain string in v1.
 */
function toV2LoopPath(loopPath: readonly LoopPathFrame[]): LoopPathFrameV1[] {
  return loopPath.map((f) => ({
    loopId: asDelimiterSafeIdV1(f.loopId),
    iteration: f.iteration,
  }));
}

/**
 * Resolve fixture data for a step (handles both static and dynamic resolvers).
 */
function resolveFixtureData(
  stepId: string,
  fixtureResolver: FixtureResolver,
  loopContext: LoopContext
): StepFixture | undefined {
  if (typeof fixtureResolver === 'function') {
    return fixtureResolver(stepId, loopContext);
  }
  return fixtureResolver[stepId];
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Harness Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a workflow from start to terminal completion under deterministic fixtures.
 *
 * Philosophy: Exercise the real compiler + interpreter with hermetic test data.
 * No mocks, no I/O, no filesystem, no sessions — pure domain logic testing.
 */
export function executeWorkflowLifecycle(
  fixture: WorkflowFixture,
  deps: LifecycleHarnessDeps,
  options?: LifecycleHarnessOptions
): LifecycleTestResult {
  const checkPromptRendering = options?.checkPromptRendering ?? true;
  const maxIterations = fixture.maxDriverIterations ?? 100;

  // Step 1: Compile
  const workflow = createWorkflow(fixture.definition, createBundledSource());
  const compiledResult = deps.compiler.compile(workflow);
  if (compiledResult.isErr()) {
    return { kind: 'compilation_failed', error: compiledResult.error };
  }
  const compiled = compiledResult.value;

  // Step 2: Init state
  let state: ExecutionState = { kind: 'init' };
  const stepsVisited: string[] = [];
  const stepVisitCounts = new Map<string, number>();
  let context: Record<string, unknown> = {};
  let artifacts: unknown[] = [];

  // Step 3: Driver loop
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // 3a. Call interpreter.next
    const result = deps.interpreter.next(compiled, state, context, artifacts);
    if (result.isErr()) {
      return {
        kind: 'integrity_failure',
        stepId: '(next)',
        error: result.error,
        stepsVisited,
      };
    }

    // 3b. Check completion
    if (result.value.isComplete) {
      return {
        kind: 'success',
        stepsVisited,
        totalSteps: stepsVisited.length,
      };
    }

    // 3c. Handle next: null (loop entry/exit/advance)
    if (!result.value.next) {
      state = result.value.state;
      continue;
    }

    // 3d. Extract step info
    const pendingStep = result.value.next;
    const stepId = pendingStep.stepInstanceId.stepId;
    const loopPath = pendingStep.stepInstanceId.loopPath;

    // 3e. Resolve fixture
    const visitCount = stepVisitCounts.get(stepId) ?? 0;
    const fixtureData = resolveFixtureData(stepId, fixture.stepFixtures, {
      loopStack: result.value.state.loopStack,
      stepVisitCount: visitCount,
    });
    if (!fixtureData) {
      return { kind: 'missing_fixture', stepId, stepsVisited };
    }

    // 3f. Prompt rendering check (if enabled)
    if (checkPromptRendering) {
      const v2LoopPath = toV2LoopPath(loopPath);
      const renderResult = renderPendingPrompt({
        workflow,
        stepId,
        loopPath: v2LoopPath,
        truth: EMPTY_TRUTH,
        runId: FAKE_RUN_ID,
        nodeId: FAKE_NODE_ID,
        rehydrateOnly: false,
      });
      if (renderResult.isErr()) {
        return {
          kind: 'prompt_render_failed',
          stepId,
          error: renderResult.error,
          stepsVisited,
        };
      }
    }

    // 3g. Build event
    const event = {
      kind: 'step_completed' as const,
      stepInstanceId: pendingStep.stepInstanceId,
    };

    // 3h. Apply event
    const newStateResult = deps.interpreter.applyEvent(result.value.state, event);
    if (newStateResult.isErr()) {
      return {
        kind: 'integrity_failure',
        stepId,
        error: newStateResult.error,
        stepsVisited,
      };
    }

    // 3i. Update tracking
    stepsVisited.push(stepId);
    stepVisitCounts.set(stepId, visitCount + 1);
    state = newStateResult.value;
    context = fixtureData.context ?? {};
    artifacts = fixtureData.artifacts ?? [];
  }

  // Step 4: Guard exceeded
  return {
    kind: 'driver_exceeded_iterations',
    iterations: maxIterations,
    stepsVisited,
  };
}
