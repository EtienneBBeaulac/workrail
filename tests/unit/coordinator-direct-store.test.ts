/**
 * Unit tests for coordinator-deps.ts direct store access.
 *
 * Verifies the new polling and artifact-reading paths introduced when
 * ConsoleService was replaced with direct ctx.v2.sessionStore +
 * ctx.v2.snapshotStore calls.
 *
 * Tests:
 * - awaitSessions: SESSION_STORE_IO_ERROR → retries (does not fail fast)
 * - awaitSessions: SESSION_STORE_CORRUPTION_DETECTED → fails fast
 * - awaitSessions: complete session (tip snapshot engineState.kind=complete) → success
 * - awaitSessions: blocked session (isBlocked:true from signals) → failed
 * - fetchAgentResult (via getAgentResult): seeded recap + artifact → correct values
 * - fetchAgentResult (via getAgentResult): empty event log → empty result
 *
 * Strategy: minimal fake V2ToolContext with controlled sessionStore and snapshotStore.
 * Only the fields used by deriveSessionStatus and fetchAgentResult are populated.
 * All other V2Dependencies fields are left as undefined/null (never accessed in these paths).
 */

import { describe, it, expect } from 'vitest';
import { okAsync, errAsync } from 'neverthrow';
import type { ResultAsync } from 'neverthrow';
import { createCoordinatorDeps, SessionReader } from '../../src/trigger/coordinator-deps.js';
import type { V2ToolContext } from '../../src/mcp/types.js';
import type { SessionId, SnapshotRef } from '../../src/v2/durable-core/ids/index.js';
import { asSessionId, asSnapshotRef, asSha256Digest } from '../../src/v2/durable-core/ids/index.js';
import type {
  SessionEventLogReadonlyStorePortV2,
  LoadedSessionTruthV2,
  SessionEventLogStoreError,
} from '../../src/v2/ports/session-event-log-store.port.js';
import type {
  SnapshotStorePortV2,
  SnapshotStoreError,
} from '../../src/v2/ports/snapshot-store.port.js';
import type { ExecutionSnapshotFileV1 } from '../../src/v2/durable-core/schemas/execution-snapshot/index.js';
import type { DomainEventV1 } from '../../src/v2/durable-core/schemas/session/index.js';
import { EVENT_KIND, OUTPUT_CHANNEL, PAYLOAD_KIND } from '../../src/v2/durable-core/constants.js';

// ---------------------------------------------------------------------------
// Helpers: minimal fake stores
// ---------------------------------------------------------------------------

function makeSessionStore(
  loadFn: (sessionId: SessionId) => ResultAsync<LoadedSessionTruthV2, SessionEventLogStoreError>,
): SessionEventLogReadonlyStorePortV2 {
  return {
    load: loadFn,
    loadValidatedPrefix: (id) => loadFn(id).map((truth) => ({ kind: 'complete' as const, truth })),
  };
}

function makeSnapshotStore(
  getFn: (ref: SnapshotRef) => ResultAsync<ExecutionSnapshotFileV1 | null, SnapshotStoreError>,
): SnapshotStorePortV2 {
  return {
    getExecutionSnapshotV1: getFn,
    putExecutionSnapshotV1: () => errAsync({ code: 'SNAPSHOT_STORE_IO_ERROR' as const, message: 'not implemented in fake' }),
  };
}

function makeCtx(
  sessionStore: SessionEventLogReadonlyStorePortV2,
  snapshotStore: SnapshotStorePortV2,
): V2ToolContext {
  return {
    workflowService: {} as never,
    featureFlags: {} as never,
    sessionManager: null,
    v2: {
      sessionStore: sessionStore as never,
      snapshotStore,
      // The following are not accessed by deriveSessionStatus or fetchAgentResult.
      // Cast as never so TypeScript does not require filling in the full V2Dependencies shape.
      gate: {} as never,
      pinnedStore: {} as never,
      sha256: {} as never,
      crypto: {} as never,
      idFactory: {} as never,
      tokenCodecPorts: {} as never,
      tokenAliasStore: {} as never,
      entropy: {} as never,
      validationPipelineDeps: {} as never,
    },
  };
}

function makeCoordinator(sessionStore: SessionEventLogReadonlyStorePortV2, snapshotStore: SnapshotStorePortV2) {
  return createCoordinatorDeps({
    ctx: makeCtx(sessionStore, snapshotStore),
    execFileAsync: async () => ({ stdout: '' }),
    dispatch: () => {},
  });
}

// ---------------------------------------------------------------------------
// createCoordinatorDeps: precondition enforcement
// ---------------------------------------------------------------------------

describe('createCoordinatorDeps: throws when ctx.v2 is null', () => {
  it('throws with a clear message when ctx.v2 is absent', () => {
    expect(() => createCoordinatorDeps({
      ctx: { v2: null } as never,
      execFileAsync: async () => ({ stdout: '' }),
      dispatch: () => {},
    })).toThrow('createCoordinatorDeps: ctx.v2 is required');
  });
});

// ---------------------------------------------------------------------------
// Helpers: minimal event + snapshot fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'sess_0test000000000000000000000';
const RUN_ID = 'run_test000000000000000000001';
const NODE_ID = 'node_test00000000000000000001';
const SNAPSHOT_REF_STR = 'sha256:' + 'a'.repeat(64);

function makeNodeCreatedEvent(snapshotRef: string): DomainEventV1 {
  return {
    v: 1,
    eventId: 'evt_001',
    eventIndex: 0,
    sessionId: SESSION_ID,
    kind: EVENT_KIND.NODE_CREATED,
    dedupeKey: 'node_created:0',
    scope: { runId: RUN_ID, nodeId: NODE_ID },
    data: {
      nodeKind: 'step' as const,
      parentNodeId: null,
      workflowHash: 'sha256:' + 'b'.repeat(64) as never,
      snapshotRef,
    },
    timestampMs: Date.now(),
  };
}

function makeRunStartedEvent(): DomainEventV1 {
  return {
    v: 1,
    eventId: 'evt_000',
    eventIndex: 1,
    sessionId: SESSION_ID,
    kind: EVENT_KIND.RUN_STARTED,
    dedupeKey: 'run_started:0',
    scope: { runId: RUN_ID, nodeId: NODE_ID },
    data: { workflowId: 'wr.test' } as never,
    timestampMs: Date.now(),
  };
}

function makeRecapEvent(nodeId: string, notesMarkdown: string): DomainEventV1 {
  return {
    v: 1,
    eventId: 'evt_recap',
    eventIndex: 2,
    sessionId: SESSION_ID,
    kind: EVENT_KIND.NODE_OUTPUT_APPENDED,
    dedupeKey: 'recap:0',
    scope: { runId: RUN_ID, nodeId },
    data: {
      outputId: 'out_recap',
      outputChannel: OUTPUT_CHANNEL.RECAP,
      payload: {
        payloadKind: PAYLOAD_KIND.NOTES,
        notesMarkdown,
      },
    } as never,
    timestampMs: Date.now(),
  };
}

function makeArtifactEvent(nodeId: string, artifactContent: unknown): DomainEventV1 {
  return {
    v: 1,
    eventId: 'evt_artifact',
    eventIndex: 3,
    sessionId: SESSION_ID,
    kind: EVENT_KIND.NODE_OUTPUT_APPENDED,
    dedupeKey: 'artifact:0',
    scope: { runId: RUN_ID, nodeId },
    data: {
      outputId: 'out_artifact',
      outputChannel: OUTPUT_CHANNEL.ARTIFACT,
      payload: {
        payloadKind: PAYLOAD_KIND.ARTIFACT_REF,
        sha256: 'sha256:' + 'c'.repeat(64),
        contentType: 'application/json',
        byteLength: 64,
        content: artifactContent,
      },
    } as never,
    timestampMs: Date.now(),
  };
}

function makeCompleteSnapshot(): ExecutionSnapshotFileV1 {
  return {
    enginePayload: {
      engineState: { kind: 'complete' },
    },
  } as never;
}

function makeInProgressSnapshot(): ExecutionSnapshotFileV1 {
  return {
    enginePayload: {
      engineState: { kind: 'pending', pending: {} },
    },
  } as never;
}

const SNAPSHOT_REF = asSnapshotRef(asSha256Digest(SNAPSHOT_REF_STR));

// ---------------------------------------------------------------------------
// awaitSessions: error code dispatch
// ---------------------------------------------------------------------------

describe('awaitSessions: SESSION_STORE_IO_ERROR → retries, does not fail fast', () => {
  it('treats IO_ERROR as retry and returns timeout outcome (not failed)', async () => {
    let callCount = 0;
    const sessionStore = makeSessionStore((_id) => {
      callCount++;
      return errAsync({ code: 'SESSION_STORE_IO_ERROR' as const, message: 'ENOENT' });
    });
    const snapshotStore = makeSnapshotStore(() => okAsync(null));
    const coords = makeCoordinator(sessionStore, snapshotStore);

    const result = await coords.awaitSessions([SESSION_ID], 100); // very short timeout
    expect(result.results[0]?.outcome).toBe('timeout');
    expect(callCount).toBeGreaterThan(0);
  });
});

describe('awaitSessions: SESSION_STORE_CORRUPTION_DETECTED → fails fast', () => {
  it('treats CORRUPTION_DETECTED as immediate failure (not timeout)', async () => {
    let callCount = 0;
    const sessionStore = makeSessionStore((_id) => {
      callCount++;
      return errAsync({
        code: 'SESSION_STORE_CORRUPTION_DETECTED' as const,
        message: 'corrupt',
        location: 'head' as const,
        reason: { kind: 'event_index_gap' } as never,
      });
    });
    const snapshotStore = makeSnapshotStore(() => okAsync(null));
    const coords = makeCoordinator(sessionStore, snapshotStore);

    const result = await coords.awaitSessions([SESSION_ID], 60_000); // long timeout -- must not wait
    expect(result.results[0]?.outcome).toBe('failed');
    expect(callCount).toBe(1); // fails on first poll, does not retry
  });
});

// ---------------------------------------------------------------------------
// awaitSessions: terminal status detection
// ---------------------------------------------------------------------------

describe('awaitSessions: complete session → success', () => {
  it('returns outcome=success when tip snapshot engineState.kind=complete', async () => {
    const events: DomainEventV1[] = [
      makeNodeCreatedEvent(SNAPSHOT_REF_STR),
      makeRunStartedEvent(),
    ];
    const sessionStore = makeSessionStore((_id) =>
      okAsync({ events, manifest: [] }),
    );
    const snapshotStore = makeSnapshotStore((_ref) =>
      okAsync(makeCompleteSnapshot()),
    );
    const coords = makeCoordinator(sessionStore, snapshotStore);

    const result = await coords.awaitSessions([SESSION_ID], 5_000);
    expect(result.results[0]?.outcome).toBe('success');
    expect(result.allSucceeded).toBe(true);
  });
});

describe('awaitSessions: in-progress session → timeout', () => {
  it('returns outcome=timeout when snapshot is never complete within timeoutMs', async () => {
    const events: DomainEventV1[] = [
      makeNodeCreatedEvent(SNAPSHOT_REF_STR),
      makeRunStartedEvent(),
    ];
    const sessionStore = makeSessionStore((_id) =>
      okAsync({ events, manifest: [] }),
    );
    const snapshotStore = makeSnapshotStore((_ref) =>
      okAsync(makeInProgressSnapshot()),
    );
    const coords = makeCoordinator(sessionStore, snapshotStore);

    const result = await coords.awaitSessions([SESSION_ID], 100); // short timeout
    expect(result.results[0]?.outcome).toBe('timeout');
  });
});

// ---------------------------------------------------------------------------
// getAgentResult: reads recap notes and artifacts from event log
// ---------------------------------------------------------------------------

describe('getAgentResult: seeded session with recap and artifact', () => {
  it('returns correct recapMarkdown from tip node and artifact content from all nodes', async () => {
    const expectedNotes = 'These are the final step notes from the agent.';
    const expectedArtifact = { kind: 'wr.review_verdict', verdict: 'clean', confidence: 'high', findings: [], summary: 'ok' };

    const events: DomainEventV1[] = [
      makeNodeCreatedEvent(SNAPSHOT_REF_STR),
      makeRunStartedEvent(),
      makeRecapEvent(NODE_ID, expectedNotes),
      makeArtifactEvent(NODE_ID, expectedArtifact),
    ];
    const sessionStore = makeSessionStore((_id) =>
      okAsync({ events, manifest: [] }),
    );
    const snapshotStore = makeSnapshotStore(() => okAsync(null));
    const coords = makeCoordinator(sessionStore, snapshotStore);

    const result = await coords.getAgentResult(SESSION_ID);
    expect(result.recapMarkdown).toBe(expectedNotes);
    expect(result.artifacts).toHaveLength(1);
    expect((result.artifacts[0] as typeof expectedArtifact).kind).toBe('wr.review_verdict');
    expect((result.artifacts[0] as typeof expectedArtifact).verdict).toBe('clean');
  });
});

describe('getAgentResult: empty event log', () => {
  it('returns null recapMarkdown and empty artifacts for a session with no events', async () => {
    const sessionStore = makeSessionStore((_id) =>
      okAsync({ events: [], manifest: [] }),
    );
    const snapshotStore = makeSnapshotStore(() => okAsync(null));
    const coords = makeCoordinator(sessionStore, snapshotStore);

    const result = await coords.getAgentResult(SESSION_ID);
    expect(result.recapMarkdown).toBeNull();
    expect(result.artifacts).toHaveLength(0);
  });
});

describe('getAgentResult: SESSION_STORE_IO_ERROR → returns empty result', () => {
  it('returns null recapMarkdown and empty artifacts when store load fails', async () => {
    const sessionStore = makeSessionStore((_id) =>
      errAsync({ code: 'SESSION_STORE_IO_ERROR' as const, message: 'not found' }),
    );
    const snapshotStore = makeSnapshotStore(() => okAsync(null));
    const coords = makeCoordinator(sessionStore, snapshotStore);

    const result = await coords.getAgentResult(SESSION_ID);
    expect(result.recapMarkdown).toBeNull();
    expect(result.artifacts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SessionReader: direct construction (proves testable in isolation)
// ---------------------------------------------------------------------------

describe('SessionReader: directly constructable with fake stores (no V2ToolContext required)', () => {
  it('deriveSessionStatus returns blocked when tip node is blocked_attempt', async () => {
    // blocked_attempt tip node → blockedByTopology = true → isBlocked = true
    const blockedAttemptNodeId = 'node_blocked000000000000000001';
    const blockedAttemptEvent: DomainEventV1 = {
      v: 1,
      eventId: 'evt_blocked',
      eventIndex: 0,
      sessionId: SESSION_ID,
      kind: EVENT_KIND.NODE_CREATED,
      dedupeKey: 'node_created:blocked',
      scope: { runId: RUN_ID, nodeId: blockedAttemptNodeId },
      data: {
        nodeKind: 'blocked_attempt' as const,
        parentNodeId: null,
        workflowHash: 'sha256:' + 'b'.repeat(64) as never,
        snapshotRef: SNAPSHOT_REF_STR,
      },
      timestampMs: Date.now(),
    };

    const sessionStore = makeSessionStore((_id) =>
      okAsync({ events: [blockedAttemptEvent], manifest: [] }),
    );
    const snapshotStore = makeSnapshotStore(() => okAsync(makeInProgressSnapshot()));

    // Construct SessionReader DIRECTLY -- no V2ToolContext, no execFileAsync, no dispatch
    const reader = new SessionReader(sessionStore, snapshotStore);
    const result = await reader.deriveSessionStatus(SESSION_ID);

    expect(result.kind).toBe('blocked');
  });

  it('deriveSessionStatus returns complete when tip snapshot engineState is complete', async () => {
    const events: DomainEventV1[] = [
      makeNodeCreatedEvent(SNAPSHOT_REF_STR),
      makeRunStartedEvent(),
    ];
    const sessionStore = makeSessionStore((_id) => okAsync({ events, manifest: [] }));
    const snapshotStore = makeSnapshotStore(() => okAsync(makeCompleteSnapshot()));

    const reader = new SessionReader(sessionStore, snapshotStore);
    const result = await reader.deriveSessionStatus(SESSION_ID);

    expect(result.kind).toBe('complete');
  });

  it('fetchAgentResult returns notes and artifacts without constructing CoordinatorDepsImpl', async () => {
    const expectedNotes = 'SessionReader direct test notes.';
    const expectedArtifact = { kind: 'wr.review_verdict', verdict: 'clean', confidence: 'high', findings: [], summary: 'direct' };
    const events: DomainEventV1[] = [
      makeNodeCreatedEvent(SNAPSHOT_REF_STR),
      makeRunStartedEvent(),
      makeRecapEvent(NODE_ID, expectedNotes),
      makeArtifactEvent(NODE_ID, expectedArtifact),
    ];
    const sessionStore = makeSessionStore((_id) => okAsync({ events, manifest: [] }));
    const snapshotStore = makeSnapshotStore(() => okAsync(null));

    const reader = new SessionReader(sessionStore, snapshotStore);
    const result = await reader.fetchAgentResult(SESSION_ID);

    expect(result.recapMarkdown).toBe(expectedNotes);
    expect(result.artifacts).toHaveLength(1);
    expect((result.artifacts[0] as { kind: string }).kind).toBe('wr.review_verdict');
  });
});
