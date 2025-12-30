import { ok, err } from 'neverthrow';
import { Buffer } from 'node:buffer';
import type { Base64UrlPortV2, Base64UrlError } from '../../../ports/base64url.port.js';

/**
 * Node Base64Url adapter using Buffer (Node-specific, hidden behind port).
 *
 * This adapter encapsulates Node's Buffer API for base64url encoding/decoding.
 * The port is runtime-neutral; this implementation is Node-specific.
 */
export class NodeBase64UrlV2 implements Base64UrlPortV2 {
  encodeBase64Url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64url');
  }

  decodeBase64Url(input: string): ReturnType<Base64UrlPortV2['decodeBase64Url']> {
    // Deterministic, strict, unpadded base64url (reject permissive Buffer decoding).
    if (input.trim() === '') {
      return err({
        code: 'INVALID_BASE64URL_CHARACTERS',
        message: 'Invalid base64url: empty input',
      } satisfies Base64UrlError);
    }

    if (input.includes('=')) {
      return err({
        code: 'INVALID_BASE64URL_PADDING',
        message: 'Invalid base64url: padding is not allowed',
      } satisfies Base64UrlError);
    }

    const base64UrlRe = /^[A-Za-z0-9_-]+$/;
    if (!base64UrlRe.test(input)) {
      return err({
        code: 'INVALID_BASE64URL_CHARACTERS',
        message: 'Invalid base64url: invalid characters',
      } satisfies Base64UrlError);
    }

    try {
      const decoded = Buffer.from(input, 'base64url');

      // Enforce canonicality: reject inputs that decode under Buffer but are not the canonical encoding.
      if (decoded.toString('base64url') !== input) {
        return err({
          code: 'INVALID_BASE64URL_CHARACTERS',
          message: 'Invalid base64url: non-canonical encoding',
        } satisfies Base64UrlError);
      }

      return ok(new Uint8Array(decoded));
    } catch (e) {
      return err({
        code: 'INVALID_BASE64URL_CHARACTERS',
        message: `Invalid base64url: ${e instanceof Error ? e.message : String(e)}`,
      } satisfies Base64UrlError);
    }
  }
}
