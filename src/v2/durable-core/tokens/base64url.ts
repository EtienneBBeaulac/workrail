import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';

export type Base64UrlError =
  | { readonly code: 'BASE64URL_INVALID'; readonly message: string };

export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function decodeBase64Url(input: string): Result<Uint8Array, Base64UrlError> {
  try {
    return ok(new Uint8Array(Buffer.from(input, 'base64url')));
  } catch {
    return err({ code: 'BASE64URL_INVALID', message: 'Invalid base64url string' });
  }
}
