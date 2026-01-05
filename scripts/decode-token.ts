#!/usr/bin/env npx ts-node

/**
 * Decode Token CLI
 *
 * Decodes a binary token (st1/ack1/chk1 format) and displays its contents.
 *
 * Usage:
 *   npx ts-node scripts/decode-token.ts <token-string>
 *   npm run decode-token -- <token-string>
 *
 * Example:
 *   npx ts-node scripts/decode-token.ts st1qpzry9x8gf2tvdw0s3jn54khce6mua7l...
 */

import { parseTokenV1Binary } from '../dist/v2/durable-core/tokens/token-codec.js';
import { Bech32mAdapterV2 } from '../dist/v2/infra/local/bech32m/index.js';
import { Base32AdapterV2 } from '../dist/v2/infra/local/base32/index.js';

function main() {
  const args = process.argv.slice(2);
  const formatArg = args.find(a => a.startsWith('--format='));
  const format = formatArg ? formatArg.split('=')[1] : 'text';
  const tokenString = args.find(a => !a.startsWith('--'));

  const bech32m = new Bech32mAdapterV2();
  const base32 = new Base32AdapterV2();

  if (!tokenString) {
    console.error('Usage: npm run decode-token [--format=json] <token>');
    console.error('');
    console.error('Examples:');
    console.error('  npm run decode-token st1qpzry9x8gf2tvdw0s3jn54khce6mua7l...');
    console.error('  npm run decode-token --format=json st1qpzry9x8...');
    process.exit(1);
  }

  if (format !== 'json') {
    console.log('Decoding token...');
    console.log('');
  }

  const parsed = parseTokenV1Binary(tokenString, bech32m, base32);

  if (parsed.isErr()) {
    if (format === 'json') {
      console.log(JSON.stringify({
        success: false,
        error: {
          code: parsed.error.code,
          message: parsed.error.message,
          details: (parsed.error as any).details,
        },
      }, null, 2));
    } else {
      console.error('❌ Parse Error');
      console.error('');
      console.error('Code:', parsed.error.code);
      console.error('Message:', parsed.error.message);
      const error = parsed.error as { details?: { bech32mError?: { code: string; message: string; position?: number } } };
      if (error.details?.bech32mError) {
        const bErr = error.details.bech32mError;
        console.error('');
        console.error('Bech32m Error:');
        console.error('  Code:', bErr.code);
        console.error('  Message:', bErr.message);
        if (bErr.position !== undefined) {
          console.error('  Position:', bErr.position);
        }
      }
    }
    process.exit(1);
  }

  const { hrp, version, payload, payloadBytes, signatureBytes } = parsed.value;

  if (format === 'json') {
    console.log(JSON.stringify({
      success: true,
      token: {
        hrp,
        version,
        length: tokenString.length,
        payload,
        bytes: {
          payload: Buffer.from(payloadBytes).toString('hex'),
          signature: Buffer.from(signatureBytes).toString('hex'),
        },
        sizes: {
          payloadBytes: payloadBytes.length,
          signatureBytes: signatureBytes.length,
          totalBytes: payloadBytes.length + signatureBytes.length,
          encodedChars: tokenString.length,
        },
      },
    }, null, 2));
  } else {
    console.log('✅ Token Parsed Successfully');
    console.log('');
    console.log('=== Token Info ===');
    console.log('Type (HRP):', hrp);
    console.log('Version:', version);
    console.log('Token Length:', tokenString.length, 'chars');
    console.log('');
    console.log('=== Payload ===');
    console.log(JSON.stringify(payload, null, 2));
    console.log('');
    console.log('=== Raw Bytes ===');
    console.log('Payload (66 bytes):', Buffer.from(payloadBytes).toString('hex'));
    console.log('Signature (32 bytes):', Buffer.from(signatureBytes).toString('hex'));
    console.log('');
    console.log('=== Size Analysis ===');
    console.log('Binary payload:', payloadBytes.length, 'bytes');
    console.log('HMAC signature:', signatureBytes.length, 'bytes');
    console.log('Total binary:', payloadBytes.length + signatureBytes.length, 'bytes');
    console.log('Bech32m encoded:', tokenString.length, 'chars');
  }
}

main();
