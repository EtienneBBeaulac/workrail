import type { Result } from 'neverthrow';

/**
 * Base64Url codec port.
 *
 * Lock: durable-core must not use Node-only Buffer
 * Design: v2-core-design-locks.md §17 (runtime neutrality)
 */

export type Base64UrlError =
  | { readonly code: 'INVALID_BASE64URL_CHARACTERS'; readonly message: string }
  | { readonly code: 'INVALID_BASE64URL_PADDING'; readonly message: string };

/**
 * Base64Url codec for token payload encoding.
 *
 * Design decisions (locked):
 * - encode is infallible (Uint8Array → base64url always succeeds)
 * - decode returns Result (invalid input is expected, not exceptional)
 */
export interface Base64UrlPortV2 {
  encodeBase64Url(bytes: Uint8Array): string;
  decodeBase64Url(input: string): Result<Uint8Array, Base64UrlError>;
}
