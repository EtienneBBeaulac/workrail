/**
 * Adaptive Pipeline Coordinator
 *
 * Entry point for WorkTrain's autonomous task routing and multi-phase execution.
 * Routes tasks to QUICK_REVIEW, REVIEW_ONLY, IMPLEMENT, or FULL pipeline modes
 * based on static signals in the task goal and workspace state.
 *
 * Design invariants:
 * - routeTask() is called BEFORE any session is spawned or log is written.
 * - Routing log is written BEFORE any session is spawned.
 * - All I/O is injected via AdaptiveCoordinatorDeps. Zero direct fs/fetch/exec imports.
 * - All phase failures produce PipelineOutcome { kind: 'escalated' } -- never thrown.
 * - COORDINATOR_SPAWN_CUTOFF_MS is checked before every spawn point.
 *
 * Timeout constants (hardcoded, never LLM-computed -- pitch invariant 17):
 * - Discovery: 35 minutes
 * - Shaping: 35 minutes
 * - Coding: 65 minutes
 * - Review (child): 25 minutes
 * - Refuse new spawns after: 100 minutes
 * - Total wall-clock cap: 120 minutes
 *
 * WHY separate timeout constants for spawn cutoff vs. total cap:
 * At 35+35+65 = 135 minutes, a maximally slow FULL pipeline can exceed the 120m cap.
 * The COORDINATOR_SPAWN_CUTOFF_MS (100m) guard prevents new spawns after 100 minutes
 * of elapsed time. Phases already started run to their per-phase timeout.
 * This resolves the budget conflict without reducing per-phase budgets (rabbit hole #2).
 */

import type { CoordinatorDeps } from './pr-review.js';
import { routeTask, extractPrNumbers } from './routing/route-task.js';
import type { PipelineMode } from './routing/route-task.js';

// ═══════════════════════════════════════════════════════════════════════════
// TIMEOUT CONSTANTS (hardcoded, never LLM-computed)
// ═══════════════════════════════════════════════════════════════════════════

/** Discovery session timeout: 35 minutes. */
export const DISCOVERY_TIMEOUT_MS = 35 * 60 * 1000;

/** Shaping session timeout: 35 minutes. */
export const SHAPING_TIMEOUT_MS = 35 * 60 * 1000;

/** Coding session timeout: 65 minutes. */
export const CODING_TIMEOUT_MS = 65 * 60 * 1000;

/** Review session timeout (child): 25 minutes. */
export const REVIEW_TIMEOUT_MS = 25 * 60 * 1000;

/**
 * Coordinator spawn cutoff: refuse new spawns after 100 minutes of elapsed time.
 *
 * WHY 100 minutes (not 120):
 * Provides a 20-minute buffer before the total cap to allow any in-flight
 * session to complete within the COORDINATOR_MAX_MS wall-clock limit.
 * A phase started at exactly 100m has up to 20m to finish before the coordinator
 * exits at 120m.
 */
export const COORDINATOR_SPAWN_CUTOFF_MS = 100 * 60 * 1000;

/**
 * Total coordinator wall-clock cap: 120 minutes.
 * The coordinator must exit (escalate) by this time regardless of phase status.
 */
export const COORDINATOR_MAX_MS = 120 * 60 * 1000;

// ═══════════════════════════════════════════════════════════════════════════
// DOMAIN TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Outcome of a full adaptive pipeline run.
 *
 * WHY discriminated union (not boolean flags):
 * A plain `{ merged: boolean; escalated: boolean }` object allows the illegal
 * state `merged: true && escalated: true` at runtime. The discriminated union
 * makes this state unrepresentable at compile time.
 *
 * - 'merged': pipeline ran to completion and the PR was auto-merged
 * - 'escalated': a phase failed or the review found blocking/critical findings;
 *   structured reason is available for the operator
 * - 'dry_run': pipeline ran in dry-run mode (no spawns, no merges)
 */
export type PipelineOutcome =
  | { readonly kind: 'merged'; readonly prUrl: string | null }
  | {
      readonly kind: 'escalated';
      readonly escalationReason: {
        readonly phase: string;
        readonly reason: string;
      };
    }
  | { readonly kind: 'dry_run'; readonly mode: string };

/**
 * Options for running the adaptive pipeline.
 */
export interface AdaptivePipelineOpts {
  /** Absolute path to the git workspace. */
  readonly workspace: string;
  /** The task goal string. */
  readonly goal: string;
  /** If true, print actions without executing HTTP calls or git operations. */
  readonly dryRun?: boolean;
  /** Override the console HTTP server port. */
  readonly port?: number;
  /** Explicit pipeline mode override (bypasses static routing). */
  readonly modeOverride?: 'QUICK_REVIEW' | 'REVIEW_ONLY' | 'IMPLEMENT' | 'FULL';
  /** Trigger provider name (for queue poller integration). */
  readonly triggerProvider?: string;
  /**
   * Task candidate from the queue poller (Option B in-process integration).
   *
   * WHY: taskCandidate comes from the github_queue_poll provider, NOT github_prs_poll.
   * The PR poll trigger (github_prs_poll) passes triggerProvider directly in opts and
   * never sets taskCandidate. These are two completely separate dispatch paths.
   * Do NOT infer triggerProvider from taskCandidate presence.
   */
  readonly taskCandidate?: Readonly<Record<string, unknown>>;
}

/**
 * Injectable dependencies for the adaptive pipeline coordinator.
 *
 * Extends CoordinatorDeps with new methods needed for multi-phase coordination.
 *
 * WHY extends CoordinatorDeps (not a standalone interface):
 * REVIEW_ONLY and QUICK_REVIEW modes delegate to runPrReviewCoordinator()
 * which requires CoordinatorDeps. Extending avoids duplicating the interface.
 */
export interface AdaptiveCoordinatorDeps extends CoordinatorDeps {
  /**
   * Check whether a file exists at the given path.
   * Used by routeTask() for pitch.md detection.
   * WHY sync (not async): routeTask() is a pure synchronous function.
   */
  fileExists(path: string): boolean;

  /**
   * Move a file from src to dest (archive).
   * Used by IMPLEMENT mode to archive current-pitch.md after completion.
   * Always called in a finally block (success or failure).
   */
  archiveFile(src: string, dest: string): Promise<void>;

  /**
   * Poll for a PR matching the given branch pattern.
   * Returns the PR URL on success, null if no PR found within the timeout.
   *
   * Implementation: poll `gh pr list --head <branchPattern>` every 30 seconds.
   * After timeoutMs with no PR: return null (coordinator escalates).
   */
  pollForPR(branchPattern: string, timeoutMs: number): Promise<string | null>;

  /**
   * Post a structured message to the human outbox.
   * Used for escalation notices and UX gate acknowledgment requests.
   */
  postToOutbox(message: string, metadata: Readonly<Record<string, unknown>>): Promise<void>;

  /**
   * Poll the outbox for a human acknowledgment response.
   * Returns 'acked' when the human responds, 'timeout' after timeoutMs.
   *
   * Used by the UX gate for large complexity tasks: polls every 5 minutes,
   * times out after 24 hours if no acknowledgment is received.
   */
  pollOutboxAck(requestId: string, timeoutMs: number): Promise<'acked' | 'timeout'>;
}

// ═══════════════════════════════════════════════════════════════════════════
// MODE EXECUTOR TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Function signatures for mode executors.
 * These are passed as injectable functions to allow tests to substitute fakes
 * and to break circular module dependencies.
 */
export interface ModeExecutors {
  readonly runQuickReview: (
    deps: AdaptiveCoordinatorDeps,
    opts: AdaptivePipelineOpts,
    prNumbers: readonly number[],
    coordinatorStartMs: number,
  ) => Promise<PipelineOutcome>;

  readonly runReviewOnly: (
    deps: AdaptiveCoordinatorDeps,
    opts: AdaptivePipelineOpts,
    prNumbers: readonly number[],
    coordinatorStartMs: number,
  ) => Promise<PipelineOutcome>;

  readonly runImplement: (
    deps: AdaptiveCoordinatorDeps,
    opts: AdaptivePipelineOpts,
    pitchPath: string,
    coordinatorStartMs: number,
  ) => Promise<PipelineOutcome>;

  readonly runFull: (
    deps: AdaptiveCoordinatorDeps,
    opts: AdaptivePipelineOpts,
    coordinatorStartMs: number,
  ) => Promise<PipelineOutcome>;
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTING LOG
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Structure of the routing decision log entry.
 * Written to .workrail/pipeline-runs/[ISO-timestamp]-[mode].json BEFORE any session spawns.
 */
export interface RoutingLogEntry {
  readonly timestamp: string;
  readonly mode: string;
  readonly goal: string;
  readonly workspace: string;
  readonly signals: {
    readonly depBumpKeyword: boolean;
    readonly prReference: boolean;
    readonly pitchFilePresent: boolean;
    readonly githubPrsPollProvider: boolean;
    readonly modeOverride: string | null;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SPAWN CUTOFF HELPER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check whether the coordinator has exceeded its spawn cutoff time.
 *
 * Returns an escalation PipelineOutcome if the cutoff has been reached.
 * Returns null if it's safe to spawn.
 *
 * WHY a helper (not inline checks):
 * FULL mode has 4+ spawn points. Centralizing the check prevents missed
 * spawn points, which would allow the coordinator to run past COORDINATOR_MAX_MS.
 */
export function checkSpawnCutoff(
  coordinatorStartMs: number,
  now: number,
  phase: string,
): PipelineOutcome | null {
  if (now - coordinatorStartMs > COORDINATOR_SPAWN_CUTOFF_MS) {
    return {
      kind: 'escalated',
      escalationReason: {
        phase,
        reason: `coordinator elapsed > ${COORDINATOR_SPAWN_CUTOFF_MS / 60000} minutes, refusing new spawns`,
      },
    };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run the adaptive pipeline coordinator.
 *
 * Stages:
 * 1. Route the task to a pipeline mode (static rules, no LLM)
 * 2. Write the routing log (before any session spawns)
 * 3. Dispatch to the appropriate mode executor
 * 4. Return PipelineOutcome
 *
 * The mode executors are passed as `executors` to break circular module
 * dependencies and to allow tests to inject fakes. The real wiring is done
 * in the CLI entry point (src/cli/commands/worktrain-pipeline.ts) and the
 * TriggerRouter (src/trigger/trigger-router.ts).
 *
 * Called by:
 * - CLI: worktrain run pipeline --workspace <path> --goal <text>
 * - Queue poller: TriggerRouter.dispatchAdaptivePipeline() (Option B in-process)
 */
export async function runAdaptivePipeline(
  deps: AdaptiveCoordinatorDeps,
  opts: AdaptivePipelineOpts,
  executors: ModeExecutors,
): Promise<PipelineOutcome> {
  const coordinatorStartMs = deps.now();

  // ── Step 1: Determine trigger provider ──────────────────────────────────
  // WHY: opts.triggerProvider is the authoritative source of provider identity.
  // taskCandidate comes from github_queue_poll (not github_prs_poll) -- do NOT
  // infer provider from its presence. The PR poller passes triggerProvider
  // directly; the queue poller sets taskCandidate but leaves triggerProvider
  // undefined, which correctly falls through to Rule 3 (IMPLEMENT) or Rule 4 (FULL).
  const triggerProvider = opts.triggerProvider;

  // ── Step 2: Route the task (pure function, no I/O except fileExists) ────
  let pipelineMode: PipelineMode;

  if (opts.modeOverride) {
    // Explicit mode override -- bypass static routing
    pipelineMode = buildModeFromOverride(opts.modeOverride, opts.goal, opts.workspace);
  } else {
    pipelineMode = routeTask(opts.goal, opts.workspace, deps, triggerProvider);
  }

  // ── Step 3: Write routing log (before any spawns) ───────────────────────
  const logEntry: RoutingLogEntry = {
    timestamp: deps.nowIso(),
    mode: pipelineMode.kind,
    goal: opts.goal,
    workspace: opts.workspace,
    signals: {
      depBumpKeyword: hasDepBumpKeyword(opts.goal),
      prReference: hasPrReference(opts.goal),
      pitchFilePresent: pipelineMode.kind === 'IMPLEMENT',
      githubPrsPollProvider: triggerProvider === 'github_prs_poll',
      modeOverride: opts.modeOverride ?? null,
    },
  };

  const runsDir = opts.workspace + '/.workrail/pipeline-runs';
  const logPath = runsDir + '/' + deps.nowIso().replace(/[:.]/g, '-') + '-' + pipelineMode.kind + '.json';

  try {
    await deps.mkdir(runsDir, { recursive: true });
    await deps.writeFile(logPath, JSON.stringify(logEntry, null, 2) + '\n');
  } catch (e) {
    // Routing log failure is non-fatal -- coordinator still runs.
    // WHY: the routing log is for traceability, not correctness. A failed write
    // must not prevent the pipeline from executing.
    deps.stderr(`[WARN adaptive-pipeline] Failed to write routing log: ${e instanceof Error ? e.message : String(e)}`);
  }

  deps.stderr(`[adaptive-pipeline] Routing: mode=${pipelineMode.kind} goal="${opts.goal.slice(0, 80)}"`);

  // ── Step 4: Dry-run shortcut ─────────────────────────────────────────────
  if (opts.dryRun) {
    deps.stderr(`[adaptive-pipeline] Dry run: would execute ${pipelineMode.kind} pipeline`);
    return { kind: 'dry_run', mode: pipelineMode.kind };
  }

  // ── Step 5: Dispatch to mode executor ───────────────────────────────────
  switch (pipelineMode.kind) {
    case 'QUICK_REVIEW':
      return executors.runQuickReview(deps, opts, pipelineMode.prNumbers, coordinatorStartMs);

    case 'REVIEW_ONLY':
      return executors.runReviewOnly(deps, opts, pipelineMode.prNumbers, coordinatorStartMs);

    case 'IMPLEMENT':
      return executors.runImplement(deps, opts, pipelineMode.pitchPath, coordinatorStartMs);

    case 'FULL':
      return executors.runFull(deps, opts, coordinatorStartMs);

    case 'ESCALATE': {
      const reason = pipelineMode.reason;
      deps.stderr(`[adaptive-pipeline] Routing escalation: ${reason}`);
      await deps.postToOutbox(
        `Adaptive pipeline escalated during routing: ${reason}`,
        { goal: opts.goal, workspace: opts.workspace, phase: 'routing' },
      );
      return {
        kind: 'escalated',
        escalationReason: { phase: 'routing', reason },
      };
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PRIVATE HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a PipelineMode from an explicit --mode CLI override.
 * Bypasses static routing rules.
 */
function buildModeFromOverride(
  override: 'QUICK_REVIEW' | 'REVIEW_ONLY' | 'IMPLEMENT' | 'FULL',
  goal: string,
  workspace: string,
): PipelineMode {
  const prNumbers = extractPrNumbers(goal);
  const pitchPath = workspace + '/.workrail/current-pitch.md';

  switch (override) {
    case 'QUICK_REVIEW':
      return { kind: 'QUICK_REVIEW', prNumbers };
    case 'REVIEW_ONLY':
      return { kind: 'REVIEW_ONLY', prNumbers };
    case 'IMPLEMENT':
      return { kind: 'IMPLEMENT', pitchPath };
    case 'FULL':
      return { kind: 'FULL', goal };
  }
}

/** Returns true if the goal contains dep-bump keywords (for routing log). */
function hasDepBumpKeyword(goal: string): boolean {
  const lower = goal.toLowerCase();
  return ['bump', 'chore:', 'dependabot', 'dependency upgrade'].some((kw) => lower.includes(kw));
}

/** Returns true if the goal contains a PR or MR reference (for routing log). */
function hasPrReference(goal: string): boolean {
  return /\bPR\s*#\d+\b/i.test(goal) || /\bMR\s*!?\d+\b/i.test(goal);
}
