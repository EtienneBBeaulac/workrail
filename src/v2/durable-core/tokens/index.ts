export {
  TokenPayloadV1Schema,
  StateTokenPayloadV1Schema,
  AckTokenPayloadV1Schema,
  CheckpointTokenPayloadV1Schema,
  expectedPrefixForTokenKind,
} from './payloads.js';

export type { TokenPayloadV1, StateTokenPayloadV1, AckTokenPayloadV1, CheckpointTokenPayloadV1 } from './payloads.js';

// JCS-based encoding (legacy, being replaced)
export { encodeTokenPayloadV1, encodeUnsignedTokenV1, parseTokenV1 } from './token-codec.js';
export type { TokenDecodeErrorV2, ParsedTokenV1 } from './token-codec.js';

// Binary encoding (Direction B: Binary + Bech32m)
export { encodeTokenPayloadV1Binary, parseTokenV1Binary } from './token-codec.js';
export type { ParsedTokenV1Binary } from './token-codec.js';

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

// JCS-based signing (legacy, being replaced)
export { signTokenV1, verifyTokenSignatureV1, assertTokenScopeMatchesState } from './token-signer.js';
export type { TokenVerifyErrorV2 } from './token-signer.js';

// Binary signing (Direction B: Binary + Bech32m)
export {
  signTokenV1Binary,
  verifyTokenSignatureV1Binary,
  assertTokenScopeMatchesStateBinary,
} from './token-signer.js';
export type { TokenSignErrorV2 } from './token-signer.js';

// Re-export branded id types for convenient access
export type { AttemptId, OutputId } from '../ids/index.js';
export { asAttemptId, asOutputId } from '../ids/index.js';
