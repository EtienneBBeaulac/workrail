/**
 * Gate Evaluator Dispatcher
 *
 * Spawns an independent evaluator session to assess a gate checkpoint.
 * The coordinator calls evaluateGate() after detecting a gate_parked session;
 * the function spawns a child WorkRail session with the artifact as context,
 * awaits its completion, and returns a typed GateVerdict.
 *
 * Design invariants:
 * - evaluateGate() contains zero direct LLM calls -- it is TypeScript routing only.
 * - The evaluator session receives only the typed artifact in its context (not the
 *   parent session's conversation history), enforcing structural isolation.
 * - All paths return GateVerdict -- never throw.
 * - 'uncertain' is the safe fallback for all failure cases (timeout, no artifact,
 *   spawn failure). The coordinator escalates 'uncertain' to operator outbox.
 */

import type { GateVerdictArtifactV1 } from '../v2/durable-core/schemas/artifacts/index.js';
import { isGateVerdictArtifact, parseGateVerdictArtifact } from '../v2/durable-core/schemas/artifacts/index.js';
import type { Result } from '../runtime/result.js';
import type { AwaitResult } from '../cli/commands/worktrain-await.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The typed result of evaluateGate().
 *
 * verdict:
 * - 'approved': coordinator resumes the parked session with verdict context
 * - 'rejected': coordinator escalates to operator outbox with findings
 * - 'uncertain': evaluator could not reach a confident conclusion;
 *   coordinator escalates to operator outbox
 */
export interface GateVerdict {
  readonly verdict: 'approved' | 'rejected' | 'uncertain';
  readonly rationale: string;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly stepId: string;
}

/**
 * Minimal deps surface needed by evaluateGate.
 *
 * WHY a narrower interface than AdaptiveCoordinatorDeps: evaluateGate only
 * needs spawn/await/read -- not git, gh, outbox, or pipeline context. Keeping
 * the surface narrow makes the function independently testable with a minimal fake.
 */
export interface GateEvaluatorDeps {
  readonly spawnSession: (
    workflowId: string,
    goal: string,
    workspace: string,
    context?: Readonly<Record<string, unknown>>,
    agentConfig?: Readonly<{ readonly maxSessionMinutes?: number }>,
  ) => Promise<Result<string | null, string>>;
  readonly awaitSessions: (
    handles: readonly string[],
    timeoutMs: number,
  ) => Promise<AwaitResult>;
  readonly getAgentResult: (
    sessionHandle: string,
  ) => Promise<{ recapMarkdown: string | null; artifacts: readonly unknown[] }>;
  readonly stderr: (line: string) => void;
}

/** Default gate evaluation timeout: 30 minutes. */
export const DEFAULT_GATE_EVAL_TIMEOUT_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// evaluateGate
// ---------------------------------------------------------------------------

/**
 * Spawn an independent evaluator session and return a typed GateVerdict.
 *
 * The evaluator session receives the artifact as a JSON-serialized context
 * variable ('artifact') and the evaluation criteria as 'criteria'. It must
 * not have access to the parent session's conversation history -- isolation
 * is enforced by passing only the artifact object, not a session ID or handle.
 *
 * @param deps - Injectable coordinator deps (spawnSession, awaitSessions, getAgentResult)
 * @param artifact - The typed artifact from the gate step to evaluate (as unknown to
 *   allow callers to pass coordinator-side artifacts before type-checking)
 * @param evaluatorWorkflowId - WorkRail workflow ID for the evaluator (e.g. 'wr.gate-eval-generic')
 * @param workspace - Absolute path to the workspace for the evaluator session
 * @param stepId - The ID of the step whose gate fired (for verdict attribution)
 * @param criteria - Optional free-text evaluation criteria injected as context
 * @param timeoutMs - Max wait time for the evaluator session (default 30 min)
 */
export async function evaluateGate(
  deps: GateEvaluatorDeps,
  artifact: unknown,
  evaluatorWorkflowId: string,
  workspace: string,
  stepId: string,
  criteria?: string,
  timeoutMs: number = DEFAULT_GATE_EVAL_TIMEOUT_MS,
): Promise<GateVerdict> {
  const uncertain = (rationale: string): GateVerdict => ({
    verdict: 'uncertain',
    rationale,
    confidence: 'low',
    stepId,
  });

  // Spawn the evaluator session with the artifact as context.
  // WHY artifact as JSON string in context (not as a session ID): keeps evaluator
  // structurally isolated -- it cannot access the parent session's conversation history.
  const artifactJson = JSON.stringify(artifact ?? {});
  const context: Record<string, unknown> = {
    artifact: artifactJson,
    stepId,
    ...(criteria !== undefined ? { criteria } : {}),
  };

  const goal = `Evaluate the gate artifact for step '${stepId}' and produce a wr.gate_verdict artifact.`;

  const spawnResult = await deps.spawnSession(
    evaluatorWorkflowId,
    goal,
    workspace,
    context,
    { maxSessionMinutes: Math.ceil(timeoutMs / 60_000) },
  );

  if (spawnResult.kind === 'err') {
    deps.stderr(`[GateEvaluator] spawn failed for step '${stepId}': ${spawnResult.error}`);
    return uncertain(`Evaluator session spawn failed: ${spawnResult.error}`);
  }

  const handle = spawnResult.value;
  if (!handle) {
    deps.stderr(`[GateEvaluator] spawn returned null handle for step '${stepId}'`);
    return uncertain('Evaluator session returned null handle');
  }

  // Await completion.
  const awaitResult = await deps.awaitSessions([handle], timeoutMs);
  const sessionResult = awaitResult.results[0];

  if (!sessionResult || sessionResult.outcome !== 'success') {
    const outcome = sessionResult?.outcome ?? 'unknown';
    deps.stderr(`[GateEvaluator] evaluator session ${outcome} for step '${stepId}'`);
    return uncertain(`Evaluator session ${outcome}`);
  }

  // Read the verdict artifact.
  let agentResult: Awaited<ReturnType<typeof deps.getAgentResult>>;
  try {
    agentResult = await deps.getAgentResult(handle);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.stderr(`[GateEvaluator] getAgentResult failed for step '${stepId}': ${msg}`);
    return uncertain(`Could not read evaluator result: ${msg}`);
  }

  // Find and validate the wr.gate_verdict artifact.
  const rawVerdict = agentResult.artifacts.find(isGateVerdictArtifact);
  if (!rawVerdict) {
    deps.stderr(`[GateEvaluator] no wr.gate_verdict artifact produced for step '${stepId}' -- returning uncertain`);
    return uncertain('Evaluator session completed but produced no wr.gate_verdict artifact');
  }

  const parsed = parseGateVerdictArtifact(rawVerdict) as GateVerdictArtifactV1 | null;
  if (!parsed) {
    deps.stderr(`[GateEvaluator] wr.gate_verdict artifact failed schema validation for step '${stepId}'`);
    return uncertain('Gate verdict artifact failed schema validation');
  }

  return {
    verdict: parsed.verdict,
    rationale: parsed.rationale,
    confidence: parsed.confidence,
    stepId,
  };
}
