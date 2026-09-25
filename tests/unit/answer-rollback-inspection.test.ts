import { describe, expect, it } from 'vitest';
import { inspectLegacyRollback } from '../../src/answer-v1/legacy-rollback.js';
import type { HostDiscoveryCursor, HostSessionScanner } from '../../src/answer-v1/contracts/host-discovery-contract.js';
import type { LegacyRollbackInspectConfig } from '../../src/answer-v1/contracts/legacy-rollback-contract.js';
import { asSessionId } from '../../src/v2/durable-core/ids/index.js';

const config: LegacyRollbackInspectConfig = {
  targetBaseline: '396cdfa4e665afa993b50fcf0ec59ca53a2167db',
  discovery: {
    storage: { journalRootDir: '/unused/sessions', hostIndexRootDir: '/unused/index' },
    keyringPath: '/unused/keyring', workflowStoragePath: '/unused/workflows',
  },
};

describe('rollback inspection read boundary', () => {
  it('retains observed blockers on cancellation and closes with a live cleanup signal', async () => {
    const controller = new AbortController();
    const cursor = {} as HostDiscoveryCursor;
    let closed = false;
    const scanner: HostSessionScanner = {
      async scan(position) {
        if (position === undefined) return { kind: 'page', page: { kind: 'more', entries: [
          { kind: 'unbound', sessionId: asSessionId('sess_retained') },
        ], nextCursor: cursor } };
        expect(position).toBe(cursor);
        controller.abort();
        return { kind: 'cancelled' };
      },
      async close(signal) { expect(signal.aborted).toBe(false); closed = true; return { kind: 'closed' }; },
    };
    const result = await inspectLegacyRollback(config, controller.signal, async () => ({ kind: 'created', scanner }));
    expect(closed).toBe(true);
    expect(result).toMatchObject({ kind: 'inconclusive', issues: [{ kind: 'root', reason: 'scan_cancelled' }],
      observedIncompatibleSessions: [{ kind: 'unbound', sessionId: 'sess_retained' }] });
  });

  it('cannot report an empty success when cleanup fails', async () => {
    const scanner: HostSessionScanner = {
      async scan() { return { kind: 'page', page: { kind: 'end', entries: [] } }; },
      async close() { return { kind: 'incomplete', reason: 'cancelled', detail: 'Cleanup did not finish' }; },
    };
    const result = await inspectLegacyRollback(config, AbortSignal.timeout(1000), async () => ({ kind: 'created', scanner }));
    expect(result).toMatchObject({ kind: 'inconclusive', issues: [{ reason: 'cleanup_incomplete' }] });
  });

  it('does not construct discovery for a pre-aborted call', async () => {
    const result = await inspectLegacyRollback(config, AbortSignal.abort(), async () => { throw new Error('Must not open'); });
    expect(result.kind).toBe('cancelled');
  });
});
