// Barrel file: re-exports all ID types and functions
// Brand utility type
export type { Brand } from '../../../runtime/brand.js';

// Session execution IDs
export type { SessionId, RunId, NodeId, AttemptId } from './session-ids.js';
export { asSessionId, asRunId, asNodeId, asAttemptId } from './session-ids.js';

// Workflow identity IDs
export type {
  WorkflowId,
  Sha256Digest,
  WorkflowHash,
  WorkflowHashRef,
} from './workflow-ids.js';
export {
  asWorkflowId,
  asSha256Digest,
  asWorkflowHash,
  asWorkflowHashRef,
  deriveWorkflowHashRef,
} from './workflow-ids.js';
export type { WorkflowHashRefError } from './workflow-ids.js';

// Event log IDs
export type { EventId, EventIndex, ManifestIndex, OutputId } from './event-ids.js';
export { asEventId, asEventIndex, asManifestIndex, asOutputId } from './event-ids.js';

// Snapshot/canonical IDs
export type { SnapshotRef, CanonicalBytes } from './snapshot-ids.js';
export { asSnapshotRef, asCanonicalBytes } from './snapshot-ids.js';

// Token string IDs
export type { TokenStringV1 } from './token-ids.js';
export { asTokenStringV1 } from './token-ids.js';

// Witness type (kept in index for now as it may be used across domains)
export type { WithHealthySessionLock } from './with-healthy-session-lock.js';
