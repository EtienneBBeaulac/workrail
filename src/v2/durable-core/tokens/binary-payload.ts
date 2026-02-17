import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';
import type { SessionId, RunId, NodeId, AttemptId, WorkflowHashRef } from '../ids/index.js';
import { asSessionId, asRunId, asNodeId, asAttemptId, asWorkflowHashRef } from '../ids/index.js';
import type { Base32PortV2 } from '../../ports/base32.port.js';
import type { StateTokenPayloadV1, AckTokenPayloadV1, CheckpointTokenPayloadV1 } from './payloads.js';

/**
 * Binary payload serialization for v2 tokens.
 *
 * Lock: docs/design/v2-core-design-locks.md (Binary payload layout)
 *
 * Layout (little-endian, 66 bytes total):
 *   [0]     tokenVersion (uint8, fixed: 1)
 *   [1]     tokenKind (uint8: 0=state, 1=ack, 2=checkpoint)
 *   [2-17]  sessionId (128-bit binary)
 *   [18-33] runId (128-bit binary)
 *   [34-49] nodeId (128-bit binary)
 *   [50-65] workflowHashRef OR attemptId (128-bit binary)
 */

/**
 * Binary payload layout constants (frozen, single source of truth).
 * 
 * LOCKED: These offsets define the wire format and MUST NOT change
 * without versioning (would break determinism and replay).
 * 
 * Why frozen:
 * - Prevents accidental modification at runtime
 * - TypeScript infers literal types (e.g., VERSION: 0, not number)
 * - Serves as executable documentation of binary layout
 * - Eliminates magic numbers throughout codebase
 * 
 * Layout design:
 * - Little-endian (explicit lock in v2-core-design-locks.md)
 * - Fixed 66 bytes (no variable-length fields)
 * - Version and kind at start for fast discrimination
 * - IDs in consistent order (session → run → node → field4)
 */
const STATE_TOKEN_LAYOUT = {
  VERSION: 0,
  KIND: 1,
  SESSION_ID: 2,
  RUN_ID: 18,
  NODE_ID: 34,
  WORKFLOW_HASH_REF: 50,
  TOTAL_SIZE: 66,
} as const;

const ACK_TOKEN_LAYOUT = {
  VERSION: 0,
  KIND: 1,
  SESSION_ID: 2,
  RUN_ID: 18,
  NODE_ID: 34,
  ATTEMPT_ID: 50,
  TOTAL_SIZE: 66,
} as const;

const CHECKPOINT_TOKEN_LAYOUT = {
  VERSION: 0,
  KIND: 1,
  SESSION_ID: 2,
  RUN_ID: 18,
  NODE_ID: 34,
  ATTEMPT_ID: 50,
  TOTAL_SIZE: 66,
} as const;

/**
 * Token kind byte values for binary encoding.
 * 
 * LOCKED: These values are part of the binary format specification
 * and MUST NOT change (would break existing tokens).
 * 
 * Wire format (byte 1 of 66-byte payload):
 * - 0: State token
 * - 1: Ack token
 * - 2: Checkpoint token
 * 
 * See: docs/design/v2-core-design-locks.md Amendment 3
 */
export const TOKEN_KIND_STATE = 0;
export const TOKEN_KIND_ACK = 1;
export const TOKEN_KIND_CHECKPOINT = 2;

/**
 * Type-safe mapping from token kind to byte value.
 * Provides exhaustiveness checking and eliminates magic numbers.
 */
const TOKEN_KIND_BYTES = {
  state: TOKEN_KIND_STATE,
  ack: TOKEN_KIND_ACK,
  checkpoint: TOKEN_KIND_CHECKPOINT,
} as const;

// Structured error types (not string errors)
export type BinaryPackError =
  | { code: 'BINARY_INVALID_ID_FORMAT'; id: string; reason: string }
  | { code: 'BINARY_INVALID_VERSION'; version: number }
  | { code: 'BINARY_INVALID_TOKEN_KIND'; kind: unknown };

export type BinaryUnpackError =
  | { code: 'BINARY_INVALID_LENGTH'; expected: number; actual: number }
  | { code: 'BINARY_UNSUPPORTED_VERSION'; version: number }
  | { code: 'BINARY_UNKNOWN_TOKEN_KIND'; kind: number }
  | { code: 'BINARY_INVALID_ID_BYTES'; field: string };

/**
 * Pack state token payload to deterministic 66-byte binary layout.
 * 
 * INVARIANTS:
 * - Output is always exactly 66 bytes (STATE_TOKEN_LAYOUT.TOTAL_SIZE)
 * - Deterministic: same payload → same bytes (little-endian layout)
 * - Pure function: no side effects, no I/O, no external state mutation
 * - Validation at entry: tokenVersion=1, tokenKind='state'
 * - ID format: <prefix>_<26-char base32> where base32 is [a-z2-7]
 * - Layout matches docs/design/v2-core-design-locks.md Amendment 3
 * 
 * @param payload - State token payload (pre-validated by Zod schema)
 * @param base32 - Base32 encoding port (RFC 4648 lowercase, no padding)
 * @returns 66-byte binary payload or structured error with specific code
 */
export function packStateTokenPayload(
  payload: StateTokenPayloadV1,
  base32: Base32PortV2,
): Result<Uint8Array, BinaryPackError> {
  // Validate before packing
  if (payload.tokenVersion !== 1) {
    return err({ code: 'BINARY_INVALID_VERSION', version: payload.tokenVersion });
  }
  if (payload.tokenKind !== 'state') {
    return err({ code: 'BINARY_INVALID_TOKEN_KIND', kind: payload.tokenKind });
  }

  const buffer = new Uint8Array(STATE_TOKEN_LAYOUT.TOTAL_SIZE);
  buffer[STATE_TOKEN_LAYOUT.VERSION] = payload.tokenVersion;
  buffer[STATE_TOKEN_LAYOUT.KIND] = TOKEN_KIND_BYTES[payload.tokenKind];

  // Pack IDs with validation using type-safe converters
  const sessionBytes = sessionIdToBytes(payload.sessionId, base32);
  if (sessionBytes.isErr()) return sessionBytes;
  buffer.set(sessionBytes.value, STATE_TOKEN_LAYOUT.SESSION_ID);

  const runBytes = runIdToBytes(payload.runId, base32);
  if (runBytes.isErr()) return runBytes;
  buffer.set(runBytes.value, STATE_TOKEN_LAYOUT.RUN_ID);

  const nodeBytes = nodeIdToBytes(payload.nodeId, base32);
  if (nodeBytes.isErr()) return nodeBytes;
  buffer.set(nodeBytes.value, STATE_TOKEN_LAYOUT.NODE_ID);

  const wfRefBytes = workflowHashRefToBytes(payload.workflowHashRef, base32);
  if (wfRefBytes.isErr()) return wfRefBytes;
  buffer.set(wfRefBytes.value, STATE_TOKEN_LAYOUT.WORKFLOW_HASH_REF);

  return ok(buffer);
}

/**
 * Pack ack token payload to deterministic 66-byte binary layout.
 * 
 * INVARIANTS:
 * - Output is always exactly 66 bytes (ACK_TOKEN_LAYOUT.TOTAL_SIZE)
 * - Deterministic: same payload → same bytes (little-endian layout)
 * - Pure function: no side effects, no I/O, no external state mutation
 * - Validation at entry: tokenVersion=1, tokenKind='ack'
 * - ID format: <prefix>_<26-char base32> where base32 is [a-z2-7]
 * - attemptId at bytes [50-65] (differs from state token's workflowHashRef)
 * 
 * @param payload - Ack token payload (pre-validated by Zod schema)
 * @param base32 - Base32 encoding port (RFC 4648 lowercase, no padding)
 * @returns 66-byte binary payload or structured error with specific code
 */
export function packAckTokenPayload(
  payload: AckTokenPayloadV1,
  base32: Base32PortV2,
): Result<Uint8Array, BinaryPackError> {
  if (payload.tokenVersion !== 1) {
    return err({ code: 'BINARY_INVALID_VERSION', version: payload.tokenVersion });
  }
  if (payload.tokenKind !== 'ack') {
    return err({ code: 'BINARY_INVALID_TOKEN_KIND', kind: payload.tokenKind });
  }

  const buffer = new Uint8Array(ACK_TOKEN_LAYOUT.TOTAL_SIZE);
  buffer[ACK_TOKEN_LAYOUT.VERSION] = payload.tokenVersion;
  buffer[ACK_TOKEN_LAYOUT.KIND] = TOKEN_KIND_BYTES[payload.tokenKind];

  const sessionBytes = sessionIdToBytes(payload.sessionId, base32);
  if (sessionBytes.isErr()) return sessionBytes;
  buffer.set(sessionBytes.value, ACK_TOKEN_LAYOUT.SESSION_ID);

  const runBytes = runIdToBytes(payload.runId, base32);
  if (runBytes.isErr()) return runBytes;
  buffer.set(runBytes.value, ACK_TOKEN_LAYOUT.RUN_ID);

  const nodeBytes = nodeIdToBytes(payload.nodeId, base32);
  if (nodeBytes.isErr()) return nodeBytes;
  buffer.set(nodeBytes.value, ACK_TOKEN_LAYOUT.NODE_ID);

  const attemptBytes = attemptIdToBytes(payload.attemptId, base32);
  if (attemptBytes.isErr()) return attemptBytes;
  buffer.set(attemptBytes.value, ACK_TOKEN_LAYOUT.ATTEMPT_ID);

  return ok(buffer);
}

/**
 * Pack checkpoint token payload to deterministic 66-byte binary layout.
 * 
 * INVARIANTS:
 * - Output is always exactly 66 bytes (CHECKPOINT_TOKEN_LAYOUT.TOTAL_SIZE)
 * - Deterministic: same payload → same bytes (little-endian layout)
 * - Pure function: no side effects, no I/O, no external state mutation
 * - Validation at entry: tokenVersion=1, tokenKind='checkpoint'
 * - Layout identical to ack token (both use attemptId at bytes [50-65])
 * - ID format: <prefix>_<26-char base32> where base32 is [a-z2-7]
 * 
 * @param payload - Checkpoint token payload (pre-validated by Zod schema)
 * @param base32 - Base32 encoding port (RFC 4648 lowercase, no padding)
 * @returns 66-byte binary payload or structured error with specific code
 */
export function packCheckpointTokenPayload(
  payload: CheckpointTokenPayloadV1,
  base32: Base32PortV2,
): Result<Uint8Array, BinaryPackError> {
  if (payload.tokenVersion !== 1) {
    return err({ code: 'BINARY_INVALID_VERSION', version: payload.tokenVersion });
  }
  if (payload.tokenKind !== 'checkpoint') {
    return err({ code: 'BINARY_INVALID_TOKEN_KIND', kind: payload.tokenKind });
  }

  const buffer = new Uint8Array(CHECKPOINT_TOKEN_LAYOUT.TOTAL_SIZE);
  buffer[CHECKPOINT_TOKEN_LAYOUT.VERSION] = payload.tokenVersion;
  buffer[CHECKPOINT_TOKEN_LAYOUT.KIND] = TOKEN_KIND_BYTES[payload.tokenKind];

  const sessionBytes = sessionIdToBytes(payload.sessionId, base32);
  if (sessionBytes.isErr()) return sessionBytes;
  buffer.set(sessionBytes.value, CHECKPOINT_TOKEN_LAYOUT.SESSION_ID);

  const runBytes = runIdToBytes(payload.runId, base32);
  if (runBytes.isErr()) return runBytes;
  buffer.set(runBytes.value, CHECKPOINT_TOKEN_LAYOUT.RUN_ID);

  const nodeBytes = nodeIdToBytes(payload.nodeId, base32);
  if (nodeBytes.isErr()) return nodeBytes;
  buffer.set(nodeBytes.value, CHECKPOINT_TOKEN_LAYOUT.NODE_ID);

  const attemptBytes = attemptIdToBytes(payload.attemptId, base32);
  if (attemptBytes.isErr()) return attemptBytes;
  buffer.set(attemptBytes.value, CHECKPOINT_TOKEN_LAYOUT.ATTEMPT_ID);

  return ok(buffer);
}

/**
 * Unpack binary token payload to typed payload object.
 * 
 * INVARIANTS:
 * - Input must be exactly 66 bytes (validated at entry)
 * - tokenVersion must be 1 (fail fast on unsupported version)
 * - tokenKind determines which fields are present (0=state, 1=ack, 2=checkpoint)
 * - Pure function: no side effects, only data transformation
 * - Returns discriminated union: StateTokenPayloadV1 | AckTokenPayloadV1 | CheckpointTokenPayloadV1
 * - Does NOT validate signature (caller's responsibility)
 * - Does NOT validate IDs match expected patterns (assumes binary is valid)
 * 
 * @param bytes - Exactly 66 bytes from token (payload portion only, no signature)
 * @param base32 - Base32 decoder for converting binary IDs to string format
 * @returns Typed payload object or structured error with specific code
 */
export function unpackTokenPayload(
  bytes: Uint8Array,
  base32: Base32PortV2,
): Result<StateTokenPayloadV1 | AckTokenPayloadV1 | CheckpointTokenPayloadV1, BinaryUnpackError> {
  if (bytes.length !== 66) {
    return err({ code: 'BINARY_INVALID_LENGTH', expected: 66, actual: bytes.length });
  }

  const tokenVersion = bytes[0];
  const tokenKind = bytes[1];

  if (tokenVersion !== 1) {
    return err({ code: 'BINARY_UNSUPPORTED_VERSION', version: tokenVersion });
  }

  let offset = 2;
  const sessionIdRes = bytesToSessionId(bytes.slice(offset, offset + 16), base32);
  if (sessionIdRes.isErr()) return err(sessionIdRes.error);
  const sessionId = sessionIdRes.value;
  offset += 16;
  
  const runIdRes = bytesToRunId(bytes.slice(offset, offset + 16), base32);
  if (runIdRes.isErr()) return err(runIdRes.error);
  const runId = runIdRes.value;
  offset += 16;
  
  const nodeIdRes = bytesToNodeId(bytes.slice(offset, offset + 16), base32);
  if (nodeIdRes.isErr()) return err(nodeIdRes.error);
  const nodeId = nodeIdRes.value;
  offset += 16;
  
  const field4 = bytes.slice(offset, offset + 16); // workflowHashRef or attemptId

  switch (tokenKind) {
    case TOKEN_KIND_STATE: {
      const wfRefRes = bytesToWorkflowHashRef(field4, base32);
      if (wfRefRes.isErr()) return err(wfRefRes.error);
      return ok({
        tokenVersion: 1,
        tokenKind: 'state',
        sessionId,
        runId,
        nodeId,
        workflowHashRef: wfRefRes.value,
      });
    }

    case TOKEN_KIND_ACK: {
      const attemptIdRes = bytesToAttemptId(field4, base32);
      if (attemptIdRes.isErr()) return err(attemptIdRes.error);
      return ok({
        tokenVersion: 1,
        tokenKind: 'ack',
        sessionId,
        runId,
        nodeId,
        attemptId: attemptIdRes.value,
      });
    }

    case TOKEN_KIND_CHECKPOINT: {
      const attemptIdRes = bytesToAttemptId(field4, base32);
      if (attemptIdRes.isErr()) return err(attemptIdRes.error);
      return ok({
        tokenVersion: 1,
        tokenKind: 'checkpoint',
        sessionId,
        runId,
        nodeId,
        attemptId: attemptIdRes.value,
      });
    }

    default:
      // Unknown token kind (should never happen given binary validation)
      return err({ code: 'BINARY_UNKNOWN_TOKEN_KIND', kind: tokenKind });
  }
}

// ============================================================================
// Helper functions (with validation and structured errors)
// ============================================================================

function idStringToBytesOrFail(
  id: string,
  expectedPrefix: string,
  base32: Base32PortV2,
): Result<Uint8Array, BinaryPackError> {
  const parts = id.split('_');
  if (parts.length !== 2) {
    return err({
      code: 'BINARY_INVALID_ID_FORMAT',
      id,
      reason: 'Expected format: <prefix>_<base32>',
    });
  }

  const [prefix, suffix] = parts as [string, string];

  // Validate expected prefix
  if (prefix !== expectedPrefix) {
    return err({
      code: 'BINARY_INVALID_ID_FORMAT',
      id,
      reason: `Expected prefix '${expectedPrefix}_', got '${prefix}_'`,
    });
  }

  // Validate base32 format before decoding
  if (!/^[a-z2-7]{26}$/.test(suffix)) {
    return err({
      code: 'BINARY_INVALID_ID_FORMAT',
      id,
      reason: 'ID suffix must be 26 base32 chars [a-z2-7]',
    });
  }

  const decoded = base32.decode(suffix);
  if (decoded.isErr()) {
    return err({
      code: 'BINARY_INVALID_ID_FORMAT',
      id,
      reason: `Base32 decode failed: ${decoded.error.code}`,
    });
  }

  if (decoded.value.length !== 16) {
    return err({
      code: 'BINARY_INVALID_ID_FORMAT',
      id,
      reason: `Decoded to ${decoded.value.length} bytes, expected 16`,
    });
  }

  return ok(decoded.value);
}

function idBytesToString(bytes: Uint8Array, prefix: string, base32: Base32PortV2): Result<string, BinaryUnpackError> {
  if (bytes.length !== 16) {
    return err({
      code: 'BINARY_INVALID_ID_BYTES',
      field: prefix,
    });
  }
  const suffix = base32.encode(bytes);
  return ok(`${prefix}_${suffix}`);
}

// NOTE: workflowHashRef is carried as a base32 string ID (`wf_<26 chars>`), decoded to 16 bytes for packing.

// ============================================================================
// Helper functions (with validation and structured errors)
// ============================================================================
//
// Type-safe ID conversions:
// - Each ID type has dedicated converter (sessionIdToBytes, runIdToBytes, etc.)
// - Prevents mixing up IDs at compile time (SessionId ≠ RunId via branded types)
// - Validates prefix matches expected value (e.g., 'sess_' for SessionId)
// - Returns Result types (no exceptions thrown)
//
// Naming convention:
// - <Type>ToBytes(): string ID → 16-byte binary
// - bytesTo<Type>(): 16-byte binary → string ID
// - OrFail suffix: validates ID format before conversion
//

function sessionIdToBytes(id: SessionId, base32: Base32PortV2): Result<Uint8Array, BinaryPackError> {
  return idStringToBytesOrFail(String(id), 'sess', base32);
}

function bytesToSessionId(bytes: Uint8Array, base32: Base32PortV2): Result<SessionId, BinaryUnpackError> {
  return idBytesToString(bytes, 'sess', base32).map(id => asSessionId(id));
}

function runIdToBytes(id: RunId, base32: Base32PortV2): Result<Uint8Array, BinaryPackError> {
  return idStringToBytesOrFail(String(id), 'run', base32);
}

function bytesToRunId(bytes: Uint8Array, base32: Base32PortV2): Result<RunId, BinaryUnpackError> {
  return idBytesToString(bytes, 'run', base32).map(id => asRunId(id));
}

function nodeIdToBytes(id: NodeId, base32: Base32PortV2): Result<Uint8Array, BinaryPackError> {
  return idStringToBytesOrFail(String(id), 'node', base32);
}

function bytesToNodeId(bytes: Uint8Array, base32: Base32PortV2): Result<NodeId, BinaryUnpackError> {
  return idBytesToString(bytes, 'node', base32).map(id => asNodeId(id));
}

function attemptIdToBytes(id: AttemptId, base32: Base32PortV2): Result<Uint8Array, BinaryPackError> {
  return idStringToBytesOrFail(String(id), 'attempt', base32);
}

function bytesToAttemptId(bytes: Uint8Array, base32: Base32PortV2): Result<AttemptId, BinaryUnpackError> {
  return idBytesToString(bytes, 'attempt', base32).map(id => asAttemptId(id));
}

function workflowHashRefToBytes(hashRef: WorkflowHashRef, base32: Base32PortV2): Result<Uint8Array, BinaryPackError> {
  return idStringToBytesOrFail(String(hashRef), 'wf', base32);
}

function bytesToWorkflowHashRef(bytes: Uint8Array, base32: Base32PortV2): Result<WorkflowHashRef, BinaryUnpackError> {
  return idBytesToString(bytes, 'wf', base32).map(id => asWorkflowHashRef(id));
}
