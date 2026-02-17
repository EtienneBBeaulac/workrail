/**
 * v2 Execution Session Gate Tests
 *
 * @enforces witness-required-for-append
 * @enforces witness-scope-enforced
 * @enforces execution-gated-by-health
 * @enforces session-health-closed-set
 * @enforces single-writer-per-session
 */
import { describe, expect, it } from 'vitest';
import { errAsync, okAsync } from 'neverthrow';
import { ExecutionSessionGateV2 } from '../../../src/v2/usecases/execution-session-gate.js';
import { asSessionId } from '../../../src/v2/durable-core/ids/index.js';
import type { SessionId } from '../../../src/v2/durable-core/ids/index.js';
import type { CorruptionReasonV2 } from '../../../src/v2/durable-core/schemas/session/session-health.js';
import type { SessionEventLogReadonlyStorePortV2, SessionEventLogStoreError } from '../../../src/v2/ports/session-event-log-store.port.js';
import type { SessionLockHandleV2, SessionLockPortV2, SessionLockError } from '../../../src/v2/ports/session-lock.port.js';
import * as os from 'os';
import * as path from 'path';

function okHandle(sessionId: SessionId): SessionLockHandleV2 {
  return { kind: 'v2_session_lock_handle', sessionId };
}

describe('ExecutionSessionGateV2', () => {
  it('fails fast on re-entrancy (SESSION_LOCK_REENTRANT)', async () => {
    const sessionId = asSessionId('sess_test');

    const lock: SessionLockPortV2 = {
      acquire: () => okAsync(okHandle(sessionId)),
      release: () => okAsync(undefined),
    };

    const store: SessionEventLogReadonlyStorePortV2 = {
      loadValidatedPrefix: () => okAsync({ truth: { manifest: [], events: [] }, isComplete: true, tailReason: null }),
      load: () => okAsync({ manifest: [], events: [] }),
    };

    const gate = new ExecutionSessionGateV2(lock, store);

    const res = await gate
      .withHealthySessionLock(sessionId, () =>
        gate.withHealthySessionLock(sessionId, () => okAsync('inner_ok'))
      )
      .match(
        (v) => ({ ok: true as const, value: v }),
        (e) => ({ ok: false as const, error: e })
      );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('SESSION_LOCK_REENTRANT');
  });

  it('returns SESSION_LOCKED with retry guidance when lock is busy', async () => {
    const sessionId = asSessionId('sess_locked');

    const lockBusy: SessionLockError = {
      code: 'SESSION_LOCK_BUSY',
      message: 'busy',
      retry: { kind: 'retryable', afterMs: 250 },
      lockPath: path.join(os.tmpdir(), 'workrail-lock'),
    };

    const lock: SessionLockPortV2 = {
      acquire: () => errAsync(lockBusy),
      release: () => okAsync(undefined),
    };

    const store: SessionEventLogReadonlyStorePortV2 = {
      loadValidatedPrefix: () => okAsync({ truth: { manifest: [], events: [] }, isComplete: true, tailReason: null }),
      load: () => okAsync({ manifest: [], events: [] }),
    };

    const gate = new ExecutionSessionGateV2(lock, store);

    const res = await gate.withHealthySessionLock(sessionId, () => okAsync('ok')).match(
      (v) => ({ ok: true as const, value: v }),
      (e) => ({ ok: false as const, error: e })
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('SESSION_LOCKED');
    expect(res.error.sessionId).toBe(sessionId);
    expect(res.error.retry.kind).toBe('retryable_after_ms');
    expect(res.error.message).toContain('retry in 1–3 seconds');
  });

  it('fails without acquiring lock when validated prefix indicates corrupt tail', async () => {
    const sessionId = asSessionId('sess_corrupt_tail');

    let acquireCalls = 0;

    const lock: SessionLockPortV2 = {
      acquire: () => {
        acquireCalls += 1;
        return okAsync(okHandle(sessionId));
      },
      release: () => okAsync(undefined),
    };

    const tailReason: CorruptionReasonV2 = { code: 'missing_attested_segment', message: 'missing seg' };

    const store: SessionEventLogReadonlyStorePortV2 = {
      loadValidatedPrefix: () => okAsync({ kind: 'truncated', truth: { manifest: [], events: [] }, tailReason }),
      load: () => okAsync({ manifest: [], events: [] }),
    };

    const gate = new ExecutionSessionGateV2(lock, store);
    const res = await gate.withHealthySessionLock(sessionId, () => okAsync('ok')).match(
      (v) => ({ ok: true as const, value: v }),
      (e) => ({ ok: false as const, error: e })
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('SESSION_NOT_HEALTHY');
    expect(acquireCalls).toBe(0);
  });

  it('maps store missing_attested_segment during strict load to SESSION_NOT_HEALTHY corrupt_tail', async () => {
    const sessionId = asSessionId('sess_corrupt_on_load');

    const lock: SessionLockPortV2 = {
      acquire: () => okAsync(okHandle(sessionId)),
      release: () => okAsync(undefined),
    };

    const storeCorrupt: SessionEventLogStoreError = {
      code: 'SESSION_STORE_CORRUPTION_DETECTED',
      location: 'tail',
      reason: { code: 'missing_attested_segment', message: 'missing segment' },
      message: 'missing segment',
    };

    const store: SessionEventLogReadonlyStorePortV2 = {
      loadValidatedPrefix: () => okAsync({ truth: { manifest: [], events: [] }, isComplete: true, tailReason: null }),
      load: () => errAsync(storeCorrupt),
    };

    const gate = new ExecutionSessionGateV2(lock, store);
    const res = await gate.withHealthySessionLock(sessionId, () => okAsync('ok')).match(
      (v) => ({ ok: true as const, value: v }),
      (e) => ({ ok: false as const, error: e })
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('SESSION_NOT_HEALTHY');
    expect(res.error.health.kind).toBe('corrupt_tail');
    if (res.error.code !== 'SESSION_NOT_HEALTHY') return;
    if (res.error.health.kind !== 'corrupt_tail') return;
    expect(res.error.health.reason.code).toBe('missing_attested_segment');
  });
});
