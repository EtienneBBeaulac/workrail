import type { TokenCodecPorts } from './token-codec-ports.js';

/**
 * Token codec capability types.
 *
 * WHY: Keep dependency surfaces explicit and minimal. Callers can only access the
 * ports a function declares, preventing dependency creep.
 */

export type TokenParsePorts = Pick<TokenCodecPorts, 'bech32m' | 'base32'>;

export type TokenVerifyPorts = Pick<TokenCodecPorts, 'keyring' | 'hmac' | 'base64url'>;

export type TokenSignPorts = TokenCodecPorts;
