import type { Brand } from '../../../runtime/brand.js';

// v2 "branded primitives" (Slice 1 subset)
export type Sha256Digest = Brand<string, 'v2.Sha256Digest'>; // `sha256:<hex>`
export type WorkflowHash = Brand<Sha256Digest, 'v2.WorkflowHash'>;
export type WorkflowId = Brand<string, 'v2.WorkflowId'>;

export type CanonicalBytes = Brand<Uint8Array, 'v2.CanonicalBytes'>;

// v2 session/run truth substrate (Slice 2)
export type SessionId = Brand<string, 'v2.SessionId'>;
export type RunId = Brand<string, 'v2.RunId'>;
export type NodeId = Brand<string, 'v2.NodeId'>;
export type EventId = Brand<string, 'v2.EventId'>;

export type EventIndex = Brand<number, 'v2.EventIndex'>; // 0-based, monotonic, per-session
export type ManifestIndex = Brand<number, 'v2.ManifestIndex'>; // 0-based, monotonic, per-session manifest stream

export type SnapshotRef = Brand<Sha256Digest, 'v2.SnapshotRef'>; // content-addressed snapshot ref (sha256:...)

export function asWorkflowId(value: string): WorkflowId {
  return value as WorkflowId;
}

export function asSha256Digest(value: string): Sha256Digest {
  return value as Sha256Digest;
}

export function asWorkflowHash(value: Sha256Digest): WorkflowHash {
  return value as WorkflowHash;
}

export function asCanonicalBytes(value: Uint8Array): CanonicalBytes {
  return value as CanonicalBytes;
}

export function asSessionId(value: string): SessionId {
  return value as SessionId;
}

export function asRunId(value: string): RunId {
  return value as RunId;
}

export function asNodeId(value: string): NodeId {
  return value as NodeId;
}

export function asEventId(value: string): EventId {
  return value as EventId;
}

export function asEventIndex(value: number): EventIndex {
  return value as EventIndex;
}

export function asManifestIndex(value: number): ManifestIndex {
  return value as ManifestIndex;
}

export function asSnapshotRef(value: Sha256Digest): SnapshotRef {
  return value as SnapshotRef;
}
