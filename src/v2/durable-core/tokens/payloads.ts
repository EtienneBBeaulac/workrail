import { z } from 'zod';
import type { AttemptId, NodeId, RunId, SessionId, TokenStringV1, WorkflowHashRef } from '../ids/index.js';
import { asAttemptId, asNodeId, asRunId, asSessionId, asTokenStringV1, asWorkflowHashRef } from '../ids/index.js';

const workflowHashRefSchema = z
  .string()
  .regex(/^wf_[a-z2-7]{26}$/, 'Expected wf_<26 base32 chars [a-z2-7]>')
  .transform((v) => asWorkflowHashRef(v));

const nonEmpty = z.string().min(1);

// IDs are interpolated into dedupe keys using ':' as a delimiter.
// Keep token IDs delimiter-safe to avoid ambiguity and key collisions.
const delimiterSafeId = nonEmpty.regex(/^[^:\s]+$/, 'Expected a delimiter-safe ID (no ":" or whitespace)');

export type TokenVersionV1 = 1;

/**
 * Closed set: TokenKind (state | ack | checkpoint).
 *
 * Lock: docs/design/v2-core-design-locks.md (Slice 3 tokens)
 *
 * Why closed:
 * - Token kinds determine verification + decoding rules (must be refactor-safe)
 * - Enables exhaustive parsing/validation and prevents “stringly” token kinds
 *
 * Values:
 * - `state`: identifies a durable node state (rehydrate / preconditions)
 * - `ack`: authorizes recording advancement for a specific attemptId
 * - `checkpoint`: authorizes recording a checkpoint for a specific attemptId
 */
export type TokenKindV1 = 'state' | 'ack' | 'checkpoint';

export const AttemptIdSchema = delimiterSafeId.transform(asAttemptId);
export const SessionIdSchema = delimiterSafeId.transform(asSessionId);
export const RunIdSchema = delimiterSafeId.transform(asRunId);
export const NodeIdSchema = delimiterSafeId.transform(asNodeId);

export const StateTokenPayloadV1Schema = z.object({
  tokenVersion: z.literal(1),
  tokenKind: z.literal('state'),
  sessionId: SessionIdSchema,
  runId: RunIdSchema,
  nodeId: NodeIdSchema,
  workflowHashRef: workflowHashRefSchema,
});
export type StateTokenPayloadV1 = z.infer<typeof StateTokenPayloadV1Schema> & {
  readonly tokenVersion: TokenVersionV1;
  readonly tokenKind: 'state';
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly workflowHashRef: WorkflowHashRef;
};

export const AckTokenPayloadV1Schema = z.object({
  tokenVersion: z.literal(1),
  tokenKind: z.literal('ack'),
  sessionId: SessionIdSchema,
  runId: RunIdSchema,
  nodeId: NodeIdSchema,
  attemptId: AttemptIdSchema,
});
export type AckTokenPayloadV1 = z.infer<typeof AckTokenPayloadV1Schema> & {
  readonly tokenVersion: TokenVersionV1;
  readonly tokenKind: 'ack';
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attemptId: AttemptId;
};

export const CheckpointTokenPayloadV1Schema = z.object({
  tokenVersion: z.literal(1),
  tokenKind: z.literal('checkpoint'),
  sessionId: SessionIdSchema,
  runId: RunIdSchema,
  nodeId: NodeIdSchema,
  attemptId: AttemptIdSchema,
});
export type CheckpointTokenPayloadV1 = z.infer<typeof CheckpointTokenPayloadV1Schema> & {
  readonly tokenVersion: TokenVersionV1;
  readonly tokenKind: 'checkpoint';
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attemptId: AttemptId;
};

export const TokenPayloadV1Schema = z.discriminatedUnion('tokenKind', [
  StateTokenPayloadV1Schema,
  AckTokenPayloadV1Schema,
  CheckpointTokenPayloadV1Schema,
]);

export type TokenPayloadV1 = StateTokenPayloadV1 | AckTokenPayloadV1 | CheckpointTokenPayloadV1;

/**
 * Closed set: TokenPrefix (st | ack | chk).
 *
 * Lock: docs/design/v2-core-design-locks.md (token string format)
 *
 * Why closed:
 * - Prevents prefix drift between signing and parsing
 * - Enables deterministic token string format validation
 */
export type TokenPrefixV1 = 'st' | 'ack' | 'chk';
export function expectedPrefixForTokenKind(kind: TokenKindV1): TokenPrefixV1 {
  if (kind === 'state') return 'st';
  if (kind === 'ack') return 'ack';
  return 'chk';
}

export function asTokenString(value: string): TokenStringV1 {
  return asTokenStringV1(value);
}
