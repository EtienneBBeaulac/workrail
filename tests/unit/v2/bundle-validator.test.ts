/**
 * Bundle Validator Tests
 *
 * Tests the 4-phase validation pipeline for import bundles.
 * Each phase fails with the correct error code from the locked closed set.
 *
 * Lock: bundle-import-validates-first, bundle-errors-closed-set
 */

import { describe, it, expect } from 'vitest';
import { validateBundle } from '../../../src/v2/durable-core/domain/bundle-validator.js';
import { buildExportBundle, type BuildExportBundleArgs } from '../../../src/v2/durable-core/domain/bundle-builder.js';
import { createHash } from 'crypto';
import type { Sha256Digest } from '../../../src/v2/durable-core/ids/index.js';

// =============================================================================
// Test SHA-256
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

/** Build a valid bundle via the builder (trusted path) */
function buildValidBundle(overrides: Partial<BuildExportBundleArgs> = {}) {
  const args: BuildExportBundleArgs = {
    bundleId: 'bundle_test_001',
    sessionId: 'sess_001',
    events: [minimalEvent(0)] as any,
    manifest: [minimalManifestRecord(0)] as any,
    snapshots: new Map(),
    pinnedWorkflows: new Map(),
    producer: { appVersion: '1.0.0' },
    sha256: testSha256,
    ...overrides,
  };
  const result = buildExportBundle(args);
  if (result.isErr()) throw new Error(`Build failed: ${result.error.message}`);
  return result.value;
}

// =============================================================================
// Phase 1: Schema validation
// =============================================================================

describe('validateBundle: Phase 1 — Schema', () => {
  it('accepts a valid bundle', () => {
    const bundle = buildValidBundle();
    const result = validateBundle(bundle, testSha256);
    expect(result.isOk()).toBe(true);
  });

  it('rejects null input with BUNDLE_INVALID_FORMAT', () => {
    const result = validateBundle(null, testSha256);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('BUNDLE_INVALID_FORMAT');
  });

  it('rejects non-object input with BUNDLE_INVALID_FORMAT', () => {
    const result = validateBundle('not a bundle', testSha256);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('BUNDLE_INVALID_FORMAT');
  });

  it('rejects unsupported version with BUNDLE_UNSUPPORTED_VERSION', () => {
    const bundle = buildValidBundle();
    const tampered = { ...bundle, bundleSchemaVersion: 2 };
    const result = validateBundle(tampered, testSha256);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('BUNDLE_UNSUPPORTED_VERSION');
  });

  it('rejects missing required fields with BUNDLE_INVALID_FORMAT', () => {
    const result = validateBundle({ bundleSchemaVersion: 1 }, testSha256);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('BUNDLE_INVALID_FORMAT');
  });
});

// =============================================================================
// Phase 2: Integrity
// =============================================================================

describe('validateBundle: Phase 2 — Integrity', () => {
  it('passes when integrity digests match', () => {
    const bundle = buildValidBundle();
    const result = validateBundle(bundle, testSha256);
    expect(result.isOk()).toBe(true);
  });

  it('fails with BUNDLE_INTEGRITY_FAILED on tampered events', () => {
    const bundle = buildValidBundle();
    // Tamper with events (add an extra event that changes the digest)
    (bundle.session.events as any[]).push(minimalEvent(1));
    const result = validateBundle(bundle, testSha256);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('BUNDLE_INTEGRITY_FAILED');
  });

  it('fails with BUNDLE_INTEGRITY_FAILED on tampered manifest', () => {
    const bundle = buildValidBundle();
    (bundle.session.manifest as any[]).push(minimalManifestRecord(1));
    const result = validateBundle(bundle, testSha256);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('BUNDLE_INTEGRITY_FAILED');
  });

  it('fails with BUNDLE_INTEGRITY_FAILED on wrong byte count', () => {
    const bundle = buildValidBundle();
    // Tamper with the byte count in integrity entry
    bundle.integrity.entries[0].bytes = 999999;
    const result = validateBundle(bundle, testSha256);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('BUNDLE_INTEGRITY_FAILED');
  });

  it('fails with BUNDLE_INTEGRITY_FAILED on unknown integrity path', () => {
    const bundle = buildValidBundle();
    bundle.integrity.entries.push({
      path: 'session/nonexistent',
      sha256: 'sha256:' + 'f'.repeat(64),
      bytes: 0,
    });
    const result = validateBundle(bundle, testSha256);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('BUNDLE_INTEGRITY_FAILED');
  });
});

// =============================================================================
// Phase 3: Ordering
// =============================================================================

describe('validateBundle: Phase 3 — Ordering', () => {
  it('passes with correctly ordered events', () => {
    const bundle = buildValidBundle({
      events: [minimalEvent(0), minimalEvent(1), minimalEvent(2)] as any,
    });
    const result = validateBundle(bundle, testSha256);
    expect(result.isOk()).toBe(true);
  });

  it('fails with BUNDLE_EVENT_ORDER_INVALID on non-monotonic eventIndex', () => {
    // Build valid bundle first, then tamper with event order
    const bundle = buildValidBundle({
      events: [minimalEvent(0), minimalEvent(1)] as any,
    });
    // Swap events to break ordering (tamper after integrity is computed)
    const evts = bundle.session.events as any[];
    const temp = evts[0];
    evts[0] = evts[1];
    evts[1] = temp;

    // Need to also update integrity to pass phase 2
    // Actually: this test validates that phase 3 catches it.
    // But phase 2 will fail first because events changed.
    // Let me rebuild integrity for the tampered events.
    const rebuiltBundle = buildValidBundle({
      events: [minimalEvent(1), minimalEvent(0)] as any, // out of order
    });
    const result = validateBundle(rebuiltBundle, testSha256);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('BUNDLE_EVENT_ORDER_INVALID');
  });

  it('fails with BUNDLE_MANIFEST_ORDER_INVALID on non-monotonic manifestIndex', () => {
    const rebuiltBundle = buildValidBundle({
      manifest: [minimalManifestRecord(1), minimalManifestRecord(0)] as any,
    });
    const result = validateBundle(rebuiltBundle, testSha256);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('BUNDLE_MANIFEST_ORDER_INVALID');
  });
});

// =============================================================================
// Phase 4: References
// =============================================================================

describe('validateBundle: Phase 4 — References', () => {
  it('fails with BUNDLE_MISSING_SNAPSHOT when referenced snapshot is absent', () => {
    const snapshotRef = 'sha256:' + 'b'.repeat(64);
    const workflowHash = 'sha256:' + 'c'.repeat(64);

    // Create event that references a snapshot
    const nodeCreatedEvent = {
      v: 1,
      eventId: 'evt_nc_001',
      eventIndex: 1,
      sessionId: 'sess_001',
      kind: 'node_created',
      dedupeKey: 'node_created:sess_001:run_001:node_001',
      scope: { runId: 'run_001', nodeId: 'node_001' },
      data: {
        nodeKind: 'step',
        parentNodeId: null,
        workflowHash,
        snapshotRef,
      },
    };

    // Build without the snapshot — should fail reference check
    const rebuiltBundle = buildValidBundle({
      events: [minimalEvent(0), nodeCreatedEvent as any] as any,
      snapshots: new Map(), // missing snapshot
      pinnedWorkflows: new Map([[workflowHash, { compiled: true }]]),
    });

    const result = validateBundle(rebuiltBundle, testSha256);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('BUNDLE_MISSING_SNAPSHOT');
  });

  it('fails with BUNDLE_MISSING_PINNED_WORKFLOW when referenced workflow is absent', () => {
    const workflowHash = 'sha256:' + 'c'.repeat(64);

    // Build a valid bundle with a workflow, then validate a version without it.
    // We test the validator's reference check by using raw JSON (not typed events).
    // The validator treats events as opaque records when scanning for references.
    const bundle = buildValidBundle();
    // Manually inject a run_started event into the already-built bundle's events
    // and rebuild with correct integrity
    const runStartedEvent = {
      v: 1,
      eventId: 'evt_rs_001',
      eventIndex: 1,
      sessionId: 'sess_001',
      kind: 'run_started',
      dedupeKey: 'run_started:sess_001:run_001',
      scope: { runId: 'run_001' },
      data: {
        workflowId: 'test-workflow',
        workflowHash,
        workflowSourceKind: 'user',
        workflowSourceRef: '/path/to/workflow.json',
      },
    };

    // Build with the run_started event but include the workflow
    const bundleWithWf = buildValidBundle({
      events: [minimalEvent(0), runStartedEvent as any] as any,
      pinnedWorkflows: new Map([[workflowHash, { compiled: true }]]),
    });
    // Verify it passes first
    expect(validateBundle(bundleWithWf, testSha256).isOk()).toBe(true);

    // Now build WITHOUT the pinned workflow
    const bundleWithoutWf = buildValidBundle({
      events: [minimalEvent(0), runStartedEvent as any] as any,
      pinnedWorkflows: new Map(),
    });

    const result = validateBundle(bundleWithoutWf, testSha256);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('BUNDLE_MISSING_PINNED_WORKFLOW');
  });

  it('passes when all references are present', () => {
    const snapshotRef = 'sha256:' + 'b'.repeat(64);
    const workflowHash = 'sha256:' + 'c'.repeat(64);

    const nodeCreatedEvent = {
      v: 1,
      eventId: 'evt_nc_001',
      eventIndex: 1,
      sessionId: 'sess_001',
      kind: 'node_created',
      dedupeKey: 'node_created:sess_001:run_001:node_001',
      scope: { runId: 'run_001', nodeId: 'node_001' },
      data: {
        nodeKind: 'step',
        parentNodeId: null,
        workflowHash,
        snapshotRef,
      },
    };

    const bundle = buildValidBundle({
      events: [minimalEvent(0), nodeCreatedEvent as any] as any,
      snapshots: new Map([[snapshotRef, minimalSnapshot() as any]]),
      pinnedWorkflows: new Map([[workflowHash, { compiled: true }]]),
    });

    const result = validateBundle(bundle, testSha256);
    expect(result.isOk()).toBe(true);
  });
});

// =============================================================================
// Roundtrip: build → validate
// =============================================================================

describe('validateBundle: build → validate roundtrip', () => {
  it('bundle built by builder always passes validation', () => {
    const bundle = buildValidBundle();
    const result = validateBundle(bundle, testSha256);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(bundle);
  });

  it('roundtrip through JSON serialization preserves validity', () => {
    const bundle = buildValidBundle();
    const json = JSON.stringify(bundle);
    const parsed = JSON.parse(json);
    const result = validateBundle(parsed, testSha256);
    expect(result.isOk()).toBe(true);
  });

  it('validation phases execute in locked order', () => {
    // A bundle with version 2 AND bad ordering should fail at schema (version),
    // not at ordering
    const bundle = buildValidBundle({
      events: [minimalEvent(1), minimalEvent(0)] as any,
    });
    const tampered = { ...bundle, bundleSchemaVersion: 2 };
    const result = validateBundle(tampered, testSha256);
    expect(result.isErr()).toBe(true);
    // Should fail at Phase 1 (schema/version), not Phase 3 (ordering)
    expect(result._unsafeUnwrapErr().code).toBe('BUNDLE_UNSUPPORTED_VERSION');
  });
});
