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
 *    - Dispatch ui-ux-design-workflow
 *    - Require human outbox acknowledgment (poll 24 hours; timeout -> escalate)
 * 5. Spawn coding-task-workflow-agentic with pitchPath in context (65 minute timeout)
 * 6. Poll for PR (up to 5 minutes)
 * 7. Dispatch mr-review-workflow-agentic (25 minute timeout)
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
} from '../../v2/durable-core/schemas/artifacts/discovery-handoff.js';
import { runReviewAndVerdictCycle } from './implement-shared.js';
import { touchesUI } from './implement.js';

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
 */
export async function runFullPipeline(
  deps: AdaptiveCoordinatorDeps,
  opts: AdaptivePipelineOpts,
  coordinatorStartMs: number,
): Promise<PipelineOutcome> {
  deps.stderr(`[full-pipeline] Starting FULL pipeline for workspace=${opts.workspace}`);

  // ── Stage 1: Discovery session ────────────────────────────────────────
  const discoveryCutoff = checkSpawnCutoff(coordinatorStartMs, deps.now(), 'discovery');
  if (discoveryCutoff) return discoveryCutoff;

  deps.stderr(`[full-pipeline] Spawning wr.discovery session`);

  const discoverySpawnResult = await deps.spawnSession(
    'wr.discovery',
    opts.goal,
    opts.workspace,
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
  // Read discovery handoff artifact and build shaping context.
  // (Pitch invariant 12: try artifact first; fallback to lastStepNotes if length > 50)

  const discoveryAgentResult = await deps.getAgentResult(discoveryHandle);
  const handoffArtifact = readDiscoveryHandoffArtifact(
    discoveryAgentResult.artifacts,
    discoveryHandle,
    deps.stderr,
  );

  let shapingContext: Readonly<Record<string, unknown>>;

  if (handoffArtifact !== null) {
    // Primary path: inject structured discovery handoff context into shaping
    deps.stderr(`[full-pipeline] Discovery handoff artifact found -- injecting structured context`);
    shapingContext = {
      selectedDirection: handoffArtifact.selectedDirection,
      designDocPath: handoffArtifact.designDocPath,
      assembledContextSummary: renderHandoff(handoffArtifact),
    };
  } else {
    // Fallback path: use raw step notes as context summary (if long enough)
    const notes = discoveryAgentResult.recapMarkdown;
    if (notes !== null && notes.trim().length > MIN_NOTES_LENGTH_FOR_FALLBACK) {
      deps.stderr(`[full-pipeline] No handoff artifact -- using lastStepNotes as context (length=${notes.trim().length})`);
      shapingContext = { assembledContextSummary: notes.trim() };
    } else {
      // Notes too short or null -- proceed without assembledContextSummary
      const reason = notes === null ? 'null' : `length=${notes.trim().length} <= ${MIN_NOTES_LENGTH_FOR_FALLBACK}`;
      deps.stderr(`[full-pipeline] No handoff artifact and notes too short (${reason}) -- proceeding without context`);
      shapingContext = {};
    }
  }

  // ── Stage 3: Shaping session ──────────────────────────────────────────
  const shapingCutoff = checkSpawnCutoff(coordinatorStartMs, deps.now(), 'shaping');
  if (shapingCutoff) return shapingCutoff;

  deps.stderr(`[full-pipeline] Spawning wr.shaping session`);

  const shapingSpawnResult = await deps.spawnSession(
    'wr.shaping',
    opts.goal,
    opts.workspace,
    shapingContext,
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

  // ── Stage 4: UX Gate (Large complexity + touchesUI) ──────────────────
  // In FULL mode, complexity is considered Large because there is no pre-existing pitch.
  // (Pitch invariant 16: if touchesUI AND Large complexity -> require human outbox ack.)
  if (touchesUI(opts.goal)) {
    deps.stderr(`[full-pipeline] UX signals detected -- dispatching ui-ux-design-workflow`);

    const uxCutoff = checkSpawnCutoff(coordinatorStartMs, deps.now(), 'ux-gate');
    if (uxCutoff) return uxCutoff;

    const uxSpawnResult = await deps.spawnSession(
      'ui-ux-design-workflow',
      opts.goal,
      opts.workspace,
      { shapingComplete: true },
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

    const ackResult = await deps.pollOutboxAck(ackRequestId, UX_GATE_ACK_TIMEOUT_MS);
    if (ackResult === 'timeout') {
      await deps.postToOutbox(
        `UX gate timed out: no acknowledgment received within 24 hours for "${opts.goal}"`,
        { requestId: ackRequestId, goal: opts.goal, phase: 'ux-gate-timeout' },
      );
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

  deps.stderr(`[full-pipeline] Spawning coding-task-workflow-agentic`);

  const codingSpawnResult = await deps.spawnSession(
    'coding-task-workflow-agentic',
    opts.goal,
    opts.workspace,
    {
      // Belt-and-suspenders: pass pitchPath explicitly (pitch invariant 13)
      // The shaping session should have created current-pitch.md
      pitchPath: opts.workspace + '/.workrail/current-pitch.md',
    },
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

  // ── Stage 6: Poll for PR ──────────────────────────────────────────────
  const branchPattern = `worktrain/${codingHandle.slice(0, 16)}`;
  deps.stderr(`[full-pipeline] Polling for PR on branch pattern: ${branchPattern}`);

  const prUrl = await deps.pollForPR(branchPattern, PR_POLL_TIMEOUT_MS);
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
  return runReviewAndVerdictCycle(deps, opts, prUrl, coordinatorStartMs, 0);
}
