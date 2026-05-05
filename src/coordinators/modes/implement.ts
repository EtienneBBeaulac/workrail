/**
 * IMPLEMENT Pipeline Mode Executor
 *
 * Executes the coding + PR review pipeline for tasks with a pre-existing pitch.
 *
 * Step sequence:
 * 1. [UX Gate] If goal contains UI-touching signals, dispatch wr.ui-ux-design first
 *    - If FULL complexity and touchesUI: require human outbox ack before coding starts
 * 2. Spawn wr.coding-task with pitchPath in context
 * 3. Poll for PR (gh pr list --head worktrain/<sessionId>) -- up to 5 minutes
 * 4. Dispatch wr.mr-review for the created PR
 * 5. Route verdict:
 *    - clean: merge
 *    - minor: fix loop (max 2 iterations)
 *    - blocking/critical: audit chain -> re-review -> (still critical) -> escalate
 * 6. Archive pitch.md (success or failure) -- ALWAYS in finally block
 *
 * Design invariants:
 * - Pitch archival ALWAYS happens in a finally block (pitch invariant 11).
 *   "After the coding session ends (success or failure)" -- explicit in spec.
 * - Fix loop is capped at exactly 2 iterations (pitch invariant 15).
 * - findingCategory is NOT in the verdict schema (rabbit hole #5):
 *   all Critical findings dispatch wr.production-readiness-audit (safe default).
 *   TODO(follow-up): add findingCategory to ReviewVerdictArtifactV1 schema.
 * - COORDINATOR_SPAWN_CUTOFF_MS is checked before every spawn via checkSpawnCutoff().
 */

import { ok as okResult } from 'neverthrow';
import type { AdaptiveCoordinatorDeps, AdaptivePipelineOpts, PipelineOutcome } from '../adaptive-pipeline.js';
import {
  CODING_TIMEOUT_MS,
  REVIEW_TIMEOUT_MS,
  checkSpawnCutoff,
} from '../adaptive-pipeline.js';
import { runReviewAndVerdictCycle, MAX_FIX_ITERATIONS } from './implement-shared.js';
import { extractPhaseArtifact, buildContextSummary } from '../context-assembly.js';
import { buildPhaseResult } from '../pipeline-run-context.js';
import type { PhaseHandoffArtifact } from '../../v2/durable-core/schemas/artifacts/index.js';
import { isCodingHandoffArtifact, CodingHandoffArtifactV1Schema } from '../../v2/durable-core/schemas/artifacts/index.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * PR poll timeout: 5 minutes.
 * After 5 minutes with no PR: escalate (pitch element 4).
 */
const PR_POLL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * UI-touching keyword signals (case-insensitive).
 * If the goal contains any of these, dispatch wr.ui-ux-design first.
 * (Pitch invariant 16.)
 */
const UI_KEYWORDS = [
  'ui', 'screen', 'view', 'layout', 'component', 'design', 'ux', 'frontend',
] as const;

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Returns true if the goal contains UI-touching keywords.
 * Used for UX gate detection (pitch invariant 16).
 */
export function touchesUI(goal: string): boolean {
  const lower = goal.toLowerCase();
  return UI_KEYWORDS.some((kw) => lower.includes(kw));
}

// ═══════════════════════════════════════════════════════════════════════════
// IMPLEMENT MODE EXECUTOR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run the IMPLEMENT pipeline mode.
 *
 * INVARIANT: pitch.md is archived in a finally block regardless of outcome.
 * This prevents stale pitch.md from incorrectly routing future tasks to IMPLEMENT.
 */
export async function runImplementPipeline(
  deps: AdaptiveCoordinatorDeps,
  opts: AdaptivePipelineOpts,
  pitchPath: string,
  coordinatorStartMs: number,
): Promise<PipelineOutcome> {
  deps.stderr(`[implement] Starting IMPLEMENT pipeline for workspace=${opts.workspace}`);

  // ── Stage 0: Pitch archival setup ─────────────────────────────────────
  // Build the archive path now so it's available in the finally block
  const archiveDir = opts.workspace + '/.workrail/used-pitches';
  const archiveTimestamp = deps.nowIso().replace(/[:.]/g, '-');
  const archivePath = archiveDir + '/pitch-' + archiveTimestamp + '.md';

  // Crash recovery: same check as FULL mode. For IMPLEMENT, readActiveRunId may find a prior
  // in-progress run, but extractPriorArtifactsFromContext will return [] because IMPLEMENT
  // context files never have discovery or shaping phase records. The runId is still reused
  // so writePhaseRecord can append to the existing file on resume.
  const activeRunResult = await deps.readActiveRunId(opts.workspace);
  const priorRunId = activeRunResult.isOk() ? activeRunResult.value : null;
  const runId = priorRunId ?? deps.generateRunId();

  const initResult = priorRunId
    ? okResult(undefined)  // existing context file already initialized on prior run
    : await deps.createPipelineContext(opts.workspace, runId, opts.goal, 'IMPLEMENT');
  if (initResult.isErr()) {
    deps.stderr(`[implement] FATAL: failed to initialize PipelineRunContext: ${initResult.error}`);
    return { kind: 'escalated', escalationReason: { phase: 'init', reason: `PipelineRunContext initialization failed: ${initResult.error}` } };
  }

  let outcome: PipelineOutcome;

  try {
    outcome = await runImplementCore(deps, opts, pitchPath, coordinatorStartMs, runId);
    void deps.markPipelineRunComplete(opts.workspace, runId).then(r => {
      if (r.isErr()) deps.stderr(`[WARN implement] markPipelineRunComplete failed: ${r.error}`);
    });
  } finally {
    // ── Pitch archival (ALWAYS -- success or failure) ──────────────────
    // WHY finally: if outcome is escalated (coding session failed, review failed,
    // etc.), the pitch must still be archived so it doesn't route future tasks
    // to IMPLEMENT mode incorrectly. (Pitch invariant 11: "success or failure".)
    try {
      await deps.mkdir(archiveDir, { recursive: true });
      await deps.archiveFile(pitchPath, archivePath);
      deps.stderr(`[implement] Pitch archived to ${archivePath}`);
    } catch (e) {
      // Archive failure is logged but must not override the pipeline outcome.
      // WHY: if we throw here, the coordinator would have no outcome to return.
      deps.stderr(`[WARN implement] Failed to archive pitch.md: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return outcome;
}

/**
 * Core IMPLEMENT pipeline logic (extracted so pitch archival is always in finally).
 */
async function runImplementCore(
  deps: AdaptiveCoordinatorDeps,
  opts: AdaptivePipelineOpts,
  pitchPath: string,
  coordinatorStartMs: number,
  runId: string,
): Promise<PipelineOutcome> {
  // IMPLEMENT mode starts with the pitch already shaped -- no prior phase artifacts to restore.
  // priorArtifacts starts empty; coding handoff will be accumulated below.
  const priorArtifacts: readonly PhaseHandoffArtifact[] = [];

  // ── Stage 1: UX Gate ─────────────────────────────────────────────────
  if (touchesUI(opts.goal)) {
    deps.stderr(`[implement] UX signals detected in goal, dispatching wr.ui-ux-design`);

    const cutoffCheck = checkSpawnCutoff(coordinatorStartMs, deps.now(), 'ux-gate');
    if (cutoffCheck) return cutoffCheck;

    const uxSpawnResult = await deps.spawnSession('wr.ui-ux-design', opts.goal, opts.workspace, {
      pitchPath,
    });

    if (uxSpawnResult.kind === 'err') {
      deps.stderr(`[implement] UX gate spawn failed: ${uxSpawnResult.error}`);
      return {
        kind: 'escalated',
        escalationReason: { phase: 'ux-gate', reason: `UX gate spawn failed: ${uxSpawnResult.error}` },
      };
    }

    const uxHandle = uxSpawnResult.value;
    if (!uxHandle || uxHandle.trim() === '') {
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

    deps.stderr(`[implement] UX design session completed`);

    // For IMPLEMENT mode, complexity is "Medium" (pitch.md exists = pre-designed).
    // Large complexity UX gate (human ack) applies only to FULL mode.
    // NOTE: The pitch says Large complexity + touchesUI requires human outbox ack.
    // IMPLEMENT mode always has a pitch (pre-designed) so complexity is not Large
    // in the discovery sense. We skip the outbox ack gate here.
    // The FULL pipeline (full-pipeline.ts) handles the Large+touchesUI case.
  }

  // ── Stage 2: Spawn coding session ────────────────────────────────────
  const cutoffCheck = checkSpawnCutoff(coordinatorStartMs, deps.now(), 'coding');
  if (cutoffCheck) return cutoffCheck;

  deps.stderr(`[implement] Spawning wr.coding-task`);

  const codingSpawnResult = await deps.spawnSession(
    'wr.coding-task',
    opts.goal,
    opts.workspace,
    {
      // Belt-and-suspenders: pass pitchPath explicitly (pitch invariant 13)
      pitchPath,
    },
  );

  if (codingSpawnResult.kind === 'err') {
    return {
      kind: 'escalated',
      escalationReason: { phase: 'coding', reason: `coding session spawn failed: ${codingSpawnResult.error}` },
    };
  }

  const codingHandle = codingSpawnResult.value;
  if (!codingHandle) {
    return {
      kind: 'escalated',
      escalationReason: { phase: 'coding', reason: 'coding session returned empty handle (zombie detection)' },
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

  deps.stderr(`[implement] Coding session completed (${Math.round((codingResult.durationMs ?? 0) / 1000)}s)`);

  // Read coding artifact + write phase record
  let codingAgentResult: Awaited<ReturnType<typeof deps.getAgentResult>>;
  try {
    codingAgentResult = await deps.getAgentResult(codingHandle);
  } catch {
    codingAgentResult = { recapMarkdown: null, artifacts: [] };
  }
  const codingArtifact = extractPhaseArtifact(codingAgentResult.artifacts, CodingHandoffArtifactV1Schema, isCodingHandoffArtifact);
  const codingPhaseResult = buildPhaseResult(codingArtifact, codingAgentResult.recapMarkdown);
  const updatedPriorArtifacts = codingArtifact !== null ? [...priorArtifacts, codingArtifact] : priorArtifacts;
  const codingWriteResult = await deps.writePhaseRecord(opts.workspace, runId, {
    phase: 'coding',
    record: { completedAt: deps.nowIso(), sessionHandle: codingHandle, result: codingPhaseResult },
  });
  if (codingWriteResult.isErr()) {
    deps.stderr(`[implement] FATAL: failed to persist coding phase record: ${codingWriteResult.error}`);
    return { kind: 'escalated', escalationReason: { phase: 'coding', reason: `context persistence failed: ${codingWriteResult.error}` } };
  }

  // Route on phase quality -- review agent needs coding decisions to be useful
  if (codingPhaseResult.kind === 'fallback') {
    return {
      kind: 'escalated',
      escalationReason: {
        phase: 'coding',
        reason: 'coding session produced no usable output (no artifact and no meaningful notes). Starting review blind would miss design-level issues. Fix the coding session and resume.',
      },
    };
  }

  // ── Stage 3: Poll for PR ──────────────────────────────────────────────
  const branchPattern = `worktrain/${codingHandle.slice(0, 16)}`;
  deps.stderr(`[implement] Polling for PR on branch pattern: ${branchPattern}`);

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

  deps.stderr(`[implement] PR detected: ${prUrl}`);

  // ── Stage 4: Review + verdict routing ────────────────────────────────
  return runReviewAndVerdictCycle(deps, opts, prUrl, coordinatorStartMs, 0, runId, updatedPriorArtifacts);
}
