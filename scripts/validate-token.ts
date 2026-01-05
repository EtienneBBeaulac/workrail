#!/usr/bin/env npx ts-node

/**
 * Validate Token CLI
 *
 * Parses and verifies a binary token's signature against the local keyring.
 *
 * Usage:
 *   npx ts-node scripts/validate-token.ts <token-string>
 *   npm run validate-token -- <token-string>
 *
 * Example:
 *   npx ts-node scripts/validate-token.ts st1qpzry9x8gf2tvdw0s3jn54khce6mua7l...
 */

import { parseTokenV1Binary } from '../dist/v2/durable-core/tokens/token-codec.js';
import { verifyTokenSignatureV1Binary } from '../dist/v2/durable-core/tokens/token-signer.js';
import { Bech32mAdapterV2 } from '../dist/v2/infra/local/bech32m/index.js';
import { Base32AdapterV2 } from '../dist/v2/infra/local/base32/index.js';
import { LocalKeyringV2 } from '../dist/v2/infra/local/keyring/index.js';
import { LocalDataDirV2 } from '../dist/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../dist/v2/infra/local/fs/index.js';
import { NodeBase64UrlV2 } from '../dist/v2/infra/local/base64url/index.js';
import { NodeRandomEntropyV2 } from '../dist/v2/infra/local/random-entropy/index.js';
import { NodeHmacSha256V2 } from '../dist/v2/infra/local/hmac-sha256/index.js';

const bech32m = new Bech32mAdapterV2();
const base32 = new Base32AdapterV2();
const hmac = new NodeHmacSha256V2();
const base64url = new NodeBase64UrlV2();

async function main() {
  const tokenString = process.argv[2];

  if (!tokenString) {
    console.error('Usage: npx ts-node scripts/validate-token.ts <token-string>');
    console.error('');
    console.error('Parses and verifies a binary token\'s signature against the local keyring.');
    console.error('');
    console.error('Example:');
    console.error('  npx ts-node scripts/validate-token.ts st1qpzry9x8gf2tvdw0s3jn...');
    process.exit(1);
  }

  console.log('Validating token...');
  console.log('');

  // Step 1: Parse token
  console.log('Step 1: Parsing token...');
  const parsed = parseTokenV1Binary(tokenString, bech32m, base32);

  if (parsed.isErr()) {
    console.error('❌ Parse Failed');
    console.error('');
    console.error('Code:', parsed.error.code);
    console.error('Message:', parsed.error.message);
    const error = parsed.error as { details?: { bech32mError?: { code: string; message: string; position?: number } } };
    if (error.details?.bech32mError) {
      const bErr = error.details.bech32mError;
      if (bErr.position !== undefined) {
        console.error('Estimated error position:', bErr.position);
      }
    }
    process.exit(1);
  }

  console.log('✅ Token parsed successfully');
  console.log('   Type:', parsed.value.hrp);
  console.log('   Token Kind:', parsed.value.payload.tokenKind);
  console.log('   Session:', parsed.value.payload.sessionId);
  console.log('');

  // Step 2: Load keyring
  console.log('Step 2: Loading keyring...');
  const dataDir = new LocalDataDirV2(process.env);
  const fsPort = new NodeFileSystemV2();
  const entropy = new NodeRandomEntropyV2();
  const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);

  const keyringResult = await keyringPort.loadOrCreate();
  if (keyringResult.isErr()) {
    console.error('❌ Keyring load failed');
    console.error('Code:', keyringResult.error.code);
    console.error('Message:', keyringResult.error.message);
    process.exit(1);
  }

  console.log('✅ Keyring loaded');
  console.log('');

  // Step 3: Verify signature
  console.log('Step 3: Verifying signature...');
  const verified = verifyTokenSignatureV1Binary(parsed.value, keyringResult.value, hmac, base64url);

  if (verified.isErr()) {
    console.error('❌ Signature Verification Failed');
    console.error('');
    console.error('Code:', verified.error.code);
    console.error('Message:', verified.error.message);
    console.error('');
    console.error('This could mean:');
    console.error('  - The token was signed with a different key');
    console.error('  - The token was tampered with');
    console.error('  - The keyring was rotated after the token was created');
    process.exit(1);
  }

  console.log('✅ Signature valid');
  console.log('');
  console.log('=== Token Validation Summary ===');
  console.log('Parse: ✅ OK');
  console.log('Signature: ✅ OK');
  console.log('');
  console.log('Token is valid and signed by the local keyring.');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
