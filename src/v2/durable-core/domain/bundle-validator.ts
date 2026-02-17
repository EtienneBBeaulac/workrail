import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';
import {
  ExportBundleV1Schema,
  type ExportBundleV1,
  type BundleImportError,
  type BundleImportErrorCode,
} from '../schemas/export-bundle/index.js';
import type { JsonValue } from '../canonical/json-types.js';
import { toCanonicalBytes } from '../canonical/jcs.js';
import type { Sha256Digest } from '../ids/index.js';
import { EVENT_KIND } from '../constants.js';

// =============================================================================
// Validator
// =============================================================================

/**
 * Validate an export bundle through the locked 4-phase validation pipeline.
 *
 * Phase order (locked in §1.3):
 *   1. Schema — structural + version check
 *   2. Integrity — JCS + SHA-256 digest verification
 *   3. Ordering — eventIndex and manifestIndex monotonicity
 *   4. References — snapshot and pinned workflow completeness
 *
 * Pure function: no I/O. Only after this returns Ok should callers perform writes.
 *
 * Lock: bundle-import-validates-first
 */
export function validateBundle(
  raw: unknown,
  sha256: (bytes: Uint8Array) => Sha256Digest
): Result<ExportBundleV1, BundleImportError> {
  // Phase 1: Schema validation
  const schemaResult = validateSchema(raw);
  if (schemaResult.isErr()) return schemaResult;
  const bundle = schemaResult.value;

  // Phase 2: Integrity verification
  const integrityResult = validateIntegrity(bundle, sha256);
  if (integrityResult.isErr()) return err(integrityResult.error);

  // Phase 3: Ordering validation
  const orderingResult = validateOrdering(bundle);
  if (orderingResult.isErr()) return err(orderingResult.error);

  // Phase 4: Reference completeness
  const referencesResult = validateReferences(bundle);
  if (referencesResult.isErr()) return err(referencesResult.error);

  return ok(bundle);
}

// =============================================================================
// Phase 1: Schema
// =============================================================================

function validateSchema(raw: unknown): Result<ExportBundleV1, BundleImportError> {
  // Version check first (fail fast with specific code)
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'bundleSchemaVersion' in raw &&
    (raw as Record<string, unknown>).bundleSchemaVersion !== 1
  ) {
    return err(importError(
      'BUNDLE_UNSUPPORTED_VERSION',
      `Unsupported bundle schema version: ${String((raw as Record<string, unknown>).bundleSchemaVersion)}. Expected 1.`,
    ));
  }

  const parsed = ExportBundleV1Schema.safeParse(raw);
  if (!parsed.success) {
    return err(importError(
      'BUNDLE_INVALID_FORMAT',
      `Bundle schema validation failed: ${parsed.error.issues.map(i => i.message).join('; ')}`,
    ));
  }

  return ok(parsed.data);
}

// =============================================================================
// Phase 2: Integrity
// =============================================================================

function validateIntegrity(
  bundle: ExportBundleV1,
  sha256: (bytes: Uint8Array) => Sha256Digest
): Result<void, BundleImportError> {
  for (const entry of bundle.integrity.entries) {
    const value = resolveIntegrityPath(bundle, entry.path);
    if (value === undefined) {
      return err(importError(
        'BUNDLE_INTEGRITY_FAILED',
        `Integrity path not found in bundle: ${entry.path}`,
      ));
    }

    const canonicalResult = toCanonicalBytes(value as JsonValue);
    if (canonicalResult.isErr()) {
      return err(importError(
        'BUNDLE_INTEGRITY_FAILED',
        `Failed to canonicalize ${entry.path}: ${canonicalResult.error.message}`,
      ));
    }

    const bytes = canonicalResult.value;
    const computedDigest = sha256(bytes);

    if (computedDigest !== entry.sha256) {
      return err(importError(
        'BUNDLE_INTEGRITY_FAILED',
        `Integrity mismatch for ${entry.path}: expected ${entry.sha256}, got ${computedDigest}`,
      ));
    }

    if (bytes.byteLength !== entry.bytes) {
      return err(importError(
        'BUNDLE_INTEGRITY_FAILED',
        `Byte length mismatch for ${entry.path}: expected ${String(entry.bytes)}, got ${String(bytes.byteLength)}`,
      ));
    }
  }

  return ok(undefined);
}

/**
 * Resolve a dotted path within the bundle to its value.
 *
 * Supports:
 *   - "session/events" → bundle.session.events
 *   - "session/manifest" → bundle.session.manifest
 *   - "session/snapshots/<ref>" → bundle.session.snapshots[ref]
 *   - "session/pinnedWorkflows/<hash>" → bundle.session.pinnedWorkflows[hash]
 */
function resolveIntegrityPath(bundle: ExportBundleV1, path: string): unknown | undefined {
  if (path === 'session/events') return bundle.session.events;
  if (path === 'session/manifest') return bundle.session.manifest;

  const snapshotPrefix = 'session/snapshots/';
  if (path.startsWith(snapshotPrefix)) {
    const ref = path.slice(snapshotPrefix.length);
    return bundle.session.snapshots[ref];
  }

  const workflowPrefix = 'session/pinnedWorkflows/';
  if (path.startsWith(workflowPrefix)) {
    const hash = path.slice(workflowPrefix.length);
    return bundle.session.pinnedWorkflows[hash];
  }

  return undefined;
}

// =============================================================================
// Phase 3: Ordering
// =============================================================================

function validateOrdering(bundle: ExportBundleV1): Result<void, BundleImportError> {
  // Event ordering: eventIndex must be strictly monotonic (ascending)
  const events = bundle.session.events;
  for (let i = 1; i < events.length; i++) {
    const prev = (events[i - 1] as unknown as { eventIndex: number }).eventIndex;
    const curr = (events[i] as unknown as { eventIndex: number }).eventIndex;
    if (curr <= prev) {
      return err(importError(
        'BUNDLE_EVENT_ORDER_INVALID',
        `Events not in ascending eventIndex order: index ${String(i)} has eventIndex ${String(curr)} ≤ previous ${String(prev)}`,
      ));
    }
  }

  // Manifest ordering: manifestIndex must be strictly monotonic (ascending)
  const manifest = bundle.session.manifest;
  for (let i = 1; i < manifest.length; i++) {
    const prev = (manifest[i - 1] as unknown as { manifestIndex: number }).manifestIndex;
    const curr = (manifest[i] as unknown as { manifestIndex: number }).manifestIndex;
    if (curr <= prev) {
      return err(importError(
        'BUNDLE_MANIFEST_ORDER_INVALID',
        `Manifest records not in ascending manifestIndex order: index ${String(i)} has manifestIndex ${String(curr)} ≤ previous ${String(prev)}`,
      ));
    }
  }

  return ok(undefined);
}

// =============================================================================
// Phase 4: References
// =============================================================================

function validateReferences(bundle: ExportBundleV1): Result<void, BundleImportError> {
  // Collect all snapshotRefs referenced by advance_recorded events
  const referencedSnapshots = new Set<string>();
  const referencedWorkflows = new Set<string>();

  for (const event of bundle.session.events) {
    const evt = event as unknown as { kind: string; data: Record<string, unknown> };

    // node_created events reference both snapshotRef and workflowHash
    if (evt.kind === EVENT_KIND.NODE_CREATED) {
      if (typeof evt.data.snapshotRef === 'string') {
        referencedSnapshots.add(evt.data.snapshotRef);
      }
      if (typeof evt.data.workflowHash === 'string') {
        referencedWorkflows.add(evt.data.workflowHash);
      }
    }

    // run_started events reference workflowHash
    if (evt.kind === EVENT_KIND.RUN_STARTED && typeof evt.data.workflowHash === 'string') {
      referencedWorkflows.add(evt.data.workflowHash);
    }
  }

  // Every referenced snapshotRef must exist in bundle.session.snapshots
  for (const ref of referencedSnapshots) {
    if (!(ref in bundle.session.snapshots)) {
      return err(importError(
        'BUNDLE_MISSING_SNAPSHOT',
        `Referenced snapshotRef not found in bundle: ${ref}`,
        { missingRef: ref },
      ));
    }
  }

  // Every referenced workflowHash must exist in bundle.session.pinnedWorkflows
  for (const hash of referencedWorkflows) {
    if (!(hash in bundle.session.pinnedWorkflows)) {
      return err(importError(
        'BUNDLE_MISSING_PINNED_WORKFLOW',
        `Referenced workflowHash not found in bundle: ${hash}`,
        { missingHash: hash },
      ));
    }
  }

  return ok(undefined);
}

// =============================================================================
// Error helper
// =============================================================================

function importError(
  code: BundleImportErrorCode,
  message: string,
  details?: Record<string, unknown>
): BundleImportError {
  return {
    code,
    message,
    retry: 'no',
    ...(details != null ? { details } : {}),
  };
}
