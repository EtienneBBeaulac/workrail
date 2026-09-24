import { expect, it, vi } from 'vitest';
import { startExecutionDeadline, createSystemDeadlineClock, type DeadlineClock } from '../../../src/answer-v1/execution-deadline.js';

class FakeClock implements DeadlineClock {
  wall = 1000;
  mono = 0;
  readable = true;
  schedulable = true;
  reads = 0;
  scheduled: number[] = [];
  timers = new Map<object, { due: number; wake: () => void }>();
  read(): ReturnType<DeadlineClock['read']> {
    this.reads++;
    return this.readable ? { kind: 'reading', wallMs: this.wall, monotonicMs: this.mono } : { kind: 'unavailable' };
  }
  schedule(delayMs: number, wake: () => void): ReturnType<DeadlineClock['schedule']> {
    if (!this.schedulable) return { kind: 'unavailable' };
    const id = {}; this.scheduled.push(delayMs); this.timers.set(id, { due: this.mono + delayMs, wake });
    return { kind: 'scheduled', cancel: () => { this.timers.delete(id); } };
  }
  elapse(ms: number) {
    this.mono += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.due <= this.mono) { this.timers.delete(id); timer.wake(); }
    }
  }
}
const start = (clock: FakeClock, expiresAtMs = 1100, parent = new AbortController().signal) => {
  const result = startExecutionDeadline({ kind: 'new_execution', expiresAtMs }, clock, parent);
  if (result.kind !== 'started') throw new Error(result.reason);
  return result.deadline;
};

it('expires without a caller poll and cannot extend time through wall rollback or repeated checks', () => {
  const clock = new FakeClock(), deadline = start(clock);
  clock.wall = 500; clock.elapse(40);
  expect(deadline.check()).toEqual({ kind: 'active', remainingMs: 60 });
  clock.elapse(59); expect(deadline.check()).toEqual({ kind: 'active', remainingMs: 1 });
  clock.elapse(1);
  expect(deadline.signal.aborted).toBe(true);
  expect(deadline.check()).toEqual({ kind: 'stopped', reason: 'expired' });
  expect(clock.timers.size).toBe(0);
});

it('tightens the timer after observing a wall advance and retains that bound after rollback', () => {
  const clock = new FakeClock(), deadline = start(clock);
  clock.wall = 1090;
  expect(deadline.check()).toEqual({ kind: 'active', remainingMs: 10 });
  clock.wall = 500; clock.elapse(9);
  expect(deadline.check()).toEqual({ kind: 'active', remainingMs: 1 });
  clock.elapse(1);
  expect(deadline.signal.aborted).toBe(true);
  expect(deadline.check()).toEqual({ kind: 'stopped', reason: 'expired' });
});

it('refuses recovery without consulting clocks or scheduling work', () => {
  const clock = new FakeClock();
  expect(startExecutionDeadline({ kind: 'recovered_execution' }, clock, new AbortController().signal))
    .toEqual({ kind: 'refused', reason: 'clock_continuity_unavailable' });
  expect([clock.reads, clock.timers.size]).toEqual([0, 0]);
});

it('cancels and closes idempotently without leaving timers or changing terminal reason', () => {
  const clock = new FakeClock(), parent = new AbortController(), deadline = start(clock, 1100, parent.signal);
  parent.abort();
  expect(deadline.check()).toEqual({ kind: 'stopped', reason: 'cancelled' });
  deadline.close(); clock.elapse(1000);
  expect(deadline.check()).toEqual({ kind: 'stopped', reason: 'cancelled' });
  expect(clock.timers.size).toBe(0);
  const otherClock = new FakeClock(), other = start(otherClock);
  other.close(); other.close();
  expect(other.signal.aborted).toBe(true);
  expect(other.check()).toEqual({ kind: 'stopped', reason: 'closed' });
  expect(otherClock.timers.size).toBe(0);
});

it.each(['backwards', 'unavailable', 'scheduler'] as const)('fails closed when the clock becomes %s', failure => {
  const clock = new FakeClock(), deadline = start(clock);
  clock.elapse(20); deadline.check();
  if (failure === 'backwards') clock.mono = 19;
  if (failure === 'unavailable') clock.readable = false;
  if (failure === 'scheduler') clock.schedulable = false;
  expect(deadline.check()).toEqual({ kind: 'stopped', reason: 'clock_continuity_unavailable' });
  expect(deadline.signal.aborted).toBe(true);
  expect(clock.timers.size).toBe(0);
});

it('splits long timers without overflow or extending the original deadline', () => {
  const clock = new FakeClock(), deadline = start(clock, 1000 + 2147483650);
  expect(clock.scheduled).toEqual([2147483647]);
  clock.elapse(2147483647);
  expect(clock.scheduled).toEqual([2147483647, 3]);
  clock.elapse(3);
  expect(deadline.check()).toEqual({ kind: 'stopped', reason: 'expired' });
});

it('refuses invalid, expired, cancelled and unavailable starts without retained timers', () => {
  const clock = new FakeClock();
  for (const expiresAtMs of [0, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect(startExecutionDeadline({ kind: 'new_execution', expiresAtMs }, clock, new AbortController().signal))
      .toEqual({ kind: 'refused', reason: 'invalid_expiration' });
  expect(startExecutionDeadline({ kind: 'new_execution', expiresAtMs: 1000 }, clock, new AbortController().signal))
    .toEqual({ kind: 'refused', reason: 'expired' });
  expect(startExecutionDeadline({ kind: 'new_execution', expiresAtMs: 1100 }, clock, AbortSignal.abort()))
    .toEqual({ kind: 'refused', reason: 'cancelled' });
  clock.readable = false;
  expect(startExecutionDeadline({ kind: 'new_execution', expiresAtMs: 1100 }, clock, new AbortController().signal))
    .toEqual({ kind: 'refused', reason: 'clock_continuity_unavailable' });
  clock.readable = true; clock.schedulable = false;
  expect(startExecutionDeadline({ kind: 'new_execution', expiresAtMs: 1100 }, clock, new AbortController().signal))
    .toEqual({ kind: 'refused', reason: 'clock_continuity_unavailable' });
  expect(clock.timers.size).toBe(0);
});


it('ignores callbacks from cancelled timers and snapshots the expiration input', () => {
  const clock = new FakeClock();
  const origin = { kind: 'new_execution' as const, expiresAtMs: 1100 };
  const result = startExecutionDeadline(origin, clock, new AbortController().signal);
  if (result.kind !== 'started') throw new Error(result.reason);
  const oldWake = [...clock.timers.values()][0]!.wake;
  origin.expiresAtMs = 1001;
  clock.elapse(10);
  expect(result.deadline.check()).toEqual({ kind: 'active', remainingMs: 90 });
  const count = clock.scheduled.length;
  oldWake();
  expect(clock.scheduled).toHaveLength(count);
  expect(clock.timers.size).toBe(1);
  result.deadline.close(); oldWake();
  expect(clock.timers.size).toBe(0);
});

it.each([NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])('refuses an invalid monotonic sample %s', value => {
  const clock = new FakeClock(); clock.mono = value;
  expect(startExecutionDeadline({ kind: 'new_execution', expiresAtMs: 1100 }, clock, new AbortController().signal))
    .toEqual({ kind: 'refused', reason: 'clock_continuity_unavailable' });
  expect(clock.timers.size).toBe(0);
});


it('uses the system adapter to abort at expiry and release its actual timer handle', () => {
  vi.useFakeTimers({ now: 1000, toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  try {
    const result = startExecutionDeadline({ kind: 'new_execution', expiresAtMs: 1100 }, createSystemDeadlineClock(), new AbortController().signal);
    if (result.kind !== 'started') throw new Error(result.reason);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(100);
    expect(result.deadline.signal.aborted).toBe(true);
    expect(result.deadline.check()).toEqual({ kind: 'stopped', reason: 'expired' });
    expect(vi.getTimerCount()).toBe(0);
    result.deadline.close();
    const second = startExecutionDeadline({ kind: 'new_execution', expiresAtMs: 1200 }, createSystemDeadlineClock(), new AbortController().signal);
    if (second.kind !== 'started') throw new Error(second.reason);
    expect(vi.getTimerCount()).toBe(1);
    second.deadline.close();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
