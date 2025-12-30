/**
 * v2 Session Store Idempotency Tests
 *
 * @enforces dedupe-key-idempotent
 * @enforces dedupe-key-stable
 * @enforces append-plan-atomic
 * @enforces ack-idempotency-key
 * @enforces ack-replay-idempotent
 */
import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { LocalDataDirV2 } from '../../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../../src/v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../../../src/v2/infra/local/sha256/index.js';
import { LocalSessionEventLogStoreV2 } from '../../../src/v2/infra/local/session-store/index.js';
import { LocalSessionLockV2 } from '../../../src/v2/infra/local/session-lock/index.js';
import { ExecutionSessionGateV2 } from '../../../src/v2/usecases/execution-session-gate.js';
import { NodeTimeClockV2 } from '../../../src/v2/infra/local/time-clock/index.js';
import { asSessionId } from '../../../src/v2/durable-core/ids/index.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

/**
 * Session store idempotency invariants.
 * 
 * Lock: src/v2/infra/local/session-store/index.ts:68
 * > Partial replay detection (locked invariant violation):
 * > if ANY event exists but NOT all, fail fast.
 * 
 * Purpose: Verify append is all-or-nothing (no partial success)
 */

describe('Session store idempotency (all-or-nothing)', () => {
  it('rejects partial idempotency (some events exist, some do not)', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v2-partial-'));
    const prevDataDir = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = tempDir;

    try {
      const dataDir = new LocalDataDirV2(process.env);
      const fsPort = new NodeFileSystemV2();
      const sha256 = new NodeSha256V2();
      const sessionStore = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256);
      const lockPort = new LocalSessionLockV2(dataDir, fsPort, new NodeTimeClockV2());
      const gate = new ExecutionSessionGateV2(lockPort, sessionStore);

      const sessionId = asSessionId('sess_partial_test');

      const event1: DomainEventV1 = {
        v: 1,
        eventId: 'evt_1',
        eventIndex: 0,
        sessionId,
        kind: 'session_created',
        dedupeKey: 'session_created:sess_partial_test',
        data: {},
      };

      const event2: DomainEventV1 = {
        v: 1,
        eventId: 'evt_2',
        eventIndex: 1,
        sessionId,
        kind: 'run_started',
        dedupeKey: 'run_started:sess_partial_test:run_1',
        scope: { runId: 'run_1' },
        data: {
          workflowId: 'test',
          workflowHash: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
          workflowSourceKind: 'project',
          workflowSourceRef: 'test',
        },
      };

      const res1 = await gate.withHealthySessionLock(sessionId, (lock) =>
        sessionStore.append(lock, {
          events: [event1, event2],
          snapshotPins: [],
        })
      );
      expect(res1.isOk()).toBe(true);

      const event3: DomainEventV1 = {
        v: 1,
        eventId: 'evt_3',
        eventIndex: 2,
        sessionId,
        kind: 'observation_recorded',
        dedupeKey: 'observation_recorded:sess_partial_test:git_branch:abc123',
        data: {
          key: 'git_branch',
          value: { type: 'short_string', value: 'main' },
          confidence: 'high',
        },
      };

      const res2 = await gate.withHealthySessionLock(sessionId, (lock) =>
        sessionStore.append(lock, {
          events: [event1, event3],
          snapshotPins: [],
        })
      );

      expect(res2.isErr()).toBe(true);
      expect(res2._unsafeUnwrapErr().code).toBe('SESSION_STORE_INVARIANT_VIOLATION');
      expect(res2._unsafeUnwrapErr().message).toContain('Partial dedupeKey collision');
    } finally {
      process.env.WORKRAIL_DATA_DIR = prevDataDir;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('allows full idempotent replay (all events exist)', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v2-full-'));
    const prevDataDir = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = tempDir;

    try {
      const dataDir = new LocalDataDirV2(process.env);
      const fsPort = new NodeFileSystemV2();
      const sha256 = new NodeSha256V2();
      const sessionStore = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256);
      const lockPort = new LocalSessionLockV2(dataDir, fsPort, new NodeTimeClockV2());
      const gate = new ExecutionSessionGateV2(lockPort, sessionStore);

      const sessionId = asSessionId('sess_full_test');

      const events: DomainEventV1[] = [
        {
          v: 1,
          eventId: 'evt_1',
          eventIndex: 0,
          sessionId,
          kind: 'session_created',
          dedupeKey: 'session_created:sess_full_test',
          data: {},
        },
      ];

      const res1 = await gate.withHealthySessionLock(sessionId, (lock) =>
        sessionStore.append(lock, { events, snapshotPins: [] })
      );
      expect(res1.isOk()).toBe(true);

      const res2 = await gate.withHealthySessionLock(sessionId, (lock) =>
        sessionStore.append(lock, { events, snapshotPins: [] })
      );

      expect(res2.isOk()).toBe(true);

      const loaded = await sessionStore.load(sessionId);
      expect(loaded.isOk()).toBe(true);
      expect(loaded._unsafeUnwrap().events.length).toBe(1);
    } finally {
      process.env.WORKRAIL_DATA_DIR = prevDataDir;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
