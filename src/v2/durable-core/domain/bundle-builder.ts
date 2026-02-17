import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';
import type { DomainEventV1 } from '../schemas/session/events.js';
import type { ManifestRecordV1 } from '../schemas/session/index.js';
import type { ExecutionSnapshotFileV1 } from '../schemas/execution-snapshot/index.js';
import type {
  ExportBundleV1,
  IntegrityEntryV1,
} from '../schemas/export-bundle/index.js';
import type { JsonValue } from '../canonical/json-types.js';
import { toCanonicalBytes } from '../canonical/jcs.js';
import type { Sha256Digest } from '../ids/index.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Inputs for building an export bundle.
 *
 * All data must be pre-loaded by the caller (use case layer handles I/O).
 * This function is pure — no I/O, no side effects.
 */
export interface BuildExportBundleArgs {
  readonly bundleId: string;
  readonly sessionId: string;
  readonly events: readonly DomainEventV1[];
  readonly manifest: readonly ManifestRecordV1[];
  /** Content-addressed snapshots, keyed by snapshotRef string. */
  readonly snapshots: ReadonlyMap<string, ExecutionSnapshotFileV1>;
  /** Pinned compiled workflows, keyed by workflowHash string. */
  readonly pinnedWorkflows: ReadonlyMap<string, unknown>;
  readonly producer: {
    readonly appVersion: string;
    readonly appliedConfigHash?: string;
  };
  /** SHA-256 over canonical bytes — injected for testability. */
  readonly sha256: (bytes: Uint8Array) => Sha256Digest;
}

export type BundleBuilderError =
  | { readonly code: 'BUNDLE_BUILD_EMPTY_EVENTS'; readonly message: string }
  | { readonly code: 'BUNDLE_BUILD_CANONICALIZE_FAILED'; readonly message: string };

// =============================================================================
// Builder
// =============================================================================

/**
 * Build a self-contained export bundle with computed integrity entries.
 *
 * Pure function: same inputs always produce the same bundle.
 * Integrity entries are computed via JCS canonical bytes + SHA-256.
 *
 * Lock: docs/design/v2-core-design-locks.md §1.3
 */
export function buildExportBundle(
  args: BuildExportBundleArgs
): Result<ExportBundleV1, BundleBuilderError> {
  if (args.events.length === 0) {
    return err({
      code: 'BUNDLE_BUILD_EMPTY_EVENTS',
      message: 'Cannot export a session with no events',
    });
  }

  // Build the session contents maps (Record form for schema compatibility)
  const snapshotsRecord: Record<string, ExecutionSnapshotFileV1> = {};
  for (const [ref, snapshot] of args.snapshots) {
    snapshotsRecord[ref] = snapshot;
  }

  const pinnedWorkflowsRecord: Record<string, unknown> = {};
  for (const [hash, compiled] of args.pinnedWorkflows) {
    pinnedWorkflowsRecord[hash] = compiled;
  }

  // Compute integrity entries for each major section
  const integrityResult = computeIntegrityEntries({
    events: args.events as unknown as JsonValue,
    manifest: args.manifest as unknown as JsonValue,
    snapshots: snapshotsRecord,
    pinnedWorkflows: pinnedWorkflowsRecord,
    sha256: args.sha256,
  });

  if (integrityResult.isErr()) return err(integrityResult.error);

  const bundle: ExportBundleV1 = {
    bundleSchemaVersion: 1,
    bundleId: args.bundleId,
    exportedAt: new Date().toISOString(),
    producer: {
      appVersion: args.producer.appVersion,
      ...(args.producer.appliedConfigHash != null
        ? { appliedConfigHash: args.producer.appliedConfigHash }
        : {}),
    },
    integrity: {
      kind: 'sha256_manifest_v1',
      entries: integrityResult.value,
    },
    session: {
      sessionId: args.sessionId,
      events: args.events as DomainEventV1[],
      manifest: args.manifest as ManifestRecordV1[],
      snapshots: snapshotsRecord,
      pinnedWorkflows: pinnedWorkflowsRecord,
    },
  };

  return ok(bundle);
}

// =============================================================================
// Integrity computation (internal)
// =============================================================================

interface IntegrityComputeArgs {
  readonly events: JsonValue;
  readonly manifest: JsonValue;
  readonly snapshots: Record<string, ExecutionSnapshotFileV1>;
  readonly pinnedWorkflows: Record<string, unknown>;
  readonly sha256: (bytes: Uint8Array) => Sha256Digest;
}

/**
 * Compute integrity entries for all major bundle paths.
 *
 * Each entry = { path, sha256: sha256(JCS(value)), bytes: JCS(value).byteLength }
 *
 * Lock: bundle-integrity-jcs-sha256
 */
function computeIntegrityEntries(
  args: IntegrityComputeArgs
): Result<IntegrityEntryV1[], BundleBuilderError> {
  const entries: IntegrityEntryV1[] = [];

  // session/events
  const eventsEntry = computeEntry('session/events', args.events, args.sha256);
  if (eventsEntry.isErr()) return err(eventsEntry.error);
  entries.push(eventsEntry.value);

  // session/manifest
  const manifestEntry = computeEntry('session/manifest', args.manifest, args.sha256);
  if (manifestEntry.isErr()) return err(manifestEntry.error);
  entries.push(manifestEntry.value);

  // session/snapshots/<snapshotRef>
  for (const [ref, snapshot] of Object.entries(args.snapshots)) {
    const entry = computeEntry(
      `session/snapshots/${ref}`,
      snapshot as unknown as JsonValue,
      args.sha256
    );
    if (entry.isErr()) return err(entry.error);
    entries.push(entry.value);
  }

  // session/pinnedWorkflows/<workflowHash>
  for (const [hash, compiled] of Object.entries(args.pinnedWorkflows)) {
    const entry = computeEntry(
      `session/pinnedWorkflows/${hash}`,
      compiled as JsonValue,
      args.sha256
    );
    if (entry.isErr()) return err(entry.error);
    entries.push(entry.value);
  }

  return ok(entries);
}

function computeEntry(
  path: string,
  value: JsonValue,
  sha256: (bytes: Uint8Array) => Sha256Digest
): Result<IntegrityEntryV1, BundleBuilderError> {
  const canonicalResult = toCanonicalBytes(value);
  if (canonicalResult.isErr()) {
    return err({
      code: 'BUNDLE_BUILD_CANONICALIZE_FAILED',
      message: `Failed to canonicalize ${path}: ${canonicalResult.error.message}`,
    });
  }

  const bytes = canonicalResult.value;
  const digest = sha256(bytes);

  return ok({
    path,
    sha256: digest,
    bytes: bytes.byteLength,
  });
}
