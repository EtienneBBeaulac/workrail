import { it, expect } from 'vitest';
import { mkdtemp, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createUnverifiedStudyFixture } from './study-manifest-file-fixture.js';
import { makeEffects } from './study-runner-fixture.js';
import type { AgentTransport } from './trial-executor-contract.js';
import type { executePreflightedStudy } from './trial-preflight-contract.js';

async function fixture(run: (ctx: {
  execute: typeof executePreflightedStudy;
  manifest: Awaited<ReturnType<typeof createUnverifiedStudyFixture>>['manifest'];
  effects: ReturnType<typeof makeEffects>;
  transport: AgentTransport;
  calls: string[];
  out: string;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'preflight-boundaries-'));
  try {
    const { manifest } = await createUnverifiedStudyFixture(root, 'B');
    const modulePath = resolve('experiments/answer-driven-execution/trial-preflight.mts');
    const { executePreflightedStudy: execute } = await import(/* @vite-ignore */ modulePath);
    const calls: string[] = [];
    const transport: AgentTransport = { async *startFresh(request) {
      calls.push(request.runId);
      yield { type: 'started', conversationId: request.runId, observedEnvironment: { kind: 'unknown' } };
      yield { type: 'ended', outcome: 'completed', raw: 'done' };
    } };
    await run({ execute, manifest, effects: makeEffects(manifest), transport, calls, out: join(root, 'out') });
  } finally { await rm(root, { recursive: true, force: true }); }
}

it('boundary control: matching host observations admit the frozen Stage B slots', async () => {
  await fixture(async ({ execute, manifest, effects, transport, calls, out }) => {
    const result = await execute(manifest, out, transport, effects, new AbortController().signal);
    expect(result.status).toBe('admitted'); expect(calls).toHaveLength(20);
  });
});

it.each(['build', 'producer'] as const)('cancellation during resolving %s effect prevents admission', async phase => {
  await fixture(async ({ execute, manifest, effects, transport, calls, out }) => {
    const controller = new AbortController();
    const checked = phase === 'build' ? { ...effects, observeLoadedBuild: async (...args: Parameters<typeof effects.observeLoadedBuild>) => {
      const result = await effects.observeLoadedBuild(...args); controller.abort(); return result;
    } } : { ...effects, executePreflight: async (...args: Parameters<typeof effects.executePreflight>) => {
      const result = await effects.executePreflight(...args); controller.abort(); return result;
    } };
    const result = await execute(manifest, out, transport, checked, controller.signal);
    expect(result.status).toBe('cancelled'); expect(calls).toHaveLength(0);
  });
});

it('rejects a correctly correlated build response naming the wrong arm', async () => {
  await fixture(async ({ execute, manifest, effects, transport, calls, out }) => {
    const checked = { ...effects, observeLoadedBuild: async (...args: Parameters<typeof effects.observeLoadedBuild>) => {
      const result = await effects.observeLoadedBuild(...args);
      return { ...result, arm: result.arm === 'baseline' ? 'candidate' as const : 'baseline' as const };
    } };
    const result = await execute(manifest, out, transport, checked, new AbortController().signal);
    expect(result.status).toBe('rejected'); expect(calls).toHaveLength(0);
    if (result.status === 'rejected' && result.error.kind === 'build_correlation_mismatch') {
      expect(result.error.observedRequestId).toBe(result.error.expectedRequestId);
    } else { throw new Error('expected build correlation rejection'); }
  });
});

it('rejects a fault producer returning a different scenario', async () => {
  await fixture(async ({ execute, manifest, effects, transport, calls, out }) => {
    const checked = { ...effects, executePreflight: async (...args: Parameters<typeof effects.executePreflight>) => {
      const result = await effects.executePreflight(...args);
      return result.status === 'executed' && result.kind === 'fault_equivalence' ? { ...result, scenario: 'foreign-scenario' } : result;
    } };
    const result = await execute(manifest, out, transport, checked, new AbortController().signal);
    expect(result.status).toBe('rejected'); expect(calls).toHaveLength(0);
  });
});

it.each(['nested', '..nested'])('rejects physically nested workspace %s hidden behind a symlink', async name => {
  await fixture(async ({ execute, manifest, effects, transport, calls, out }) => {
    const pair = manifest.pairs[0]!;
    const nested = join(pair.baseline.workspacePath, name);
    await mkdir(nested);
    await rm(pair.candidate.workspacePath, { recursive: true });
    await symlink(nested, pair.candidate.workspacePath);
    const result = await execute(manifest, out, transport, effects, new AbortController().signal);
    expect(result.status).toBe('rejected'); expect(calls).toHaveLength(0);
  });
});

it.each(['workspace', 'build', 'producer'] as const)('returns rejection data when %s effect throws synchronously', async phase => {
  await fixture(async ({ execute, manifest, effects, transport, calls, out }) => {
    const fail = () => { throw new Error('synchronous adapter failure'); };
    const checked = phase === 'workspace' ? { ...effects, resolveCanonicalPath: fail }
      : phase === 'build' ? { ...effects, observeLoadedBuild: fail }
      : { ...effects, executePreflight: fail };
    const result = await execute(manifest, out, transport, checked, new AbortController().signal);
    expect(result.status).toBe('rejected'); expect(calls).toHaveLength(0);
  });
});

it('retains individual control traces alongside the producer trace', async () => {
  await fixture(async ({ execute, manifest, effects, transport, calls, out }) => {
    const checked = { ...effects, executePreflight: async (...args: Parameters<typeof effects.executePreflight>) => {
      const result = await effects.executePreflight(...args);
      return result.status === 'executed' ? { ...result, controls: result.controls.map(control => ({ ...control, raw: 'raw-control-' + control.checkId })) } : result;
    } };
    const result = await execute(manifest, out, transport, checked, new AbortController().signal);
    expect(result.status).toBe('admitted'); expect(calls).toHaveLength(20);
    expect(JSON.stringify(result.retainedTraces)).toContain('raw-control-checker_removed');
    expect(JSON.stringify(result.retainedTraces)).toContain('raw-control-review_candidate');
  });
});

it('refuses a producer receipt with the wrong kind even when controls match', async () => {
  await fixture(async ({ execute, manifest, effects, transport, calls, out }) => {
    const checked = { ...effects, executePreflight: async (...args: Parameters<typeof effects.executePreflight>) => {
      const result = await effects.executePreflight(...args);
      return result.status === 'executed' && result.kind === 'review_obligations' ? { ...result, kind: 'observation_checker' as const } : result;
    } };
    const result = await execute(manifest, out, transport, checked, new AbortController().signal);
    expect(result.status).toBe('rejected'); expect(calls).toHaveLength(0);
  });
});

it('classifies foreign failed receipt as a correlation failure', async () => {
  await fixture(async ({ execute, manifest, effects, transport, calls, out }) => {
    const checked = { ...effects, executePreflight: async () => ({ status: 'failed' as const,
      invocationId: 'foreign-invocation', proofId: 'foreign-proof', failureReason: 'failure', rawTrace: 'foreign-trace' }) };
    const result = await execute(manifest, out, transport, checked, new AbortController().signal);
    expect(result.status).toBe('rejected'); expect(calls).toHaveLength(0);
    if (result.status === 'rejected') expect(result.error.kind).toBe('preflight_correlation_mismatch');
  });
});

it('checks build correlation before using an unknown observation', async () => {
  await fixture(async ({ execute, manifest, effects, transport, calls, out }) => {
    const checked = { ...effects, observeLoadedBuild: async () => ({ kind: 'unknown' as const,
      requestId: 'foreign-request', arm: 'baseline' as const, reason: 'unavailable', rawTrace: 'foreign-build' }) };
    const result = await execute(manifest, out, transport, checked, new AbortController().signal);
    expect(result.status).toBe('rejected'); expect(calls).toHaveLength(0);
    if (result.status === 'rejected') expect(result.error.kind).toBe('build_correlation_mismatch');
  });
});

it.each(['reordered', 'duplicate', 'candidate_duplicate'] as const)('compares normalized observations by unique identity: %s', async variation => {
  await fixture(async ({ execute, manifest, effects, transport, calls, out }) => {
    const checked = { ...effects, executePreflight: async (...args: Parameters<typeof effects.executePreflight>) => {
      const result = await effects.executePreflight(...args);
      if (result.status !== 'executed' || (result.kind !== 'fault_equivalence' && result.kind !== 'review_obligations')) return result;
      const baseline = [{id:'a',value:'1'}, {id:variation === 'duplicate' ? 'a' : 'b',value:'2'}];
      return { ...result, observations: { baseline, candidate: variation === 'candidate_duplicate' ? [baseline[0], baseline[0]] : [...baseline].reverse() } };
    } };
    const result = await execute(manifest, out, transport, checked, new AbortController().signal);
    expect(result.status).toBe(variation === 'reordered' ? 'admitted' : 'rejected');
    expect(calls).toHaveLength(variation === 'reordered' ? 20 : 0);
  });
});
