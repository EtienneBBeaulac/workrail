/**
 * FULL Pipeline Mode Executor
 *
 * Executes the complete discovery -> shaping -> coding -> review pipeline for
 * tasks without a pre-existing pitch. This is the most complex mode executor.
 *
 * Step sequence:
 * 1. Spawn wr.discovery session (35 minute timeout)
 * 2. Context bridge: read wr.discovery_handoff artifact from discovery result
 *    - If found and valid: inject { selectedDirection, designDocPath, assembledContextSummary }
 *    - Fallback: use lastStepNotes as assembledContextSummary only if length > 50 chars
 *    - No artifact AND short notes: proceed with no assembledContextSummary
 * 3. Spawn wr.shaping session with discovery context (35 minute timeout)
 * 4. [UX Gate] If goal contains UI-touching signals AND complexity is Large:
 *    - Dispatch wr.ui-ux-design
 *    - Require human outbox acknowledgment (poll 24 hours; timeout -> escalate)
 * 5. Spawn wr.coding-task with pitchPath in context (65 minute timeout)
 * 6. Poll for PR (up to 5 minutes)
 * 7. Dispatch wr.mr-review (25 minute timeout)
 * 8. Route verdict (same as IMPLEMENT mode: clean/minor/blocking)
 *
 * Design invariants:
 * - Discovery handoff artifact validated with Zod (pitch invariant 12).
 * - Fallback to lastStepNotes ONLY if length > 50 (pitch invariant 12 explicit guard).
 * - COORDINATOR_SPAWN_CUTOFF_MS checked before every spawn via checkSpawnCutoff().
 * - Escalation-first failure policy: all phase failures produce PipelineOutcome { kind: 'escalated' }.
 */

import type { AdaptiveCoordinatorDeps, AdaptivePipelineOpts, PipelineOutcome } from '../adaptive-pipeline.js';
import {
  DISCOVERY_TIMEOUT_MS,
  SHAPING_TIMEOUT_MS,
  CODING_TIMEOUT_MS,
  REVIEW_TIMEOUT_MS,
  checkSpawnCutoff,
} from '../adaptive-pipeline.js';
import {
  isDiscoveryHandoffArtifact,
  DiscoveryHandoffArtifactV1Schema,
  type DiscoveryHandoffArtifactV1,
  isShapingHandoffArtifact,
  ShapingHandoffArtifactV1Schema,
  isCodingHandoffArtifact,
  CodingHandoffArtifactV1Schema,
} from '../../v2/durable-core/schemas/artifacts/index.js';
import type { PhaseHandoffArtifact } from '../../v2/durable-core/schemas/artifacts/index.js';
import { buildContextSummary, extractPhaseArtifact } from '../context-assembly.js';
import { buildPhaseResult } from '../pipeline-run-context.js';
import { runReviewAndVerdictCycle } from './implement-shared.js';
import { touchesUI } from './implement.js';
import type { CoordinatorSpawnContext } from '../types.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * PR poll timeout: 5 minutes.
 * After 5 minutes with no PR: escalate.
 */
const PR_POLL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * UX gate outbox poll timeout: 24 hours.
 * After 24 hours with no human ack: escalate (pitch element 5).
 */
const UX_GATE_ACK_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Minimum notes length for lastStepNotes fallback.
 * Notes shorter than this are not useful as context (pitch invariant 12).
 */
const MIN_NOTES_LENGTH_FOR_FALLBACK = 50;

// ═══════════════════════════════════════════════════════════════════════════
// HANDOFF RENDERING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Render a discovery handoff artifact into a human-readable context summary.
 *
 * This is the `renderHandoff()` function referenced in the pitch.
 * Formats the artifact fields into a markdown summary for injection as
 * assembledContextSummary in the shaping session spawn context.
 *
 * WHY local pure function (not a shared utility):
 * No other module renders discovery handoff artifacts. Per YAGNI, extract
 * to a shared utility only when a second consumer exists.
 */
/**
 * Extract prior phase handoff artifacts from a recovered PipelineRunContext.
 * Used for crash recovery: restores the accumulated artifact array without re-running phases.
 */
function extractPriorArtifactsFromContext(
  ctx: import('../pipeline-run-context.js').PipelineRunContext,
): PhaseHandoffArtifact[] {
  const artifacts: PhaseHandoffArtifact[] = [];
  if (ctx.phases.discovery?.result.kind === 'full') artifacts.push(ctx.phases.discovery.result.artifact);
  if (ctx.phases.shaping?.result.kind === 'full') artifacts.push(ctx.phases.shaping.result.artifact);
  if (ctx.phases.coding?.result.kind === 'full') artifacts.push(ctx.phases.coding.result.artifact);
  return artifacts;
}

export function renderHandoff(artifact: DiscoveryHandoffArtifactV1): string {
  const lines: string[] = [
    `## Discovery Handoff`,
    ``,
    `**Selected Direction:** ${artifact.selectedDirection}`,
    `**Confidence:** ${artifact.confidenceBand}`,
  ];

  if (artifact.designDocPath) {
    lines.push(`**Design Doc:** ${artifact.designDocPath}`);
  }

  if (artifact.keyInvariants.length > 0) {
    lines.push(``, `**Key Invariants:**`);
    for (const invariant of artifact.keyInvariants) {
      lines.push(`- ${invariant}`);
    }
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// DISCOVERY HANDOFF ARTIFACT READING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Try to read a valid wr.discovery_handoff artifact from a session's artifacts.
 *
 * Returns the parsed artifact on success, null if not found or invalid.
 * Logs a WARN when the kind discriminant matches but validation fails.
 */
function readDiscoveryHandoffArtifact(
  artifacts: readonly unknown[],
  sessionHandle: string,
  stderrFn: (line: string) => void,
): DiscoveryHandoffArtifactV1 | null {
  const handlePrefix = sessionHandle.slice(0, 16);

  for (const raw of artifacts) {
    if (!isDiscoveryHandoffArtifact(raw)) continue;

    const result = DiscoveryHandoffArtifactV1Schema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      stderrFn(
        `[WARN full-pipeline handle=${handlePrefix}] discovery handoff schema validation failed: ${issues}`,
      );
      continue;
    }

    return result.data;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// FULL PIPELINE EXECUTOR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run the FULL pipeline mode.
 *
 * Sequences: discovery -> context bridge -> shaping -> [UX gate] -> coding -> PR poll -> review.
 *
 * INVARIANT: current-pitch.md is archived in a finally block regardless of outcome.
 * WHY: if the coding or review phases fail, the pitch must still be archived so it
 * does not route the next task to IMPLEMENT mode incorrectly. (Pitch invariant 11.)
 */
export async function runFullPipeline(
  deps: AdaptiveCoordinatorDeps,
  opts: AdaptivePipelineOpts,
  coordinatorStartMs: number,
): Promise<PipelineOutcome> {
  deps.stderr(`[full-pipeline] Starting FULL pipeline for workspace=${opts.workspace}`);

  // Crash recovery: check for an in-progress run before generating a new ID.
  // writePhaseRecord() writes a recovery pointer ({workspace}/.workrail/pipeline-runs/active-run.json)
  // on first write; we read it here to resume an interrupted run instead of starting fresh.
  const activeRunResult = await deps.readActiveRunId(opts.workspace);
  const priorRunId = activeRunResult.isOk() ? activeRunResult.value : null;
  const runId = priorRunId ?? deps.generateRunId();

  let initialPriorArtifacts: readonly PhaseHandoffArtifact[] = [];
  if (priorRunId) {
    const existingCtx = await deps.readPipelineContext(opts.workspace, priorRunId);
    if (existingCtx.isOk() && existingCtx.value !== null) {
      initialPriorArtifacts = extractPriorArtifactsFromContext(existingCtx.value);
    }
  }

  deps.stderr(priorRunId
    ? `[full-pipeline] Resuming prior run ${priorRunId} with ${initialPriorArtifacts.length} artifact(s)`
    : `[full-pipeline] Starting new run ${runId}`);

  // Initialize the context file for new runs only -- crash-resumed runs already have one.
  // Awaited: if this fails we escalate immediately rather than running the pipeline
  // without durability. An operator can fix the storage issue and resume.
  if (!priorRunId) {
    const initResult = await deps.createPipelineContext(opts.workspace, runId, opts.goal, 'FULL');
    if (initResult.isErr()) {
      deps.stderr(`[full-pipeline] FATAL: failed to initialize PipelineRunContext: ${initResult.error}`);
      return { kind: 'escalated', escalationReason: { phase: 'init', reason: `PipelineRunContext initialization failed: ${initResult.error}` } };
    }
  }

  // ── Pitch archival setup ──────────────────────────────────────────────
  // Build the archive path now so it's available in the finally block.
  // The shaping session creates current-pitch.md; we archive it on success or failure.
  const pitchPath = opts.workspace + '/.workrail/current-pitch.md';
  const archiveDir = opts.workspace + '/.workrail/used-pitches';
  const archiveTimestamp = deps.nowIso().replace(/[:.]/g, '-');
  const archivePath = archiveDir + '/pitch-' + archiveTimestamp + '.md';

  let outcome: PipelineOutcome;

  try {
    outcome = await runFullPipelineCore(deps, opts, coordinatorStartMs, runId, initialPriorArtifacts);
    // Mark complete so the next scan doesn't resume this run for a different goal.
    // Awaited so a failure is visible before the finally block runs, but does NOT
    // override the outcome -- the pipeline succeeded regardless of marking.
    const markResult = await deps.markPipelineRunComplete(opts.workspace, runId);
    if (markResult.isErr()) {
      deps.stderr(`[WARN full-pipeline] markPipelineRunComplete failed -- next run may resume this one: ${markResult.error}`);
    }
  } finally {
    // ── Pitch archival (ALWAYS -- success or failure) ──────────────────
    // WHY finally: if outcome is escalated (discovery failed, shaping failed,
    // coding failed, etc.), the pitch must still be archived so it doesn't
    // incorrectly route future tasks to IMPLEMENT mode. (Pitch invariant 11.)
    try {
      await deps.mkdir(archiveDir, { recursive: true });
      await deps.archiveFile(pitchPath, archivePath);
      deps.stderr(`[full-pipeline] Pitch archived to ${archivePath}`);
    } catch (e) {
      // Archive failure is logged but must not override the pipeline outcome.
      // WHY: if we throw here, the coordinator would have no outcome to return.
      deps.stderr(`[WARN full-pipeline] Failed to archive pitch.md: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return outcome;
}

/**
 * Core FULL pipeline logic (extracted so pitch archival is always in finally).
 */
async function runFullPipelineCore(
  deps: AdaptiveCoordinatorDeps,
  opts: AdaptivePipelineOpts,
  coordinatorStartMs: number,
  runId: string,
  initialPriorArtifacts: readonly PhaseHandoffArtifact[],
): Promise<PipelineOutcome> {
  // priorArtifacts accumulates phase handoffs as the pipeline progresses.
  // WHY spread (not push): immutability by default.
  let priorArtifacts: readonly PhaseHandoffArtifact[] = initialPriorArtifacts;

  // ── Stage 1: Discovery session ────────────────────────────────────────
  const discoveryCutoff = checkSpawnCutoff(coordinatorStartMs, deps.now(), 'discovery');
  if (discoveryCutoff) return discoveryCutoff;

  deps.stderr(`[full-pipeline] Spawning wr.discovery session`);

  const discoverySpawnResult = await deps.spawnSession(
    'wr.discovery',
    opts.goal,
    opts.workspace,
    undefined,
    { maxSessionMinutes: Math.ceil(DISCOVERY_TIMEOUT_MS / 60_000) },
  );

  if (discoverySpawnResult.kind === 'err') {
    return {
      kind: 'escalated',
      escalationReason: {
        phase: 'discovery',
        reason: `discovery session spawn failed: ${discoverySpawnResult.error}`,
      },
    };
  }

  const discoveryHandle = discoverySpawnResult.value;
  if (!discoveryHandle) {
    return {
      kind: 'escalated',
      escalationReason: { phase: 'discovery', reason: 'discovery session returned empty handle' },
    };
  }

  const discoveryAwait = await deps.awaitSessions([discoveryHandle], DISCOVERY_TIMEOUT_MS);
  const discoveryResult = discoveryAwait.results[0];

  if (!discoveryResult || discoveryResult.outcome !== 'success') {
    const outcome = discoveryResult?.outcome ?? 'not_found';
    return {
      kind: 'escalated',
      escalationReason: { phase: 'discovery', reason: `discovery session ${outcome}` },
    };
  }

  deps.stderr(`[full-pipeline] Discovery session completed`);

  // ── Stage 2: Context bridge ───────────────────────────────────────────
  let discoveryAgentResult: Awaited<ReturnType<typeof deps.getAgentResult>>;
  try {
    discoveryAgentResult = await deps.getAgentResult(discoveryHandle);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.stderr(`[coordinator] getAgentResult failed: ${msg}`);
    return {
      kind: 'escalated',
      escalationReason: { phase: 'discovery', reason: `getAgentResult threw: ${msg}` },
    };
  }

  const discoveryArtifact = extractPhaseArtifact(
    discoveryAgentResult.artifacts,
    DiscoveryHandoffArtifactV1Schema,
    isDiscoveryHandoffArtifact,
  );
  const discoveryPhaseResult = buildPhaseResult(discoveryArtifact, discoveryAgentResult.recapMarkdown);
  priorArtifacts = discoveryArtifact !== null ? [...priorArtifacts, discoveryArtifact] : priorArtifacts;

  // Persist discovery phase record -- escalate if write fails (no point starting shaping blind)
  const discoveryWriteResult = await deps.writePhaseRecord(opts.workspace, runId, {
    phase: 'discovery',
    record: { completedAt: deps.nowIso(), sessionHandle: discoveryHandle, result: discoveryPhaseResult },
  });
  if (discoveryWriteResult.isErr()) {
    deps.stderr(`[full-pipeline] FATAL: failed to persist discovery phase record: ${discoveryWriteResult.error}`);
    return { kind: 'escalated', escalationReason: { phase: 'discovery', reason: `context persistence failed: ${discoveryWriteResult.error}` } };
  }

  deps.stderr(`[full-pipeline] Discovery phase result: ${discoveryPhaseResult.kind}`);

  // Route on phase quality -- control flow from data state
  if (discoveryPhaseResult.kind === 'fallback') {
    return {
      kind: 'escalated',
      escalationReason: {
        phase: 'discovery',
        reason: 'discovery session produced no usable output (no artifact and no meaningful notes). Starting shaping blind would produce low-quality work. Fix the discovery session and resume.',
      },
    };
  }

  // Build context for shaping using accumulated artifacts
  const shapingContextSummary = buildContextSummary(priorArtifacts, 'shaping');
  // For partial completion, surface the quality gap to the shaping agent
  const partialWarning = discoveryPhaseResult.kind === 'partial'
    ? '\n\n**Note:** Discovery phase produced partial output only (no structured artifact). Context above is from session notes and may be incomplete.'
    : '';
  const shapingContext: CoordinatorSpawnContext | undefined = (shapingContextSummary || partialWarning)
    ? { assembledContextSummary: (shapingContextSummary + partialWarning).trim() }
    : undefined;

  // ── Stage 3: Shaping session ──────────────────────────────────────────
  const shapingCutoff = checkSpawnCutoff(coordinatorStartMs, deps.now(), 'shaping');
  if (shapingCutoff) return shapingCutoff;

  deps.stderr(`[full-pipeline] Spawning wr.shaping session`);

  const shapingSpawnResult = await deps.spawnSession(
    'wr.shaping',
    opts.goal,
    opts.workspace,
    shapingContext,
    { maxSessionMinutes: Math.ceil(SHAPING_TIMEOUT_MS / 60_000) },
  );

  if (shapingSpawnResult.kind === 'err') {
    return {
      kind: 'escalated',
      escalationReason: {
        phase: 'shaping',
        reason: `shaping session spawn failed: ${shapingSpawnResult.error}`,
      },
    };
  }

  const shapingHandle = shapingSpawnResult.value;
  if (!shapingHandle) {
    return {
      kind: 'escalated',
      escalationReason: { phase: 'shaping', reason: 'shaping session returned empty handle' },
    };
  }

  const shapingAwait = await deps.awaitSessions([shapingHandle], SHAPING_TIMEOUT_MS);
  const shapingResult = shapingAwait.results[0];

  if (!shapingResult || shapingResult.outcome !== 'success') {
    const outcome = shapingResult?.outcome ?? 'not_found';
    return {
      kind: 'escalated',
      escalationReason: { phase: 'shaping', reason: `shaping session ${outcome}` },
    };
  }

  deps.stderr(`[full-pipeline] Shaping session completed`);

  // Read shaping artifact + persist phase record + update priorArtifacts
  let shapingAgentResult: Awaited<ReturnType<typeof deps.getAgentResult>>;
  try {
    shapingAgentResult = await deps.getAgentResult(shapingHandle);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.stderr(`[coordinator] getAgentResult (shaping) failed: ${msg}`);
    shapingAgentResult = { recapMarkdown: null, artifacts: [] };
  }
  const shapingArtifact = extractPhaseArtifact(
    shapingAgentResult.artifacts,
    ShapingHandoffArtifactV1Schema,
    isShapingHandoffArtifact,
  );
  const shapingPhaseResult = buildPhaseResult(shapingArtifact, shapingAgentResult.recapMarkdown);
  priorArtifacts = shapingArtifact !== null ? [...priorArtifacts, shapingArtifact] : priorArtifacts;
  const shapingWriteResult = await deps.writePhaseRecord(opts.workspace, runId, {
    phase: 'shaping',
    record: { completedAt: deps.nowIso(), sessionHandle: shapingHandle, result: shapingPhaseResult },
  });
  if (shapingWriteResult.isErr()) {
    deps.stderr(`[full-pipeline] FATAL: failed to persist shaping phase record: ${shapingWriteResult.error}`);
    return { kind: 'escalated', escalationReason: { phase: 'shaping', reason: `context persistence failed: ${shapingWriteResult.error}` } };
  }
  deps.stderr(`[full-pipeline] Shaping phase result: ${shapingPhaseResult.kind}`);

  // Route on phase quality
  if (shapingPhaseResult.kind === 'fallback') {
    return {
      kind: 'escalated',
      escalationReason: {
        phase: 'shaping',
        reason: 'shaping session produced no usable output (no artifact and no meaningful notes). Starting coding blind would produce low-quality work. Fix the shaping session and resume.',
      },
    };
  }

  // ── Stage 4: UX Gate (Large complexity + touchesUI) ──────────────────
  // In FULL mode, complexity is considered Large because there is no pre-existing pitch.
  // (Pitch invariant 16: if touchesUI AND Large complexity -> require human outbox ack.)
  if (touchesUI(opts.goal)) {
    deps.stderr(`[full-pipeline] UX signals detected -- dispatching wr.ui-ux-design`);

    const uxCutoff = checkSpawnCutoff(coordinatorStartMs, deps.now(), 'ux-gate');
    if (uxCutoff) return uxCutoff;

    const uxSpawnResult = await deps.spawnSession(
      'wr.ui-ux-design',
      opts.goal,
      opts.workspace,
      { shapingComplete: true },
      { maxSessionMinutes: Math.ceil(REVIEW_TIMEOUT_MS / 60_000) },
    );

    if (uxSpawnResult.kind === 'err') {
      return {
        kind: 'escalated',
        escalationReason: {
          phase: 'ux-gate',
          reason: `UX design workflow spawn failed: ${uxSpawnResult.error}`,
        },
      };
    }

    const uxHandle = uxSpawnResult.value;
    if (!uxHandle) {
      return {
        kind: 'escalated',
        escalationReason: { phase: 'ux-gate', reason: 'UX design session returned empty handle' },
      };
    }

    const uxAwait = await deps.awaitSessions([uxHandle], REVIEW_TIMEOUT_MS);
    const uxResult = uxAwait.results[0];

    if (!uxResult || uxResult.outcome !== 'success') {
      const outcome = uxResult?.outcome ?? 'not_found';
      return {
        kind: 'escalated',
        escalationReason: { phase: 'ux-gate', reason: `UX design session ${outcome}` },
      };
    }

    deps.stderr(`[full-pipeline] UX design session completed -- requesting human acknowledgment`);

    // FULL mode (Large complexity) + touchesUI: require human outbox ack
    // before coding starts. Poll for 24 hours; timeout -> escalate.
    const ackRequestId = deps.generateId();
    try {
      await deps.postToOutbox(
        `UX design complete for "${opts.goal}" -- please review and acknowledge before coding starts`,
        {
          requestId: ackRequestId,
          goal: opts.goal,
          workspace: opts.workspace,
          phase: 'ux-gate',
          uxSessionHandle: uxHandle,
          note: 'Acknowledge this message to allow coding to begin. No response in 24h = escalation.',
        },
      );
    } catch (e) {
      // postToOutbox write failure is non-fatal -- UX gate ack poll still proceeds
      deps.stderr(`[WARN coordinator] postToOutbox failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const ackResult = await deps.pollOutboxAck(ackRequestId, UX_GATE_ACK_TIMEOUT_MS);
    if (ackResult === 'timeout') {
      try {
        await deps.postToOutbox(
          `UX gate timed out: no acknowledgment received within 24 hours for "${opts.goal}"`,
          { requestId: ackRequestId, goal: opts.goal, phase: 'ux-gate-timeout' },
        );
      } catch (e) {
        // postToOutbox write failure is non-fatal -- escalation still returns below
        deps.stderr(`[WARN coordinator] postToOutbox failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return {
        kind: 'escalated',
        escalationReason: {
          phase: 'ux-gate',
          reason: 'no human acknowledgment received within 24 hours',
        },
      };
    }

    deps.stderr(`[full-pipeline] UX gate acknowledged -- proceeding to coding`);
  }

  // ── Stage 5: Coding session ───────────────────────────────────────────
  const codingCutoff = checkSpawnCutoff(coordinatorStartMs, deps.now(), 'coding');
  if (codingCutoff) return codingCutoff;

  deps.stderr(`[full-pipeline] Spawning wr.coding-task`);

  const codingContextSummary = buildContextSummary(priorArtifacts, 'coding');
  const shapingPartialWarning = shapingPhaseResult.kind === 'partial'
    ? '\n\n**Note:** Shaping phase produced partial output only (no structured artifact). Context above is from session notes and may be incomplete.'
    : '';
  const discoveryPartialWarning = discoveryPhaseResult.kind === 'partial'
    ? '\n\n**Note:** Discovery phase produced partial output only (no structured artifact). Some upstream context may be missing.'
    : '';
  const codingWarnings = discoveryPartialWarning + shapingPartialWarning;
  const codingFullContext = (codingContextSummary + codingWarnings).trim();
  const codingContext: CoordinatorSpawnContext | undefined = codingFullContext
    ? { pitchPath: opts.workspace + '/.workrail/current-pitch.md', assembledContextSummary: codingFullContext }
    : undefined;
  const codingSpawnResult = await deps.spawnSession(
    'wr.coding-task',
    opts.goal,
    opts.workspace,
    codingContext,
    { maxSessionMinutes: Math.ceil(CODING_TIMEOUT_MS / 60_000) },
  );

  if (codingSpawnResult.kind === 'err') {
    return {
      kind: 'escalated',
      escalationReason: {
        phase: 'coding',
        reason: `coding session spawn failed: ${codingSpawnResult.error}`,
      },
    };
  }

  const codingHandle = codingSpawnResult.value;
  if (!codingHandle) {
    return {
      kind: 'escalated',
      escalationReason: { phase: 'coding', reason: 'coding session returned empty handle' },
    };
  }

  const codingAwait = await deps.awaitSessions([codingHandle], CODING_TIMEOUT_MS);
  const codingResult = codingAwait.results[0];

  if (!codingResult || codingResult.outcome !== 'success') {
    const outcome = codingResult?.outcome ?? 'not_found';
    return {
      kind: 'escalated',
      escalationReason: { phase: 'coding', reason: `coding session ${outcome}` },
    };
  }

  deps.stderr(`[full-pipeline] Coding session completed`);

  // Read coding artifact + persist phase record + update priorArtifacts
  let codingAgentResult: Awaited<ReturnType<typeof deps.getAgentResult>>;
  try {
    codingAgentResult = await deps.getAgentResult(codingHandle);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.stderr(`[coordinator] getAgentResult (coding) failed: ${msg}`);
    codingAgentResult = { recapMarkdown: null, artifacts: [] };
  }
  const codingArtifact = extractPhaseArtifact(
    codingAgentResult.artifacts,
    CodingHandoffArtifactV1Schema,
    isCodingHandoffArtifact,
  );
  const codingPhaseResult = buildPhaseResult(codingArtifact, codingAgentResult.recapMarkdown);
  priorArtifacts = codingArtifact !== null ? [...priorArtifacts, codingArtifact] : priorArtifacts;
  const codingWriteResult = await deps.writePhaseRecord(opts.workspace, runId, {
    phase: 'coding',
    record: { completedAt: deps.nowIso(), sessionHandle: codingHandle, result: codingPhaseResult },
  });
  if (codingWriteResult.isErr()) {
    deps.stderr(`[full-pipeline] FATAL: failed to persist coding phase record: ${codingWriteResult.error}`);
    return { kind: 'escalated', escalationReason: { phase: 'coding', reason: `context persistence failed: ${codingWriteResult.error}` } };
  }
  deps.stderr(`[full-pipeline] Coding phase result: ${codingPhaseResult.kind}`);

  // Route on phase quality -- a fallback coding phase means the review agent
  // would have no decisions/limitations context, making review nearly blind.
  if (codingPhaseResult.kind === 'fallback') {
    return {
      kind: 'escalated',
      escalationReason: {
        phase: 'coding',
        reason: 'coding session produced no usable output (no artifact and no meaningful notes). Starting review blind would miss design-level issues. Fix the coding session and resume.',
      },
    };
  }

  // ── Stage 6: Poll for PR ──────────────────────────────────────────────
  const branchPattern = `worktrain/${codingHandle.slice(0, 16)}`;
  deps.stderr(`[full-pipeline] Polling for PR on branch pattern: ${branchPattern}`);

  let prUrl: string | null;
  try {
    prUrl = await deps.pollForPR(branchPattern, PR_POLL_TIMEOUT_MS);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.stderr(`[coordinator] pollForPR threw: ${msg}`);
    return {
      kind: 'escalated',
      escalationReason: { phase: 'pr-detection', reason: `pollForPR threw: ${msg}` },
    };
  }
  if (!prUrl) {
    return {
      kind: 'escalated',
      escalationReason: {
        phase: 'pr-detection',
        reason: `no PR found matching ${branchPattern} within ${PR_POLL_TIMEOUT_MS / 60000} minutes`,
      },
    };
  }

  deps.stderr(`[full-pipeline] PR detected: ${prUrl}`);

  // ── Stage 7: Review + verdict routing ────────────────────────────────
  return runReviewAndVerdictCycle(deps, opts, prUrl, coordinatorStartMs, 0, runId, priorArtifacts);
}
