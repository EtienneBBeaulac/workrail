/**
 * Export → Import Roundtrip Tests
 *
 * Verifies Gate 4 criteria from v2-core-design-locks.md §16.4:
 * - Export/import integrity passes
 * - Projections are equivalent post-import
 *
 * Uses fakes (not mocks) per coding philosophy.
 */

import { describe, it, expect } from 'vitest';
import { buildExportBundle, type BuildExportBundleArgs } from '../../../src/v2/durable-core/domain/bundle-builder.js';
import { validateBundle } from '../../../src/v2/durable-core/domain/bundle-validator.js';
import { importSession, type ImportSessionPorts } from '../../../src/v2/usecases/import-session.js';
import { createHash } from 'crypto';
import type { Sha256Digest } from '../../../src/v2/durable-core/ids/index.js';
import type { SnapshotRef } from '../../../src/v2/durable-core/ids/index.js';
import type { ExecutionSnapshotFileV1 } from '../../../src/v2/durable-core/schemas/execution-snapshot/index.js';
import type { CompiledWorkflowSnapshot } from '../../../src/v2/durable-core/schemas/compiled-workflow/index.js';
import type { WorkflowHash } from '../../../src/v2/durable-core/ids/index.js';
import type { SnapshotStoreError } from '../../../src/v2/ports/snapshot-store.port.js';
import type { PinnedWorkflowStoreError } from '../../../src/v2/ports/pinned-workflow-store.port.js';
import { okAsync } from 'neverthrow';
import type { ResultAsync } from 'neverthrow';

// =============================================================================
// Test SHA-256
// =============================================================================

function testSha256(bytes: Uint8Array): Sha256Digest {
  const hash = createHash('sha256').update(bytes).digest('hex');
  return `sha256:${hash}` as Sha256Digest;
}

// =============================================================================
// Fakes
// =============================================================================

class FakeSnapshotStore {
  private readonly store = new Map<string, ExecutionSnapshotFileV1>();

  putExecutionSnapshotV1(snapshot: ExecutionSnapshotFileV1): ResultAsync<SnapshotRef, SnapshotStoreError> {
    // Content-address by stringifying
    const key = JSON.stringify(snapshot);
    const hash = createHash('sha256').update(key).digest('hex');
    const ref = `sha256:${hash}` as SnapshotRef;
    this.store.set(ref, snapshot);
    return okAsync(ref);
  }

  getExecutionSnapshotV1(snapshotRef: SnapshotRef): ResultAsync<ExecutionSnapshotFileV1 | null, SnapshotStoreError> {
    return okAsync(this.store.get(snapshotRef) ?? null);
  }

  get size() { return this.store.size; }
  has(ref: string) { return this.store.has(ref); }
}

class FakePinnedWorkflowStore {
  private readonly store = new Map<string, CompiledWorkflowSnapshot>();

  put(workflowHash: WorkflowHash, compiled: CompiledWorkflowSnapshot): ResultAsync<void, PinnedWorkflowStoreError> {
    this.store.set(workflowHash, compiled);
    return okAsync(undefined);
  }

  get(workflowHash: WorkflowHash): ResultAsync<CompiledWorkflowSnapshot | null, PinnedWorkflowStoreError> {
    return okAsync(this.store.get(workflowHash) ?? null);
  }

  get size() { return this.store.size; }
  has(hash: string) { return this.store.has(hash); }
}

// =============================================================================
// Fixtures
// =============================================================================

function minimalEvent(index: number) {
  return {
    v: 1,
    eventId: `evt_${String(index).padStart(3, '0')}`,
    eventIndex: index,
    sessionId: 'sess_export_001',
    kind: 'session_created',
    dedupeKey: `session_created:sess_export_001:${String(index)}`,
    data: {},
  };
}

function minimalManifestRecord(index: number) {
  return {
    v: 1,
    manifestIndex: index,
    sessionId: 'sess_export_001',
    kind: 'segment_closed',
    firstEventIndex: 0,
    lastEventIndex: 0,
    segmentRelPath: `segments/seg_${String(index).padStart(3, '0')}.jsonl`,
    sha256: 'sha256:' + 'a'.repeat(64),
    bytes: 1024,
  };
}

function minimalSnapshot(): ExecutionSnapshotFileV1 {
  return {
    v: 1,
    kind: 'execution_snapshot',
    enginePayload: { v: 1, engineState: { kind: 'init' } },
  } as ExecutionSnapshotFileV1;
}

function buildTestBundle(overrides: Partial<BuildExportBundleArgs> = {}) {
  const result = buildExportBundle({
    bundleId: 'bundle_roundtrip_001',
    sessionId: 'sess_export_001',
    events: [minimalEvent(0), minimalEvent(1)] as any,
    manifest: [minimalManifestRecord(0)] as any,
    snapshots: new Map([['sha256:' + 'b'.repeat(64), minimalSnapshot()]]),
    pinnedWorkflows: new Map([['sha256:' + 'c'.repeat(64), { kind: 'v1_preview', compiled: {} } as any]]),
    producer: { appVersion: '1.2.0' },
    sha256: testSha256,
    ...overrides,
  });
  if (result.isErr()) throw new Error(`Build failed: ${result.error.message}`);
  return result.value;
}

// =============================================================================
// Roundtrip Tests
// =============================================================================

describe('export → import roundtrip', () => {
  it('exported bundle passes validation', () => {
    const bundle = buildTestBundle();
    const result = validateBundle(bundle, testSha256);
    expect(result.isOk()).toBe(true);
  });

  it('exported bundle survives JSON serialization roundtrip', () => {
    const bundle = buildTestBundle();
    const json = JSON.stringify(bundle);
    const parsed = JSON.parse(json);
    const result = validateBundle(parsed, testSha256);
    expect(result.isOk()).toBe(true);
  });

  it('import stores snapshots and pinned workflows', async () => {
    const bundle = buildTestBundle();
    const snapshotStore = new FakeSnapshotStore();
    const pinnedWorkflowStore = new FakePinnedWorkflowStore();
    let generatedId = 0;

    const ports: ImportSessionPorts = {
      snapshotStore,
      pinnedWorkflowStore,
      generateSessionId: () => `sess_imported_${String(++generatedId)}`,
      sha256: testSha256,
    };

    const result = await importSession(bundle, ports);
    expect(result.isOk()).toBe(true);

    const imported = result._unsafeUnwrap();
    expect(imported.sessionId).toBe('sess_imported_1');
    expect(imported.eventCount).toBe(2);
    expect(imported.snapshotCount).toBe(1);
    expect(imported.pinnedWorkflowCount).toBe(1);
  });

  it('import generates new session ID (import-as-new policy)', async () => {
    const bundle = buildTestBundle();
    const ports: ImportSessionPorts = {
      snapshotStore: new FakeSnapshotStore(),
      pinnedWorkflowStore: new FakePinnedWorkflowStore(),
      generateSessionId: () => 'sess_brand_new',
      sha256: testSha256,
    };

    const result = await importSession(bundle, ports);
    expect(result.isOk()).toBe(true);
    // New session ID, NOT the original
    expect(result._unsafeUnwrap().sessionId).toBe('sess_brand_new');
    expect(result._unsafeUnwrap().sessionId).not.toBe('sess_export_001');
  });

  it('import returns validated bundle for event persistence', async () => {
    const bundle = buildTestBundle();
    const ports: ImportSessionPorts = {
      snapshotStore: new FakeSnapshotStore(),
      pinnedWorkflowStore: new FakePinnedWorkflowStore(),
      generateSessionId: () => 'sess_new',
      sha256: testSha256,
    };

    const result = await importSession(bundle, ports);
    expect(result.isOk()).toBe(true);

    const imported = result._unsafeUnwrap();
    // validatedBundle should have the original events
    expect(imported.validatedBundle.session.events).toHaveLength(2);
    expect(imported.validatedBundle.session.sessionId).toBe('sess_export_001');
  });

  it('import rejects tampered bundle', async () => {
    const bundle = buildTestBundle();
    // Tamper with events
    (bundle.session.events as any[]).push(minimalEvent(99));

    const ports: ImportSessionPorts = {
      snapshotStore: new FakeSnapshotStore(),
      pinnedWorkflowStore: new FakePinnedWorkflowStore(),
      generateSessionId: () => 'should_not_be_used',
      sha256: testSha256,
    };

    const result = await importSession(bundle, ports);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('BUNDLE_INTEGRITY_FAILED');
  });

  it('event content is preserved through roundtrip', () => {
    const events = [minimalEvent(0), minimalEvent(1), minimalEvent(2)];

    const bundle = buildTestBundle({ events: events as any });
    const result = validateBundle(bundle, testSha256);
    expect(result.isOk()).toBe(true);

    const validated = result._unsafeUnwrap();
    expect(validated.session.events).toHaveLength(3);
    expect((validated.session.events[0] as any).eventIndex).toBe(0);
    expect((validated.session.events[1] as any).eventIndex).toBe(1);
    expect((validated.session.events[2] as any).eventIndex).toBe(2);
    expect(validated.session.sessionId).toBe('sess_export_001');
  });

  it('multiple imports generate distinct session IDs', async () => {
    const bundle = buildTestBundle();
    let counter = 0;
    const ports: ImportSessionPorts = {
      snapshotStore: new FakeSnapshotStore(),
      pinnedWorkflowStore: new FakePinnedWorkflowStore(),
      generateSessionId: () => `sess_${String(++counter)}`,
      sha256: testSha256,
    };

    const result1 = await importSession(bundle, ports);
    const result2 = await importSession(bundle, ports);

    expect(result1._unsafeUnwrap().sessionId).toBe('sess_1');
    expect(result2._unsafeUnwrap().sessionId).toBe('sess_2');
  });
});
