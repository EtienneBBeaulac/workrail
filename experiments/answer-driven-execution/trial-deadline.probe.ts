import { describe, it, expect } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createUnverifiedStudyFixture } from './study-manifest-file-fixture.js';
import type { ValidatedStudyManifest } from './study-manifest.mjs';

import type { TrialRequest, AgentEvent, RunnerClock, AgentTransport, ExecutionResult, LedgerRecord, executeTrialPlan } from './trial-executor-contract.js';
type ExecuteTrialPlan = typeof executeTrialPlan;

class FakeClock implements RunnerClock {
  private current = 0;
  private nextId = 1;
  readonly scheduled = new Map<number, { id: number; deadlineMs: number; fire: () => void }>();
  nowMs = (): number => this.current;
  scheduleAt = (deadlineMs: number, fire: () => void): (() => void) => {
    const id = this.nextId++;
    this.scheduled.set(id, { id, deadlineMs, fire });
    return () => { this.scheduled.delete(id); };
  };
  advanceTo(targetMs: number): void {
    if (targetMs < this.current) throw new Error("Test clock cannot move backwards");
    let fired = 0;
    while (true) {
      const eligible = Array.from(this.scheduled.values())
        .filter((t) => t.deadlineMs <= targetMs)
        .sort((a, b) => a.deadlineMs - b.deadlineMs || b.id - a.id);
      if (eligible.length === 0) break;
      const next = eligible[0];
      if (++fired > 1000) throw new Error("Unbounded timer rescheduling");
      this.scheduled.delete(next.id);
      this.current = next.deadlineMs;
      next.fire();
    }
    this.current = targetMs;
  }
}

class FakeTransport implements AgentTransport {
  calls = 0;
  signals: AbortSignal[] = [];
  parkCount = 0;
  beforeStart: (() => void) | undefined;
  private waiters: Array<{ n: number; resolve: () => void }> = [];
  private pending: ((val: IteratorResult<AgentEvent>) => void) | null = null;
  private queue: AgentEvent[];
  constructor(initial: AgentEvent[]) { this.queue = [...initial]; }
  push(event: AgentEvent): void {
    if (this.pending) { const r = this.pending; this.pending = null; r({ value: event, done: false }); }
    else { this.queue.push(event); }
  }
  waitForPark(n: number): Promise<void> {
    if (this.parkCount >= n) return Promise.resolve();
    return new Promise((res) => { this.waiters.push({ n, resolve: res }); });
  }
  startFresh(_req: TrialRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    this.beforeStart?.();
    const attempt = ++this.calls;
    this.signals.push(signal);
    if (attempt === 1) {
      const self = this;
      return {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<AgentEvent>> {
              if (self.queue.length > 0) return Promise.resolve({ value: self.queue.shift()!, done: false });
              self.parkCount++;
              self.waiters = self.waiters.filter((w) => { if (self.parkCount >= w.n) { w.resolve(); return false; } return true; });
              return new Promise((res) => { self.pending = res; });
            },
            return(): Promise<IteratorResult<AgentEvent>> { return new Promise(() => {}); }
          };
        }
      };
    }
    const evs: AgentEvent[] = [
      { type: 'started', conversationId: `sub-${attempt}`, observedEnvironment: { kind: 'unknown' } },
      { type: 'ended', outcome: 'completed', raw: 'done' }
    ];
    let i = 0;
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<AgentEvent>> {
            return i < evs.length
              ? Promise.resolve({ value: evs[i++], done: false })
              : Promise.resolve({ value: undefined, done: true });
          },
          return(): Promise<IteratorResult<AgentEvent>> { return Promise.resolve({ value: undefined, done: true }); }
        };
      }
    };
  }
}

async function loadCandidate(): Promise<ExecuteTrialPlan> {
  const p = path.resolve(process.cwd(), 'experiments/answer-driven-execution/trial-executor.mts');
  if (!existsSync(p)) throw new Error('CANDIDATE_UNAVAILABLE: trial executor absent');
  const mod = await import(/* @vite-ignore */ p) as { executeTrialPlan?: ExecuteTrialPlan };
  if (typeof mod.executeTrialPlan !== 'function') throw new Error('CANDIDATE_UNAVAILABLE: trial executor export absent');
  return mod.executeTrialPlan;
}

async function readLedger(outDir: string): Promise<LedgerRecord[]> {
  const p = path.join(outDir, 'attempts.ndjson');
  if (!existsSync(p)) return [];
  const raw = await fs.readFile(p, 'utf8');
  return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as LedgerRecord);
}

function assertStopped(result: ExecutionResult, transport: FakeTransport, clock: FakeClock,
  ledger: LedgerRecord[], manifest: ValidatedStudyManifest,
  reason: 'model_deadline' | 'conversation_deadline' | 'caller_cancelled') {
  const pair = manifest.pairs[0];
  const runId = pair[pair.armOrder[0]].runId;
  expect(result).toEqual({ scope: 'orchestration_only', trialAuthorization: false, attempted: 1, status: 'halted', reason: 'unknown_remote' });
  expect(transport.calls).toBe(1);
  expect(transport.signals[0].aborted).toBe(true);
  expect(ledger[0]).toMatchObject({ type: 'launch', request: { runId } });
  expect(ledger.slice(-2)).toEqual([
    { type: 'stop', runId, reason },
    { type: 'outcome', runId, outcome: 'unknown_remote' },
  ]);
  expect(clock.scheduled.size).toBe(0);
}

describe('trial-deadline probe', () => {
  it('case 1 positive: normal completion with model start/finish within deadline', async () => {
    const exec = await loadCandidate();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'td-pos-'));
    const outDir = path.join(root, 'out');
    try {
      await fs.mkdir(outDir, { recursive: true });
      const { manifest } = await createUnverifiedStudyFixture(root);
      const clock = new FakeClock();
      const transport = new FakeTransport([
        { type: 'started', conversationId: 'c1', observedEnvironment: { kind: 'unknown' } },
        { type: 'model_started', callId: 'call-1' },
      ]);
      const execPromise = exec(manifest, outDir, transport, new AbortController().signal, clock);
      await transport.waitForPark(1);
      clock.advanceTo(59999);
      transport.push({ type: 'model_finished', callId: 'call-1' });
      await transport.waitForPark(2);
      clock.advanceTo(61000);
      transport.push({ type: 'ended', outcome: 'completed', raw: 'done' });
      const res = await execPromise;
      expect(res).toEqual({ scope: 'orchestration_only', trialAuthorization: false, attempted: 40, status: 'finished' });
      expect(transport.calls).toBe(40);
      expect(clock.scheduled.size).toBe(0);
      expect(res.attempted).toBe(40);
      expect(transport.signals[0]?.aborted).toBe(false);
      const ledger = await readLedger(outDir);
      expect(ledger.some((r) => r.type === 'stop')).toBe(false);
      const runIds = manifest.pairs.flatMap(pair => pair.armOrder.map(arm => pair[arm].runId));
      expect(ledger.filter(r => r.type === 'launch').map(r => r.request.runId)).toEqual(runIds);
      expect(ledger.filter(r => r.type === 'outcome')).toEqual(runIds.map(runId => ({ type: 'outcome', runId, outcome: 'completed' })));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('case 2 modeled stall: times out at model deadline', async () => {
    const exec = await loadCandidate();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'td-stall-'));
    const outDir = path.join(root, 'out');
    try {
      await fs.mkdir(outDir, { recursive: true });
      const { manifest } = await createUnverifiedStudyFixture(root);
      const clock = new FakeClock();
      const transport = new FakeTransport([
        { type: 'started', conversationId: 'c1', observedEnvironment: { kind: 'unknown' } },
        { type: 'model_started', callId: 'call-1' },
      ]);
      let settled = false;
      const execPromise = exec(manifest, outDir, transport, new AbortController().signal, clock);
      execPromise.then(() => { settled = true; }, () => { settled = true; });
      await transport.waitForPark(1);
      clock.advanceTo(30000);
      transport.push({ type: 'trace', raw: 'activity does not reset call deadline' });
      await transport.waitForPark(2);
      transport.push({ type: 'model_finished', callId: 'wrong-call' });
      await transport.waitForPark(3);
      clock.advanceTo(59999);
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(transport.signals[0]?.aborted).toBe(false);
      clock.advanceTo(60000);
      const res = await execPromise;
      expect(res.status).toBe('halted');
      expect(res.status === 'halted' ? res.reason : undefined).toBe('unknown_remote');
      expect(res.attempted).toBe(1);
      expect(transport.calls).toBe(1);
      expect(transport.signals[0]?.aborted).toBe(true);
      const ledger = await readLedger(outDir);
      const stop = ledger.find((r) => r.type === 'stop');
      expect(stop && 'reason' in stop ? stop.reason : undefined).toBe('model_deadline');
      assertStopped(res, transport, clock, ledger, manifest, 'model_deadline');
      const outcome = ledger.find((r) => r.type === 'outcome');
      expect(outcome && 'outcome' in outcome ? outcome.outcome : undefined).toBe('unknown_remote');
      expect(ledger.some((r) => r.type === 'event' && r.event.type === 'started')).toBe(true);
      expect(ledger.some((r) => r.type === 'event' && r.event.type === 'model_started')).toBe(true);
      expect(ledger).toContainEqual({ type: 'event', runId: manifest.pairs[0][manifest.pairs[0].armOrder[0]].runId, event: { type: 'trace', raw: 'activity does not reset call deadline' } });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('case 3 late call: conversation deadline wins tie over model deadline', async () => {
    const exec = await loadCandidate();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'td-late-'));
    const outDir = path.join(root, 'out');
    try {
      await fs.mkdir(outDir, { recursive: true });
      const { manifest } = await createUnverifiedStudyFixture(root);
      const clock = new FakeClock();
      const transport = new FakeTransport([
        { type: 'started', conversationId: 'c1', observedEnvironment: { kind: 'unknown' } },
      ]);
      const execPromise = exec(manifest, outDir, transport, new AbortController().signal, clock);
      await transport.waitForPark(1);
      clock.advanceTo(295000);
      transport.push({ type: 'model_started', callId: 'call-late' });
      await transport.waitForPark(2);
      expect([...clock.scheduled.values()].every(t => t.deadlineMs <= 300000)).toBe(true);
      clock.advanceTo(299999);
      expect(transport.signals[0]?.aborted).toBe(false);
      clock.advanceTo(300000);
      const res = await execPromise;
      expect(res.status).toBe('halted');
      expect(res.status === 'halted' ? res.reason : undefined).toBe('unknown_remote');
      expect(transport.calls).toBe(1);
      const ledger = await readLedger(outDir);
      const stop = ledger.find((r) => r.type === 'stop');
      expect(stop && 'reason' in stop ? stop.reason : undefined).toBe('conversation_deadline');
      assertStopped(res, transport, clock, ledger, manifest, 'conversation_deadline');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('case 4 no events: times out without started event and retains launch', async () => {
    const exec = await loadCandidate();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'td-noev-'));
    const outDir = path.join(root, 'out');
    try {
      await fs.mkdir(outDir, { recursive: true });
      const { manifest } = await createUnverifiedStudyFixture(root);
      const clock = new FakeClock();
      const transport = new FakeTransport([]);
      transport.beforeStart = () => {
        expect([...clock.scheduled.values()].some(t => t.deadlineMs === 300000)).toBe(true);
      };
      const execPromise = exec(manifest, outDir, transport, new AbortController().signal, clock);
      await transport.waitForPark(1);
      clock.advanceTo(300000);
      const res = await execPromise;
      expect(res.status).toBe('halted');
      expect(res.status === 'halted' ? res.reason : undefined).toBe('unknown_remote');
      expect(transport.calls).toBe(1);
      const ledger = await readLedger(outDir);
      expect(ledger.some((r) => r.type === 'launch')).toBe(true);
      const stop = ledger.find((r) => r.type === 'stop');
      expect(stop && 'reason' in stop ? stop.reason : undefined).toBe('conversation_deadline');
      assertStopped(res, transport, clock, ledger, manifest, 'conversation_deadline');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('case 5 parent pre-abort: immediate cancellation with zero attempts', async () => {
    const exec = await loadCandidate();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'td-preabort-'));
    const outDir = path.join(root, 'out');
    try {
      await fs.mkdir(outDir, { recursive: true });
      const { manifest } = await createUnverifiedStudyFixture(root);
      const clock = new FakeClock();
      const transport = new FakeTransport([]);
      const controller = new AbortController();
      controller.abort();
      const res = await exec(manifest, outDir, transport, controller.signal, clock);
      expect(res.status).toBe('halted');
      expect(res.status === 'halted' ? res.reason : undefined).toBe('cancelled');
      expect(res.attempted).toBe(0);
      expect(transport.calls).toBe(0);
      const ledger = await readLedger(outDir);
      expect(ledger.length).toBe(0);
      expect(clock.scheduled.size).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('case 6 parent abort after start: halts with caller_cancelled and retains trace', async () => {
    const exec = await loadCandidate();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'td-abort-'));
    const outDir = path.join(root, 'out');
    try {
      await fs.mkdir(outDir, { recursive: true });
      const { manifest } = await createUnverifiedStudyFixture(root);
      const clock = new FakeClock();
      const transport = new FakeTransport([
        { type: 'started', conversationId: 'c1', observedEnvironment: { kind: 'unknown' } },
        { type: 'trace', raw: 'some trace log' },
      ]);
      const controller = new AbortController();
      const execPromise = exec(manifest, outDir, transport, controller.signal, clock);
      await transport.waitForPark(1);
      controller.abort();
      const res = await execPromise;
      expect(res.status).toBe('halted');
      expect(res.status === 'halted' ? res.reason : undefined).toBe('unknown_remote');
      expect(res.attempted).toBe(1);
      expect(transport.calls).toBe(1);
      expect(transport.signals[0]?.aborted).toBe(true);
      const ledger = await readLedger(outDir);
      const stop = ledger.find((r) => r.type === 'stop');
      expect(stop && 'reason' in stop ? stop.reason : undefined).toBe('caller_cancelled');
      assertStopped(res, transport, clock, ledger, manifest, 'caller_cancelled');
      expect(ledger).toContainEqual({ type: 'event', runId: manifest.pairs[0][manifest.pairs[0].armOrder[0]].runId, event: { type: 'trace', raw: 'some trace log' } });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('restart retains the original trial deadline instead of granting another budget', async () => {
    const exec = await loadCandidate();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'td-restart-'));
    const outDir = path.join(root, 'out');
    try {
      await fs.mkdir(outDir, {recursive:true});
      const {manifest} = await createUnverifiedStudyFixture(root, 'B');
      const clock = new FakeClock();
      const transport = new FakeTransport([
        {type:'started', conversationId:'before', observedEnvironment:{kind:'unknown'}},
      ]);
      const promise = exec(manifest, outDir, transport, new AbortController().signal, clock);
      await transport.waitForPark(1);
      clock.advanceTo(299000);
      const restart: AgentEvent = {type:'conversation_restarted', priorConversationId:'before', conversationId:'after', observedEnvironment:{kind:'unknown'}};
      transport.push(restart);
      await transport.waitForPark(2);
      expect([...clock.scheduled.values()].every(t => t.deadlineMs <= 300000)).toBe(true);
      clock.advanceTo(299999);
      expect(transport.signals[0]?.aborted).toBe(false);
      clock.advanceTo(300000);
      const result = await promise;
      const ledger = await readLedger(outDir);
      assertStopped(result, transport, clock, ledger, manifest, 'conversation_deadline');
      expect(ledger).toContainEqual({type:'event',runId:manifest.pairs[0][manifest.pairs[0].armOrder[0]].runId,event:restart});
    } finally { await fs.rm(root,{recursive:true,force:true}); }
  });

});
