import type { Brand } from '../../../runtime/brand.js';

// v2 "branded primitives" (Slice 1 subset)
export type Sha256Digest = Brand<string, 'v2.Sha256Digest'>; // `sha256:<hex>`
export type WorkflowHash = Brand<Sha256Digest, 'v2.WorkflowHash'>;
export type WorkflowId = Brand<string, 'v2.WorkflowId'>;

export type CanonicalBytes = Brand<Uint8Array, 'v2.CanonicalBytes'>;

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
