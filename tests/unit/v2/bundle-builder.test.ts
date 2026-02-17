/**
 * Bundle Builder Tests
 *
 * Tests for the pure bundle builder that produces ExportBundleV1
 * with correct integrity entries from session truth + references.
 *
 * Lock: docs/design/v2-core-design-locks.md §1.3
 */

import { describe, it, expect } from 'vitest';
import { buildExportBundle, type BuildExportBundleArgs } from '../../../src/v2/durable-core/domain/bundle-builder.js';
import { toCanonicalBytes } from '../../../src/v2/durable-core/canonical/jcs.js';
import { createHash } from 'crypto';
import type { Sha256Digest } from '../../../src/v2/durable-core/ids/index.js';

// =============================================================================
// Test SHA-256 (deterministic, uses Node crypto)
// =============================================================================

function testSha256(bytes: Uint8Array): Sha256Digest {
  const hash = createHash('sha256').update(bytes).digest('hex');
  return `sha256:${hash}` as Sha256Digest;
}

// =============================================================================
// Fixtures
// =============================================================================

function minimalEvent(index: number) {
  return {
    v: 1,
    eventId: `evt_${String(index).padStart(3, '0')}`,
    eventIndex: index,
    sessionId: 'sess_001',
    kind: 'session_created',
    dedupeKey: `session_created:sess_001:${String(index)}`,
    data: {},
  };
}

function minimalManifestRecord(index: number) {
  return {
    v: 1,
    manifestIndex: index,
    sessionId: 'sess_001',
    kind: 'segment_closed',
    firstEventIndex: 0,
    lastEventIndex: 0,
    segmentRelPath: `segments/seg_${String(index).padStart(3, '0')}.jsonl`,
    sha256: 'sha256:' + 'a'.repeat(64),
    bytes: 1024,
  };
}

function minimalSnapshot() {
  return {
    v: 1,
    kind: 'execution_snapshot',
    enginePayload: { v: 1, engineState: { kind: 'init' } },
  };
}

function baseArgs(overrides: Partial<BuildExportBundleArgs> = {}): BuildExportBundleArgs {
  return {
    bundleId: 'bundle_test_001',
    sessionId: 'sess_001',
    events: [minimalEvent(0)] as any,
    manifest: [minimalManifestRecord(0)] as any,
    snapshots: new Map([['sha256:' + 'b'.repeat(64), minimalSnapshot() as any]]),
    pinnedWorkflows: new Map([['sha256:' + 'c'.repeat(64), { compiled: true }]]),
    producer: { appVersion: '1.2.0' },
    sha256: testSha256,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('buildExportBundle', () => {
  it('produces a valid bundle with correct structure', () => {
    const result = buildExportBundle(baseArgs());
    expect(result.isOk()).toBe(true);

    const bundle = result._unsafeUnwrap();
    expect(bundle.bundleSchemaVersion).toBe(1);
    expect(bundle.bundleId).toBe('bundle_test_001');
    expect(bundle.session.sessionId).toBe('sess_001');
    expect(bundle.session.events).toHaveLength(1);
    expect(bundle.session.manifest).toHaveLength(1);
    expect(bundle.integrity.kind).toBe('sha256_manifest_v1');
  });

  it('fails on empty events', () => {
    const result = buildExportBundle(baseArgs({ events: [] }));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('BUNDLE_BUILD_EMPTY_EVENTS');
  });

  it('computes correct integrity entries for events and manifest', () => {
    const result = buildExportBundle(baseArgs());
    const bundle = result._unsafeUnwrap();

    const paths = bundle.integrity.entries.map(e => e.path);
    expect(paths).toContain('session/events');
    expect(paths).toContain('session/manifest');
  });

  it('includes integrity entries for each snapshot', () => {
    const result = buildExportBundle(baseArgs());
    const bundle = result._unsafeUnwrap();

    const snapshotPaths = bundle.integrity.entries.filter(e => e.path.startsWith('session/snapshots/'));
    expect(snapshotPaths).toHaveLength(1);
    expect(snapshotPaths[0].path).toBe('session/snapshots/sha256:' + 'b'.repeat(64));
  });

  it('includes integrity entries for each pinned workflow', () => {
    const result = buildExportBundle(baseArgs());
    const bundle = result._unsafeUnwrap();

    const workflowPaths = bundle.integrity.entries.filter(e => e.path.startsWith('session/pinnedWorkflows/'));
    expect(workflowPaths).toHaveLength(1);
    expect(workflowPaths[0].path).toBe('session/pinnedWorkflows/sha256:' + 'c'.repeat(64));
  });

  it('integrity hashes are deterministic (same input → same hash)', () => {
    const args = baseArgs();
    const result1 = buildExportBundle(args);
    const result2 = buildExportBundle(args);

    const entries1 = result1._unsafeUnwrap().integrity.entries;
    const entries2 = result2._unsafeUnwrap().integrity.entries;

    expect(entries1).toEqual(entries2);
  });

  it('integrity hashes are computed from JCS canonical bytes', () => {
    const args = baseArgs();
    const result = buildExportBundle(args);
    const bundle = result._unsafeUnwrap();

    // Manually verify the events integrity entry
    const eventsEntry = bundle.integrity.entries.find(e => e.path === 'session/events')!;
    const canonicalResult = toCanonicalBytes(bundle.session.events as any);
    expect(canonicalResult.isOk()).toBe(true);

    const expectedDigest = testSha256(canonicalResult._unsafeUnwrap());
    expect(eventsEntry.sha256).toBe(expectedDigest);
    expect(eventsEntry.bytes).toBe(canonicalResult._unsafeUnwrap().byteLength);
  });

  it('handles empty snapshots and workflows maps', () => {
    const result = buildExportBundle(baseArgs({
      snapshots: new Map(),
      pinnedWorkflows: new Map(),
    }));
    expect(result.isOk()).toBe(true);

    const bundle = result._unsafeUnwrap();
    // Only events + manifest entries
    expect(bundle.integrity.entries).toHaveLength(2);
  });

  it('includes producer info in bundle', () => {
    const result = buildExportBundle(baseArgs({
      producer: { appVersion: '2.0.0', appliedConfigHash: 'sha256:' + 'f'.repeat(64) },
    }));
    const bundle = result._unsafeUnwrap();

    expect(bundle.producer.appVersion).toBe('2.0.0');
    expect(bundle.producer.appliedConfigHash).toBe('sha256:' + 'f'.repeat(64));
  });

  it('omits appliedConfigHash when not provided', () => {
    const result = buildExportBundle(baseArgs({
      producer: { appVersion: '1.0.0' },
    }));
    const bundle = result._unsafeUnwrap();

    expect(bundle.producer.appVersion).toBe('1.0.0');
    expect(bundle.producer.appliedConfigHash).toBeUndefined();
  });

  it('handles multiple events and manifest records', () => {
    const result = buildExportBundle(baseArgs({
      events: [minimalEvent(0), minimalEvent(1), minimalEvent(2)] as any,
      manifest: [minimalManifestRecord(0), minimalManifestRecord(1)] as any,
    }));
    expect(result.isOk()).toBe(true);

    const bundle = result._unsafeUnwrap();
    expect(bundle.session.events).toHaveLength(3);
    expect(bundle.session.manifest).toHaveLength(2);
  });
});
