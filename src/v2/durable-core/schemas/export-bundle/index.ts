/**
 * Export bundle schema (v1, locked)
 *
 * Lock: docs/design/v2-core-design-locks.md §1.3 (Export/import bundle)
 *
 * This schema defines the versioned envelope for exporting and importing
 * WorkRail v2 durable truth across machines. Bundles are JSON artifacts
 * that contain session events, manifest records, snapshots, and workflow
 * definitions required for deterministic resumption.
 *
 * Key invariants:
 * - Tokens (stateToken, ackToken) are NOT included (re-minted on import)
 * - Integrity uses JCS canonical bytes + SHA-256
 * - Import validates integrity and ordering before storing
 * - Import defaults to import-as-new on session ID collision
 * - Bundle import errors form a closed set (7 codes)
 */

import { z } from 'zod';
import { SHA256_DIGEST_PATTERN } from '../../constants.js';
import { ExecutionSnapshotFileV1Schema } from '../execution-snapshot/index.js';
import { DomainEventV1Schema } from '../session/events.js';
import { ManifestRecordV1Schema } from '../session/index.js';

// =============================================================================
// SHA-256 Digest Schema (shared with other v2 schemas)
// =============================================================================

/**
 * SHA-256 digest in canonical format: sha256:<64 lowercase hex>
 *
 * Lock: hash-format-sha256-hex (docs/design/v2-core-design-locks.md §11)
 */
const Sha256DigestSchema = z
  .string()
  .regex(SHA256_DIGEST_PATTERN, 'Expected sha256:<64 hex chars>')
  .describe('SHA-256 digest in format sha256:<64 lowercase hex>');

// =============================================================================
// Bundle Integrity Schema
// =============================================================================

/**
 * A single integrity manifest entry for one artifact in the bundle.
 *
 * Each entry includes:
 * - path: the location within the bundle (e.g., "session/events")
 * - sha256: JCS canonical JSON hash of the value at that path
 * - bytes: byte length of the JCS canonical UTF-8 serialization
 *
 * Lock: bundle-integrity-jcs-sha256
 */
export const IntegrityEntryV1Schema = z.object({
  path: z.string().min(1).describe('Location within bundle (e.g., "session/events")'),
  sha256: Sha256DigestSchema.describe('JCS canonical JSON + SHA-256'),
  bytes: z.number().int().nonnegative().describe('Byte length of JCS canonical UTF-8'),
});

export type IntegrityEntryV1 = z.infer<typeof IntegrityEntryV1Schema>;

/**
 * Integrity manifest for fast corruption detection.
 *
 * Kind must be fixed to "sha256_manifest_v1" (future versions will introduce
 * new integrity kinds as needed).
 *
 * Lock: bundle-integrity-jcs-sha256, bundle-format-single-json
 */
export const IntegrityManifestV1Schema = z.object({
  kind: z.literal('sha256_manifest_v1').describe('Integrity scheme identifier'),
  entries: z
    .array(IntegrityEntryV1Schema)
    .min(1)
    .describe('Integrity entries for each major artifact path'),
});

export type IntegrityManifestV1 = z.infer<typeof IntegrityManifestV1Schema>;

// =============================================================================
// Producer Information
// =============================================================================

/**
 * Informational producer metadata (not used for ordering or behavior decisions).
 *
 * Lock: bundle-format-single-json (docs/design/v2-core-design-locks.md §1.3)
 */
export const ProducerInfoV1Schema = z.object({
  appVersion: z.string().min(1).describe('Application version that produced the bundle'),
  appliedConfigHash: Sha256DigestSchema.optional().describe('Optional: hash of applied config'),
});

export type ProducerInfoV1 = z.infer<typeof ProducerInfoV1Schema>;

// =============================================================================
// Session Contents
// =============================================================================

/**
 * Snapshots embedded in the bundle, keyed by content-addressed SnapshotRef.
 *
 * Lock: bundle-format-single-json, snapshot-content-addressed
 */
const SnapshotsMapV1Schema = z
  .record(
    z.string().min(1).describe('SnapshotRef (sha256:<digest>)'),
    ExecutionSnapshotFileV1Schema
  )
  .describe('Content-addressed snapshot storage');

/**
 * Pinned workflows embedded in the bundle, keyed by workflowHash.
 *
 * These are compiled workflow snapshots required for deterministic resume
 * (e.g., exact step definitions and flow structure that produced the nodes).
 *
 * Lock: bundle-format-single-json
 */
const PinnedWorkflowsMapV1Schema = z
  .record(
    z.string().min(1).describe('WorkflowHash (sha256:<digest>)'),
    z.unknown().describe('CompiledWorkflowV1 or equivalent snapshot')
  )
  .describe('Pinned workflow definitions by hash');

/**
 * Session contents within the bundle.
 *
 * Lock: bundle-format-single-json, bundle-tokens-not-portable
 *
 * Note: Tokens (stateToken, ackToken) are explicitly NOT included.
 * On import, WorkRail re-mints fresh runtime tokens from the stored nodes
 * and snapshots.
 */
export const SessionContentsV1Schema = z.object({
  sessionId: z.string().min(1).describe('Stable session identifier'),
  events: z
    .array(DomainEventV1Schema)
    .describe('Ordered session events by ascending eventIndex'),
  manifest: z
    .array(ManifestRecordV1Schema)
    .describe('Ordered manifest records by ascending manifestIndex'),
  snapshots: SnapshotsMapV1Schema.describe('Content-addressed snapshot CAS'),
  pinnedWorkflows: PinnedWorkflowsMapV1Schema.describe('Pinned workflow definitions'),
});

export type SessionContentsV1 = z.infer<typeof SessionContentsV1Schema>;

// =============================================================================
// Export Bundle Envelope (v1, locked)
// =============================================================================

/**
 * ExportBundleV1Schema: versioned JSON envelope for durable truth export/import.
 *
 * Locks:
 * - bundle-format-single-json: Single JSON bundle with versioned envelope
 * - bundle-tokens-not-portable: No tokens in bundle; re-minted on import
 * - bundle-integrity-jcs-sha256: Integrity uses JCS + SHA-256
 * - bundle-import-as-new: Import defaults to import-as-new on collision
 * - bundle-import-validates-first: Validation must happen before storing
 * - bundle-errors-closed-set: Import errors form a closed set (see below)
 *
 * Lock: schema-versioned, schema-additive-within-version
 */
export const ExportBundleV1Schema = z.object({
  bundleSchemaVersion: z.literal(1).describe('Bundle format version (1)'),
  bundleId: z.string().min(1).describe('Stable bundle identifier'),
  exportedAt: z.string().datetime().describe('ISO 8601 timestamp (informational only)'),
  producer: ProducerInfoV1Schema.describe('Informational producer metadata'),
  integrity: IntegrityManifestV1Schema.describe('Corruption detection manifest'),
  session: SessionContentsV1Schema.describe('Session durable truth'),
});

export type ExportBundleV1 = z.infer<typeof ExportBundleV1Schema>;

// =============================================================================
// Bundle Import Error Codes (closed set, locked)
// =============================================================================

/**
 * Bundle import error codes (initial closed set).
 *
 * Lock: bundle-errors-closed-set (docs/design/v2-core-design-locks.md §1.3)
 *
 * These errors are exhaustive; no new codes without updating the lock.
 * Used by import validation to communicate pre-store integrity failures.
 */
export const BundleImportErrorCodeSchema = z.enum([
  'BUNDLE_INVALID_FORMAT', // Schema validation failed (not valid JSON or missing required fields)
  'BUNDLE_UNSUPPORTED_VERSION', // bundleSchemaVersion > 1 (unknown future version)
  'BUNDLE_INTEGRITY_FAILED', // Integrity check mismatch
  'BUNDLE_MISSING_SNAPSHOT', // Referenced snapshotRef not found in bundle
  'BUNDLE_MISSING_PINNED_WORKFLOW', // Referenced workflowHash not found in bundle
  'BUNDLE_EVENT_ORDER_INVALID', // Events not in ascending eventIndex order
  'BUNDLE_MANIFEST_ORDER_INVALID', // Manifest records not in ascending manifestIndex order
]);

export type BundleImportErrorCode = z.infer<typeof BundleImportErrorCodeSchema>;

/**
 * Bundle import error result type.
 *
 * Structured error envelope for import operations (errors as data).
 * Lock: error-envelope-shape, error-no-throw-across-mcp
 */
export const BundleImportErrorSchema = z.object({
  code: BundleImportErrorCodeSchema,
  message: z.string().min(1).describe('Human-readable error message'),
  retry: z.enum(['yes', 'no']).describe('Whether caller should retry'),
  details: z.record(z.unknown()).optional().describe('Additional debugging context'),
});

export type BundleImportError = z.infer<typeof BundleImportErrorSchema>;

export { ExecutionSnapshotFileV1Schema } from '../execution-snapshot/index.js';
export { DomainEventV1Schema } from '../session/events.js';
export { ManifestRecordV1Schema } from '../session/index.js';
