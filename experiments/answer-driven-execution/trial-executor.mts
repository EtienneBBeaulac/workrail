import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ValidatedStudyManifest } from './study-manifest.mjs';
import type {
  AgentTransport,
  RunnerClock,
  ExecutionResult,
  TrialRequest,
  LedgerRecord,
  AgentEvent,
} from './trial-executor-contract.js';

export interface ActiveModelCall {
  readonly callId: string;
  readonly deadlineMs: number;
}

export type TerminalSlotStatus =
  | 'completed'
  | 'failed'
  | 'unknown_remote'
  | 'conversation_reused';

export type SlotStatus = 'running' | TerminalSlotStatus;

interface BaseSlotState {
  readonly runId: string;
  readonly conversationDeadlineMs: number;
  readonly currentConversationId: string | null;
  readonly modelCallCount: number;
}

export interface RunningSlotState extends BaseSlotState {
  readonly status: 'running';
  readonly activeModelCall: ActiveModelCall | null;
}

export interface CompletedSlotState extends BaseSlotState {
  readonly status: 'completed';
  readonly activeModelCall: null;
}

export interface FailedSlotState extends BaseSlotState {
  readonly status: 'failed';
  readonly activeModelCall: null;
}

export interface UnknownRemoteSlotState extends BaseSlotState {
  readonly status: 'unknown_remote';
  readonly activeModelCall: null;
}

export interface ConversationReusedSlotState extends BaseSlotState {
  readonly status: 'conversation_reused';
  readonly activeModelCall: null;
}

export type TerminalSlotState =
  | CompletedSlotState
  | FailedSlotState
  | UnknownRemoteSlotState
  | ConversationReusedSlotState;

export type SlotState = RunningSlotState | TerminalSlotState;

type SlotInput =
  | { readonly kind: 'event'; readonly event: AgentEvent }
  | { readonly kind: 'stop'; readonly reason: 'model_deadline' | 'conversation_deadline' | 'caller_cancelled' }
  | { readonly kind: 'stream_done' }
  | { readonly kind: 'stream_error'; readonly error: unknown };

type SlotEffect =
  | { readonly type: 'journal_record'; readonly record: LedgerRecord }
  | { readonly type: 'schedule_model_timer'; readonly deadlineMs: number }
  | { readonly type: 'cancel_model_timer' }
  | { readonly type: 'register_conversation_id'; readonly conversationId: string }
  | { readonly type: 'abort_derived_transport' };

class SlotTimers {
  private modelTimerCancel: (() => void) | null = null;
  private conversationTimerCancel: (() => void) | null = null;

  scheduleModel(deadlineMs: number, clock: RunnerClock, onFire: () => void): void {
    this.cancelModel();
    this.modelTimerCancel = clock.scheduleAt(deadlineMs, onFire);
  }

  cancelModel(): void {
    if (this.modelTimerCancel !== null) {
      const cancel = this.modelTimerCancel;
      this.modelTimerCancel = null;
      cancel();
    }
  }

  scheduleConversation(deadlineMs: number, clock: RunnerClock, onFire: () => void): void {
    this.cancelConversation();
    this.conversationTimerCancel = clock.scheduleAt(deadlineMs, onFire);
  }

  cancelConversation(): void {
    if (this.conversationTimerCancel !== null) {
      const cancel = this.conversationTimerCancel;
      this.conversationTimerCancel = null;
      cancel();
    }
  }

  cancelAll(): void {
    this.cancelModel();
    this.cancelConversation();
  }
}

function transitionSlot(
  state: SlotState,
  input: SlotInput,
  globalSeen: ReadonlySet<string>,
  nowMs: number,
  maxCallTimeoutMs: number,
  maxCallsPerConversation: number,
): { readonly nextState: SlotState; readonly effects: readonly SlotEffect[] } {
  if (state.status !== 'running') {
    return { nextState: state, effects: [] };
  }

  if (input.kind === 'stop') {
    let effectiveReason = input.reason;
    if (effectiveReason === 'model_deadline' && nowMs >= state.conversationDeadlineMs) {
      effectiveReason = 'conversation_deadline';
    }
    return {
      nextState: { ...state, status: 'unknown_remote', activeModelCall: null },
      effects: [
        { type: 'cancel_model_timer' },
        { type: 'abort_derived_transport' },
        { type: 'journal_record', record: { type: 'stop', runId: state.runId, reason: effectiveReason } },
        { type: 'journal_record', record: { type: 'outcome', runId: state.runId, outcome: 'unknown_remote' } },
      ],
    };
  }

  if (input.kind === 'stream_error' || input.kind === 'stream_done') {
    return {
      nextState: { ...state, status: 'unknown_remote', activeModelCall: null },
      effects: [
        { type: 'cancel_model_timer' },
        { type: 'abort_derived_transport' },
        { type: 'journal_record', record: { type: 'outcome', runId: state.runId, outcome: 'unknown_remote' } },
      ],
    };
  }

  const { event } = input;
  const journalEventEffect: SlotEffect = {
    type: 'journal_record',
    record: { type: 'event', runId: state.runId, event },
  };

  if (event.type === 'started') {
    if (globalSeen.has(event.conversationId)) {
      return {
        nextState: { ...state, status: 'conversation_reused', activeModelCall: null },
        effects: [
          journalEventEffect,
          { type: 'cancel_model_timer' },
          { type: 'abort_derived_transport' },
          { type: 'journal_record', record: { type: 'outcome', runId: state.runId, outcome: 'conversation_reused' } },
        ],
      };
    }
    if (state.currentConversationId !== null) {
      return {
        nextState: { ...state, status: 'unknown_remote', activeModelCall: null },
        effects: [
          journalEventEffect,
          { type: 'cancel_model_timer' },
          { type: 'abort_derived_transport' },
          { type: 'journal_record', record: { type: 'outcome', runId: state.runId, outcome: 'unknown_remote' } },
        ],
      };
    }
    return {
      nextState: { ...state, currentConversationId: event.conversationId },
      effects: [
        journalEventEffect,
        { type: 'register_conversation_id', conversationId: event.conversationId },
      ],
    };
  }

  if (event.type === 'conversation_restarted') {
    if (state.currentConversationId === null || event.priorConversationId !== state.currentConversationId) {
      return {
        nextState: { ...state, status: 'unknown_remote', activeModelCall: null },
        effects: [
          journalEventEffect,
          { type: 'cancel_model_timer' },
          { type: 'abort_derived_transport' },
          { type: 'journal_record', record: { type: 'outcome', runId: state.runId, outcome: 'unknown_remote' } },
        ],
      };
    }
    if (globalSeen.has(event.conversationId)) {
      return {
        nextState: { ...state, status: 'conversation_reused', activeModelCall: null },
        effects: [
          journalEventEffect,
          { type: 'cancel_model_timer' },
          { type: 'abort_derived_transport' },
          { type: 'journal_record', record: { type: 'outcome', runId: state.runId, outcome: 'conversation_reused' } },
        ],
      };
    }
    return {
      nextState: { ...state, currentConversationId: event.conversationId },
      effects: [
        journalEventEffect,
        { type: 'register_conversation_id', conversationId: event.conversationId },
      ],
    };
  }

  if (event.type === 'model_started') {
    if (
      state.currentConversationId === null ||
      state.activeModelCall !== null ||
      state.modelCallCount >= maxCallsPerConversation
    ) {
      return {
        nextState: { ...state, status: 'unknown_remote', activeModelCall: null },
        effects: [
          journalEventEffect,
          { type: 'cancel_model_timer' },
          { type: 'abort_derived_transport' },
          { type: 'journal_record', record: { type: 'outcome', runId: state.runId, outcome: 'unknown_remote' } },
        ],
      };
    }
    const rawDeadlineMs = nowMs + maxCallTimeoutMs;
    const modelDeadlineMs = Math.min(state.conversationDeadlineMs, rawDeadlineMs);
    const effects: SlotEffect[] = [journalEventEffect];
    if (modelDeadlineMs < state.conversationDeadlineMs) {
      effects.push({ type: 'schedule_model_timer', deadlineMs: modelDeadlineMs });
    } else {
      effects.push({ type: 'cancel_model_timer' });
    }
    return {
      nextState: {
        ...state,
        modelCallCount: state.modelCallCount + 1,
        activeModelCall: { callId: event.callId, deadlineMs: modelDeadlineMs },
      },
      effects,
    };
  }

  if (event.type === 'model_finished') {
    if (state.currentConversationId === null) {
      return {
        nextState: { ...state, status: 'unknown_remote', activeModelCall: null },
        effects: [
          journalEventEffect,
          { type: 'cancel_model_timer' },
          { type: 'abort_derived_transport' },
          { type: 'journal_record', record: { type: 'outcome', runId: state.runId, outcome: 'unknown_remote' } },
        ],
      };
    }
    if (state.activeModelCall !== null && state.activeModelCall.callId === event.callId) {
      return {
        nextState: { ...state, activeModelCall: null },
        effects: [journalEventEffect, { type: 'cancel_model_timer' }],
      };
    }
    return {
      nextState: state,
      effects: [journalEventEffect],
    };
  }

  if (event.type === 'trace') {
    return {
      nextState: state,
      effects: [journalEventEffect],
    };
  }

  if (event.type === 'ended') {
    if (state.currentConversationId === null) {
      return {
        nextState: { ...state, status: 'unknown_remote', activeModelCall: null },
        effects: [
          journalEventEffect,
          { type: 'cancel_model_timer' },
          { type: 'abort_derived_transport' },
          { type: 'journal_record', record: { type: 'outcome', runId: state.runId, outcome: 'unknown_remote' } },
        ],
      };
    }
    return {
      nextState: { ...state, status: event.outcome, activeModelCall: null },
      effects: [
        journalEventEffect,
        { type: 'cancel_model_timer' },
        { type: 'journal_record', record: { type: 'outcome', runId: state.runId, outcome: event.outcome } },
      ],
    };
  }

  return {
    nextState: state,
    effects: [journalEventEffect],
  };
}

export async function executeTrialPlan(
  manifest: ValidatedStudyManifest,
  outputDir: string,
  transport: AgentTransport,
  signal: AbortSignal,
  clock?: RunnerClock,
): Promise<ExecutionResult> {
  const journalPath = join(outputDir, 'attempts.ndjson');

  if (signal.aborted) {
    return {
      scope: 'orchestration_only',
      trialAuthorization: false,
      attempted: 0,
      status: 'halted',
      reason: 'cancelled',
    };
  }

  try {
    await fs.mkdir(outputDir, { recursive: true });
  } catch {
    return {
      scope: 'orchestration_only',
      trialAuthorization: false,
      attempted: 0,
      status: 'halted',
      reason: 'storage_failed',
    };
  }

  let journalHandle: fs.FileHandle;
  try {
    journalHandle = await fs.open(journalPath, 'ax');
  } catch {
    return {
      scope: 'orchestration_only',
      trialAuthorization: false,
      attempted: 0,
      status: 'halted',
      reason: 'storage_failed',
    };
  }

  const effectiveClock: RunnerClock = clock ?? {
    nowMs: () => Date.now(),
    scheduleAt: (deadlineMs: number, fire: () => void) => {
      const delay = Math.max(0, deadlineMs - Date.now());
      const handle = setTimeout(fire, delay);
      return () => clearTimeout(handle);
    },
  };

  async function appendJournal(record: LedgerRecord): Promise<boolean> {
    try {
      const line = JSON.stringify(record) + '\n';
      await journalHandle.appendFile(line, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  const requests: TrialRequest[] = [];
  for (const pair of manifest.pairs) {
    for (const arm of pair.armOrder) {
      requests.push({
        runId: pair[arm].runId,
        arm,
        workspacePath: pair[arm].workspacePath,
        scenario: pair.scenario,
        repetition: pair.repetition,
        fixture: pair.fixture,
        expectedObservations: pair.expectedObservations,
        requestedEnvironment: manifest.environment[arm],
        budgets: manifest.budgets,
      });
    }
  }

  const seenConversationIds = new Set<string>();
  let attempted = 0;

  try {
    for (const request of requests) {
      if (signal.aborted) {
        return {
          scope: 'orchestration_only',
          trialAuthorization: false,
          attempted,
          status: 'halted',
          reason: 'cancelled',
        };
      }

      const launchWritten = await appendJournal({ type: 'launch', request });
      if (!launchWritten) {
        return {
          scope: 'orchestration_only',
          trialAuthorization: false,
          attempted,
          status: 'halted',
          reason: 'storage_failed',
        };
      }
      attempted++;

      const startTime = effectiveClock.nowMs();
      const conversationDeadlineMs = startTime + request.budgets.maxElapsedMsPerConversation;

      let slotState: SlotState = {
        runId: request.runId,
        conversationDeadlineMs,
        currentConversationId: null,
        activeModelCall: null,
        modelCallCount: 0,
        status: 'running',
      };

      const derivedController = new AbortController();
      const timers = new SlotTimers();

      let stopReason: 'model_deadline' | 'conversation_deadline' | 'caller_cancelled' | null = null;
      let stopResolver: ((r: 'model_deadline' | 'conversation_deadline' | 'caller_cancelled') => void) | null = null;
      const stopPromise = new Promise<'model_deadline' | 'conversation_deadline' | 'caller_cancelled'>((resolve) => {
        stopResolver = resolve;
      });

      const triggerStop = (reason: 'model_deadline' | 'conversation_deadline' | 'caller_cancelled'): void => {
        if (stopReason !== null || slotState.status !== 'running') return;
        if (reason === 'model_deadline' && effectiveClock.nowMs() >= conversationDeadlineMs) {
          reason = 'conversation_deadline';
        }
        stopReason = reason;
        derivedController.abort();
        stopResolver?.(reason);
      };

      timers.scheduleConversation(conversationDeadlineMs, effectiveClock, () => {
        triggerStop('conversation_deadline');
      });

      const onParentAbort = () => {
        triggerStop('caller_cancelled');
      };
      signal.addEventListener('abort', onParentAbort, { once: true });

      if (signal.aborted) {
        triggerStop('caller_cancelled');
      }

      let iterator: AsyncIterator<AgentEvent> | null = null;

      try {
        if (stopReason === null) {
          try {
            const iterable = transport.startFresh(request, derivedController.signal);
            iterator = iterable[Symbol.asyncIterator]();
          } catch {
            derivedController.abort();
            const outcomeWritten = await appendJournal({
              type: 'outcome',
              runId: request.runId,
              outcome: 'unknown_remote',
            });
            return {
              scope: 'orchestration_only',
              trialAuthorization: false,
              attempted,
              status: 'halted',
              reason: outcomeWritten ? 'unknown_remote' : 'storage_failed',
            };
          }
        }

        const applyEffects = async (effects: readonly SlotEffect[]): Promise<boolean> => {
          for (const effect of effects) {
            if (effect.type === 'journal_record') {
              const ok = await appendJournal(effect.record);
              if (!ok) return false;
            } else if (effect.type === 'schedule_model_timer') {
              timers.scheduleModel(effect.deadlineMs, effectiveClock, () => {
                triggerStop('model_deadline');
              });
            } else if (effect.type === 'cancel_model_timer') {
              timers.cancelModel();
            } else if (effect.type === 'register_conversation_id') {
              seenConversationIds.add(effect.conversationId);
            } else if (effect.type === 'abort_derived_transport') {
              derivedController.abort();
            }
          }
          return true;
        };

        while (slotState.status === 'running') {
          let slotInput: SlotInput;

          if (stopReason !== null) {
            slotInput = { kind: 'stop', reason: stopReason };
          } else if (signal.aborted) {
            triggerStop('caller_cancelled');
            slotInput = { kind: 'stop', reason: 'caller_cancelled' };
          } else if (iterator === null) {
            slotInput = { kind: 'stream_done' };
          } else {
            let nextPromise: Promise<{ kind: 'next'; res: IteratorResult<AgentEvent> } | { kind: 'error'; err: unknown }>;
            try {
              nextPromise = iterator.next().then(
                (res) => ({ kind: 'next' as const, res }),
                (err: unknown) => ({ kind: 'error' as const, err }),
              );
            } catch (err: unknown) {
              nextPromise = Promise.resolve({ kind: 'error' as const, err });
            }

            const stopRacePromise = stopPromise.then(
              (reason) => ({ kind: 'stop' as const, reason }),
            );

            const raceResult = await Promise.race([nextPromise, stopRacePromise]);

            if (stopReason !== null) {
              slotInput = { kind: 'stop', reason: stopReason };
            } else if (signal.aborted) {
              triggerStop('caller_cancelled');
              slotInput = { kind: 'stop', reason: 'caller_cancelled' };
            } else if (raceResult.kind === 'stop') {
              slotInput = { kind: 'stop', reason: raceResult.reason };
            } else if (raceResult.kind === 'error') {
              slotInput = { kind: 'stream_error', error: raceResult.err };
            } else if (raceResult.res.done) {
              slotInput = { kind: 'stream_done' };
            } else {
              slotInput = { kind: 'event', event: raceResult.res.value };
            }
          }

          const { nextState, effects } = transitionSlot(
            slotState,
            slotInput,
            seenConversationIds,
            effectiveClock.nowMs(),
            request.budgets.maxCallTimeoutMs,
            request.budgets.maxCallsPerConversation,
          );

          slotState = nextState;
          if (slotState.status !== 'running') {
            timers.cancelAll();
          }

          const effectsOk = await applyEffects(effects);
          if (!effectsOk) {
            derivedController.abort();
            return {
              scope: 'orchestration_only',
              trialAuthorization: false,
              attempted,
              status: 'halted',
              reason: 'storage_failed',
            };
          }
        }
      } finally {
        signal.removeEventListener('abort', onParentAbort);
        timers.cancelAll();
        if (iterator !== null && typeof iterator.return === 'function') {
          try {
            void iterator.return().catch(() => {});
          } catch {
            // ignore
          }
        }
      }

      if (slotState.status === 'unknown_remote') {
        return {
          scope: 'orchestration_only',
          trialAuthorization: false,
          attempted,
          status: 'halted',
          reason: 'unknown_remote',
        };
      }

      if (slotState.status === 'conversation_reused') {
        return {
          scope: 'orchestration_only',
          trialAuthorization: false,
          attempted,
          status: 'halted',
          reason: 'conversation_reused',
        };
      }
    }

    return {
      scope: 'orchestration_only',
      trialAuthorization: false,
      attempted,
      status: 'finished',
    };
  } finally {
    try {
      await journalHandle.close();
    } catch {
      // ignore
    }
  }
}
