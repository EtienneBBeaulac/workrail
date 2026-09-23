import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { errAsync } from 'neverthrow';
import { createV2ToolContext, mkV2TestDataDir } from '../helpers/v2-test-helpers.js';
import { startWorkflowForTest } from '../helpers/v2-start-workflow-helper.js';
import { unwrapResponse } from '../helpers/unwrap-response.js';
import { LocalDataDirV2 } from '../../src/v2/infra/local/data-dir/index.js';
import { createWorkflow } from '../../src/types/workflow.js';
import { createBundledSource } from '../../src/types/workflow-source.js';
import { handleV2ContinueWorkflow } from '../../src/mcp/handlers/v2-execution.js';
import { createTrustedGateResolver } from '../../src/daemon/trusted-gate-resolver.js';
import type { V2ToolContext } from '../../src/mcp/types.js';

async function fixture(empty = false) {
  const data = await mkV2TestDataDir('gate-faults-');
  const base = await createV2ToolContext(new LocalDataDirV2({ WORKRAIL_DATA_DIR: data.root }));
  const workflow = createWorkflow({ id: 'gate-faults', name: 'Gate faults', description: 'Durable gate controls', version: '1.0.0',
    steps: [{ id: 'work', title: 'Work', prompt: 'Work', notesOptional: empty, requireConfirmation: true },
      { id: 'next', title: 'Next', prompt: 'Next' }] }, createBundledSource());
  const ctx: V2ToolContext = { ...base, workflowService: { ...base.workflowService, getWorkflowById: async () => workflow } };
  const start = await startWorkflowForTest({ workflowId: 'gate-faults', workspacePath: data.root, goal: 'Gate fault verification' }, ctx, { triggerSource: 'daemon' });
  if (start.type !== 'success') throw new Error(start.error);
  const response = await handleV2ContinueWorkflow({ continueToken: unwrapResponse(start.data).continueToken,
    context: { retainedValue: 'original' }, ...(empty ? {} : { output: { notesMarkdown: 'Accepted notes' } }) }, ctx);
  if (response.type !== 'success') throw new Error('Gate submission failed');
  const gate = unwrapResponse(response.data);
  expect(gate.kind).toBe('gate_checkpoint');
  return { data, ctx, token: gate.gateToken! };
}
const approved = { kind: 'approved', rationale: 'Verified' } as const;
const signal = () => new AbortController().signal;

describe('trusted gate durable failure boundaries', () => {
  it('accepts optional empty work and refuses inspection after terminal approval', async () => {
    const f = await fixture(true);
    try {
      const resolver = await createTrustedGateResolver({ toolContext: f.ctx }, signal());
      const pending = await resolver.inspectPending(f.token, signal());
      if (pending.kind !== 'inspected') throw new Error(JSON.stringify(pending));
      const result = await resolver.resolveGate(pending.authority, pending.subject, approved, signal());
      expect(result.kind).toBe('accepted');
      expect(await resolver.inspectPending(f.token, signal())).toMatchObject({ kind: 'refused', reason: 'not_pending' });
      const truth = (await f.ctx.v2.sessionStore.load(pending.subject.sessionId))._unsafeUnwrap();
      expect(truth.events.filter(e => e.kind === 'context_set' && JSON.stringify(e.data).includes('original'))).toHaveLength(1);
      await resolver.close(signal());
    } finally { await f.data.cleanup(); }
  });

  it('refuses legacy missing work rather than treating it as an accepted empty submission', async () => {
    const f = await fixture(true);
    try {
      const snapshots = f.ctx.v2.snapshotStore;
      const ctx: V2ToolContext = { ...f.ctx, v2: { ...f.ctx.v2, snapshotStore: {
        putExecutionSnapshotV1: snapshots.putExecutionSnapshotV1.bind(snapshots),
        getExecutionSnapshotV1: ref => snapshots.getExecutionSnapshotV1(ref).map(snapshot => {
          if (!snapshot?.enginePayload.gateCheckpoint) return snapshot;
          const { acceptedContext: _, ...legacyGate } = snapshot.enginePayload.gateCheckpoint;
          return { ...snapshot, enginePayload: { ...snapshot.enginePayload, gateCheckpoint: legacyGate } };
        }),
      } } };
      const resolver = await createTrustedGateResolver({ toolContext: ctx }, signal());
      expect(await resolver.inspectPending(f.token, signal())).toMatchObject({ kind: 'refused', reason: 'missing_work' });
      await resolver.close(signal());
    } finally { await f.data.cleanup(); }
  });

  it('serializes local callers and replays after the single durable transition', async () => {
    const f = await fixture();
    try {
      const a = await createTrustedGateResolver({ toolContext: f.ctx }, signal());
      const b = await createTrustedGateResolver({ toolContext: f.ctx }, signal());
      const pending = await a.inspectPending(f.token, signal());
      if (pending.kind !== 'inspected') throw new Error(JSON.stringify(pending));
      const results = await Promise.all([a, b].map(r => r.resolveGate(pending.authority, pending.subject, approved, signal())));
      expect(results.map(r => r.kind).sort()).toEqual(['accepted', 'replay']);
      expect((await b.resolveGate(pending.authority, pending.subject, approved, signal())).kind).toBe('replay');
      const truth = (await f.ctx.v2.sessionStore.load(pending.subject.sessionId))._unsafeUnwrap();
      expect(truth.events.filter(e => e.kind === 'gate_resolution_recorded')).toHaveLength(1);
      expect(truth.events.filter(e => e.kind === 'edge_created' && e.data.fromNodeId === pending.subject.gateNodeId)).toHaveLength(1);
      await a.close(signal()); await b.close(signal());
    } finally { await f.data.cleanup(); }
  });

  it.each(['before-write', 'lost-reply'] as const)('recovers %s without returning an uncommitted token', async fault => {
    const f = await fixture();
    try {
      const store = f.ctx.v2.sessionStore;
      const ctx: V2ToolContext = { ...f.ctx, v2: { ...f.ctx.v2, sessionStore: {
        ...store, load: store.load.bind(store), loadValidatedPrefix: store.loadValidatedPrefix.bind(store),
        append: (lock, plan, truth) => fault === 'before-write'
          ? errAsync({ code: 'SESSION_STORE_IO_ERROR', message: 'Injected before write' })
          : store.append(lock, plan, truth).andThen(() => errAsync({ code: 'SESSION_STORE_IO_ERROR', message: 'Injected lost reply' })),
      } } };
      const resolver = await createTrustedGateResolver({ toolContext: ctx }, signal());
      const pending = await resolver.inspectPending(f.token, signal());
      if (pending.kind !== 'inspected') throw new Error(JSON.stringify(pending));
      expect(await resolver.resolveGate(pending.authority, pending.subject, approved, signal())).toEqual({ kind: 'unconfirmed', reason: 'commit_uncertain' });
      const healthy = await createTrustedGateResolver({ toolContext: f.ctx }, signal());
      const result = await healthy.resolveGate(pending.authority, pending.subject, approved, signal());
      expect(result.kind).toBe(fault === 'before-write' ? 'accepted' : 'replay');
      const truth = (await store.load(pending.subject.sessionId))._unsafeUnwrap();
      expect(truth.events.filter(e => e.kind === 'gate_resolution_recorded')).toHaveLength(1);
      expect(truth.events.filter(e => e.kind === 'node_output_appended')).toHaveLength(1);
      await resolver.close(signal()); await healthy.close(signal());
    } finally { await f.data.cleanup(); }
  });

  it('distinguishes failed preparation from uncertain journal commitment', async () => {
    const f = await fixture();
    try {
      const snapshots = f.ctx.v2.snapshotStore;
      const ctx: V2ToolContext = { ...f.ctx, v2: { ...f.ctx.v2, snapshotStore: {
        getExecutionSnapshotV1: snapshots.getExecutionSnapshotV1.bind(snapshots),
        putExecutionSnapshotV1: () => errAsync({ code: 'SNAPSHOT_STORE_IO_ERROR', message: 'Injected preparation failure' }),
      } } };
      const resolver = await createTrustedGateResolver({ toolContext: ctx }, signal());
      const p = await resolver.inspectPending(f.token, signal());
      if (p.kind !== 'inspected') throw new Error(JSON.stringify(p));
      const before = (await f.ctx.v2.sessionStore.load(p.subject.sessionId))._unsafeUnwrap().events;
      expect(await resolver.resolveGate(p.authority, p.subject, approved, signal())).toMatchObject({ kind: 'refused', reason: 'storage_unavailable' });
      expect((await f.ctx.v2.sessionStore.load(p.subject.sessionId))._unsafeUnwrap().events).toEqual(before);
      await resolver.close(signal());
    } finally { await f.data.cleanup(); }
  });

  it('cancels during preparation without pretending an append succeeded', async () => {
    const f = await fixture();
    try {
      const controller = new AbortController();
      const snapshots = f.ctx.v2.snapshotStore;
      const ctx: V2ToolContext = { ...f.ctx, v2: { ...f.ctx.v2, snapshotStore: {
        ...snapshots,
        getExecutionSnapshotV1: snapshots.getExecutionSnapshotV1.bind(snapshots),
        putExecutionSnapshotV1: snapshot => snapshots.putExecutionSnapshotV1(snapshot).map(ref => { controller.abort(); return ref; }),
      } } };
      const resolver = await createTrustedGateResolver({ toolContext: ctx }, signal());
      const p = await resolver.inspectPending(f.token, signal());
      if (p.kind !== 'inspected') throw new Error(JSON.stringify(p));
      const before = (await f.ctx.v2.sessionStore.load(p.subject.sessionId))._unsafeUnwrap().events;
      expect(await resolver.resolveGate(p.authority, p.subject, approved, controller.signal)).toMatchObject({ kind: 'refused', reason: 'session_cancelled' });
      expect((await f.ctx.v2.sessionStore.load(p.subject.sessionId))._unsafeUnwrap().events).toEqual(before);
      await resolver.close(signal());
    } finally { await f.data.cleanup(); }
  });

  it('refuses a cancelled decision without appending and rejects superseded uncertainty', async () => {
    const f = await fixture();
    try {
      const resolver = await createTrustedGateResolver({ toolContext: f.ctx }, signal());
      const p = await resolver.inspectPending(f.token, signal());
      if (p.kind !== 'inspected') throw new Error(JSON.stringify(p));
      const before = (await f.ctx.v2.sessionStore.load(p.subject.sessionId))._unsafeUnwrap().events;
      expect(await resolver.resolveGate(p.authority, p.subject, approved, AbortSignal.abort())).toMatchObject({ kind: 'refused', reason: 'session_cancelled' });
      expect((await f.ctx.v2.sessionStore.load(p.subject.sessionId))._unsafeUnwrap().events).toEqual(before);
      const uncertain = { kind: 'uncertain', rationale: 'Need evidence' } as const;
      expect((await resolver.resolveGate(p.authority, p.subject, uncertain, signal())).kind).toBe('held');
      expect((await resolver.resolveGate(p.authority, p.subject, approved, signal())).kind).toBe('accepted');
      expect(await resolver.resolveGate(p.authority, p.subject, uncertain, signal())).toMatchObject({ kind: 'refused', reason: 'conflicting_decision' });
      await resolver.close(signal());
    } finally { await f.data.cleanup(); }
  });
});
