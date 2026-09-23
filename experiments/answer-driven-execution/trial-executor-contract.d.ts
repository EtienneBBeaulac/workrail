import type { ValidatedStudyManifest } from './study-manifest.mjs';

// Contract: no default/real transport, no study admission, no semantic preflight.
// Order: pairs.flatMap(p => p.armOrder), no retries. Journal launch BEFORE transport call.
// A reused conversationId halts before the next dispatch, retaining the reused event.
// Ended with outcome 'failed' is retained and moves to next slot; unhandled throw -> unknown_remote.
export type Arm = 'baseline' | 'candidate';
type Pair = ValidatedStudyManifest['pairs'][number];

export interface TrialRequest {
  readonly runId: string;
  readonly arm: Arm;
  readonly workspacePath: string;
  readonly scenario: Pair['scenario'];
  readonly repetition: number;
  readonly fixture: Pair['fixture'];
  readonly expectedObservations: Pair['expectedObservations'];
  readonly requestedEnvironment: ValidatedStudyManifest['environment'][Arm];
  readonly budgets: ValidatedStudyManifest['budgets'];
}

export type ObservedEnvironment =
  | { readonly kind: 'reported'; readonly model: string; readonly effort: string }
  | { readonly kind: 'unknown' };

export type AgentEvent =
  | { readonly type: 'started'; readonly conversationId: string; readonly observedEnvironment: ObservedEnvironment }
  | { readonly type: 'conversation_restarted'; readonly priorConversationId: string; readonly conversationId: string; readonly observedEnvironment: ObservedEnvironment }
  | { readonly type: 'model_started'; readonly callId: string }
  | { readonly type: 'model_finished'; readonly callId: string }
  | { readonly type: 'trace'; readonly raw: string }
  | { readonly type: 'ended'; readonly outcome: 'completed' | 'failed'; readonly raw: string };

export interface RunnerClock {
  readonly nowMs: () => number;
  readonly scheduleAt: (deadlineMs: number, fire: () => void) => () => void;
}

export interface AgentTransport {
  startFresh(request: TrialRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
}

export type ExecutionResult = {
  readonly scope: 'orchestration_only';
  readonly trialAuthorization: false;
  readonly attempted: number;
} & (
  | { readonly status: 'finished' }
  | { readonly status: 'halted'; readonly reason: 'unknown_remote' | 'conversation_reused' | 'cancelled' | 'storage_failed' }
);

export type LedgerRecord =
  | { readonly type: 'launch'; readonly request: TrialRequest }
  | { readonly type: 'event'; readonly runId: string; readonly event: AgentEvent }
  | { readonly type: 'stop'; readonly runId: string; readonly reason: 'model_deadline' | 'conversation_deadline' | 'caller_cancelled' }
  | { readonly type: 'outcome'; readonly runId: string; readonly outcome: 'completed' | 'failed' | 'unknown_remote' | 'conversation_reused' };

export function executeTrialPlan(
  manifest: ValidatedStudyManifest,
  outputDir: string,
  transport: AgentTransport,
  signal: AbortSignal,
  clock?: RunnerClock
): Promise<ExecutionResult>;
/** Writes attempts.ndjson without replacing existing nonempty output. Launch intent
 * precedes transport invocation, every event is retained before requesting the next,
 * and terminal outcome precedes the next launch. A throw or stream end without an
 * ended event is unknown_remote. The host enforces conversation time from before dispatch and model time from
 * model_started until matching model_finished; model time is clamped by the conversation
 * deadline, which wins a tie. Stop causes are journaled before unknown_remote outcomes;
 * abort the derived transport signal and never await a stalled iterator.return().
 * Pre-launch cancellation makes zero attempts. Clear all timers on terminal return. Requested environment never fills missing observed identity.
 * This internal executor has no real transport default and grants no admission.
 */

/** A controlled restart remains in the same trial slot and preserves the original
 * trial/model deadlines and call budget. Its priorConversationId must be current;
 * both started and restarted IDs enter the same study-wide uniqueness registry.
 * Reuse halts with conversation_reused. An unmatched prior identity is retained
 * then halts unknown_remote. A restart is not evidence that the old engine stopped;
 * the composition layer separately requires the host recreation boundary. */
