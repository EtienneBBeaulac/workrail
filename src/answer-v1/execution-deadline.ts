/** Clock and timers are injected so deadline enforcement is independently testable.
 * A recovered execution cannot manufacture continuity from a persisted wall timestamp. */
export interface DeadlineClock {
  read(): Readonly<{ kind: 'reading'; wallMs: number; monotonicMs: number }> | Readonly<{ kind: 'unavailable' }>;
  /** Never invoke wake synchronously, including for zero delays. */
  schedule(delayMs: number, wake: () => void): Readonly<{ kind: 'scheduled'; cancel(): void }> | Readonly<{ kind: 'unavailable' }>;
}
export type DeadlineStopReason = 'expired' | 'cancelled' | 'clock_continuity_unavailable' | 'closed';
export type DeadlineStatus = Readonly<{ kind: 'active'; remainingMs: number }> | Readonly<{ kind: 'stopped'; reason: DeadlineStopReason }>;
export interface ExecutionDeadline {
  readonly signal: AbortSignal;
  check(): DeadlineStatus;
  close(): void;
}
export type StartDeadlineResult =
  | Readonly<{ kind: 'started'; deadline: ExecutionDeadline }>
  | Readonly<{ kind: 'refused'; reason: 'invalid_expiration' | Exclude<DeadlineStopReason, 'closed'> }>;
export type DeadlineOrigin =
  | Readonly<{ kind: 'new_execution'; expiresAtMs: number }>
  | Readonly<{ kind: 'recovered_execution' }>;

const MAX_TIMER_MS = 2147483647;
const validReading = (value: ReturnType<DeadlineClock['read']>): value is Extract<ReturnType<DeadlineClock['read']>, { kind: 'reading' }> =>
  value.kind === 'reading' && Number.isSafeInteger(value.wallMs) && value.wallMs >= 0
    && Number.isFinite(value.monotonicMs) && value.monotonicMs >= 0 && value.monotonicMs <= Number.MAX_SAFE_INTEGER;

/** Call only at new-execution admission, retain the capability for that execution and
 * close it when work settles. Recreating it per delivery would reset elapsed time.
 * check() also observes wall-clock advances; the timer bounds elapsed time continuously.
 * Clock adjustments between checks are not claimed to be observed instantaneously. */
export function startExecutionDeadline(origin: DeadlineOrigin, clock: DeadlineClock, parent: AbortSignal): StartDeadlineResult {
  if (origin.kind === 'recovered_execution') return { kind: 'refused', reason: 'clock_continuity_unavailable' };
  const expiresAtMs = origin.expiresAtMs;
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) return { kind: 'refused', reason: 'invalid_expiration' };
  if (parent.aborted) return { kind: 'refused', reason: 'cancelled' };
  const initial = clock.read();
  if (!validReading(initial)) return { kind: 'refused', reason: 'clock_continuity_unavailable' };
  const duration = expiresAtMs - initial.wallMs;
  if (duration <= 0) return { kind: 'refused', reason: 'expired' };
  const controller = new AbortController();
  type State = Readonly<{ kind: 'active'; remainingMs: number; observedMonotonicMs: number }>
    | Extract<DeadlineStatus, { kind: 'stopped' }>;
  let state: State = { kind: 'active', remainingMs: duration, observedMonotonicMs: initial.monotonicMs };
  let timer: Extract<ReturnType<DeadlineClock['schedule']>, { kind: 'scheduled' }> | undefined;
  const stop = (reason: DeadlineStopReason): DeadlineStatus => {
    if (state.kind === 'stopped') return state;
    state = Object.freeze({ kind: 'stopped', reason });
    timer?.cancel(); timer = undefined;
    parent.removeEventListener('abort', cancel);
    controller.abort(reason);
    return state;
  };
  const cancel = () => { stop('cancelled'); };
  const check = (): DeadlineStatus => {
    if (state.kind === 'stopped') return state;
    if (parent.aborted) return stop('cancelled');
    const now = clock.read();
    if (!validReading(now) || now.monotonicMs < state.observedMonotonicMs) return stop('clock_continuity_unavailable');
    const remainingMs = Math.min(state.remainingMs - (now.monotonicMs - state.observedMonotonicMs), expiresAtMs - now.wallMs);
    if (remainingMs <= 0) return stop('expired');
    state = { kind: 'active', remainingMs, observedMonotonicMs: now.monotonicMs };
    timer?.cancel(); timer = undefined;
    const scheduled = clock.schedule(Math.min(MAX_TIMER_MS, Math.ceil(remainingMs)), () => {
      if (timer !== scheduled) return;
      timer = undefined;
      check();
    });
    if (scheduled.kind === 'unavailable') return stop('clock_continuity_unavailable');
    timer = scheduled;
    return { kind: 'active', remainingMs };
  };
  parent.addEventListener('abort', cancel, { once: true });
  const status = check();
  if (status.kind === 'stopped') return { kind: 'refused', reason: status.reason === 'closed' ? 'clock_continuity_unavailable' : status.reason };
  return { kind: 'started', deadline: { signal: controller.signal, check, close() { stop('closed'); } } };
}


/** Process-local clock only. It supplies no continuity proof across restart. */
export function createSystemDeadlineClock(): DeadlineClock {
  return {
    read() {
      try { return { kind: 'reading', wallMs: Date.now(), monotonicMs: performance.now() }; }
      catch { return { kind: 'unavailable' }; }
    },
    schedule(delayMs, wake) {
      try {
        const timer = setTimeout(wake, delayMs);
        return { kind: 'scheduled', cancel() { clearTimeout(timer); } };
      } catch { return { kind: 'unavailable' }; }
    },
  };
}
