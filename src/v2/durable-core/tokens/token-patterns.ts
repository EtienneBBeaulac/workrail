/**
 * Token format regex patterns — single source of truth.
 *
 * WHY: Centralizing prevents drift between output-schema validation (5+ sites)
 * and any future format checks. Both v1 (bech32m) and v2 (short reference) forms
 * are captured as union patterns.
 *
 * v1 format: <hrp>1<bech32m-chars>   e.g. st1qyq...
 * v2 format: <prefix>_<base64url-24>  e.g. st_Rk9vYmFyQmF6bUF3YQ
 *
 * The v2 payload is base64url(12-byte-nonce || 6-byte-truncated-HMAC) = 18 bytes = 24 base64url chars.
 */

const BECH32_CHARS = '[023456789acdefghjklmnpqrstuvwxyz]+';
const BASE64URL_24 = '[A-Za-z0-9_-]{24}';

/**
 * Accepts either v1 `st1<bech32m>` or v2 `st_<base64url-24>` state tokens.
 */
export const STATE_TOKEN_PATTERN = new RegExp(`^(st1${BECH32_CHARS}|st_${BASE64URL_24})$`);

/**
 * Accepts either v1 `ack1<bech32m>` or v2 `ak_<base64url-24>` ack tokens.
 */
export const ACK_TOKEN_PATTERN = new RegExp(`^(ack1${BECH32_CHARS}|ak_${BASE64URL_24})$`);

/**
 * Accepts either v1 `chk1<bech32m>` or v2 `ck_<base64url-24>` checkpoint tokens.
 */
export const CHECKPOINT_TOKEN_PATTERN = new RegExp(`^(chk1${BECH32_CHARS}|ck_${BASE64URL_24})$`);

/**
 * Accepts `ct_<base64url-24>` continue tokens (one-token protocol, v2 only).
 *
 * WHY: The continue token collapses stateToken + ackToken into a single opaque token.
 * It carries session, run, node, attempt, AND workflowHashRef in the alias entry.
 * No v1 bech32m equivalent exists -- this is a v2-only concept.
 */
export const CONTINUE_TOKEN_PATTERN = new RegExp(`^ct_${BASE64URL_24}$`);
