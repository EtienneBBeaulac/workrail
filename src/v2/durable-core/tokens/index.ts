export {
  TokenPayloadV1Schema,
  StateTokenPayloadV1Schema,
  AckTokenPayloadV1Schema,
  CheckpointTokenPayloadV1Schema,
  expectedPrefixForTokenKind,
} from './payloads.js';

export type { TokenPayloadV1, StateTokenPayloadV1, AckTokenPayloadV1, CheckpointTokenPayloadV1 } from './payloads.js';

// Binary encoding
export { encodeTokenPayloadV1Binary, parseTokenV1Binary } from './token-codec.js';
export type { TokenDecodeErrorV2, ParsedTokenV1Binary } from './token-codec.js';

// Binary payload serialization
export {
  packStateTokenPayload,
  packAckTokenPayload,
  packCheckpointTokenPayload,
  unpackTokenPayload,
  TOKEN_KIND_STATE,
  TOKEN_KIND_ACK,
  TOKEN_KIND_CHECKPOINT,
} from './binary-payload.js';
export type { BinaryPackError, BinaryUnpackError } from './binary-payload.js';

// Binary signing
export {
  signTokenV1Binary,
  verifyTokenSignatureV1Binary,
  assertTokenScopeMatchesStateBinary,
} from './token-signer.js';
export type { TokenSignErrorV2, TokenVerifyErrorV2 } from './token-signer.js';

// Re-export branded id types for convenient access
export type { AttemptId, OutputId } from '../ids/index.js';
export { asAttemptId, asOutputId } from '../ids/index.js';
