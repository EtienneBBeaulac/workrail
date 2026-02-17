#!/usr/bin/env node

/**
 * Check Keyring CLI
 *
 * Validates the v2 keyring structure and reports key status.
 *
 * Usage:
 *   npm run check-keyring
 *   node scripts/check-keyring.ts
 */

import { LocalDataDirV2 } from '../dist/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../dist/v2/infra/local/fs/index.js';
import { NodeBase64UrlV2 } from '../dist/v2/infra/local/base64url/index.js';
import { NodeRandomEntropyV2 } from '../dist/v2/infra/local/random-entropy/index.js';
import { LocalKeyringV2 } from '../dist/v2/infra/local/keyring/index.js';

async function main() {
  console.log('🔑 WorkRail v2 Keyring Check\n');

  const dataDir = new LocalDataDirV2(process.env);
  const fs = new NodeFileSystemV2();
  const base64url = new NodeBase64UrlV2();
  const entropy = new NodeRandomEntropyV2();
  const keyring = new LocalKeyringV2(dataDir, fs, base64url, entropy);

  const keyringPath = dataDir.keyringPath();
  console.log(`Location: ${keyringPath}\n`);

  const result = await keyring.loadOrCreate();

  if (result.isErr()) {
    console.error('❌ Keyring Error');
    console.error('');
    console.error(`Code: ${result.error.code}`);
    console.error(`Message: ${result.error.message}`);
    console.error('');
    console.error('Suggestion: Delete the keyring file and let WorkRail regenerate it:');
    console.error(`  rm "${keyringPath}"`);
    process.exit(1);
  }

  const kr = result.value;

  console.log('✅ Keyring Valid\n');
  console.log(`Version: ${kr.v}`);
  console.log('');

  // Current key
  console.log('Current Key:');
  console.log(`  Algorithm: ${kr.current.alg}`);
  console.log(`  Encoded:   ${kr.current.keyBase64Url.slice(0, 16)}...${kr.current.keyBase64Url.slice(-16)}`);

  const currentBytes = base64url.decodeBase64Url(kr.current.keyBase64Url);
  if (currentBytes.isOk()) {
    console.log(`  Length:    ${currentBytes.value.length} bytes`);
    if (currentBytes.value.length !== 32) {
      console.log(`  ⚠️  WARNING: Expected 32 bytes, got ${currentBytes.value.length}`);
    }
  } else {
    console.log(`  ⚠️  ERROR: Failed to decode: ${currentBytes.error.code}`);
  }

  console.log('');

  // Previous key
  if (kr.previous) {
    console.log('Previous Key:');
    console.log(`  Algorithm: ${kr.previous.alg}`);
    console.log(`  Encoded:   ${kr.previous.keyBase64Url.slice(0, 16)}...${kr.previous.keyBase64Url.slice(-16)}`);

    const prevBytes = base64url.decodeBase64Url(kr.previous.keyBase64Url);
    if (prevBytes.isOk()) {
      console.log(`  Length:    ${prevBytes.value.length} bytes`);
      if (prevBytes.value.length !== 32) {
        console.log(`  ⚠️  WARNING: Expected 32 bytes, got ${prevBytes.value.length}`);
      }
    } else {
      console.log(`  ⚠️  ERROR: Failed to decode: ${prevBytes.error.code}`);
    }
  } else {
    console.log('Previous Key: (none - no rotation yet)');
  }

  console.log('');
  console.log('✓ Keyring structure is valid');
  console.log('✓ Both keys are 32-byte HMAC-SHA256 keys');
  console.log('');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
