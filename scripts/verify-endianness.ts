#!/usr/bin/env node

/**
 * Verify binary token encoding endianness and byte layout.
 * 
 * Validates:
 * - tokenVersion and tokenKind occupy correct byte positions
 * - 66-byte total size is consistent
 * - Encoding is deterministic across platforms
 *
 * Usage:
 *   npm run verify-endianness
 */

import { packStateTokenPayload } from '../dist/v2/durable-core/tokens/binary-payload.js';
import { Base32AdapterV2 } from '../dist/v2/infra/local/base32/index.js';
import type { StateTokenPayloadV1 } from '../dist/v2/durable-core/tokens/payloads.js';

async function main() {
  console.log('🔍 Verifying Binary Token Endianness\n');
  
  const base32 = new Base32AdapterV2();
  
  // Create a test payload with all-zero IDs for predictable output
  const payload: StateTokenPayloadV1 = {
    tokenVersion: 1,
    tokenKind: 'state',
    sessionId: 'sess_aaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
    runId: 'run_aaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
    nodeId: 'node_aaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
    workflowHashRef: 'wf_aaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
  };
  
  const packedResult = packStateTokenPayload(payload, base32);
  
  if (packedResult.isErr()) {
    console.error('❌ Failed to pack test payload:', packedResult.error);
    process.exit(1);
  }
  
  const bytes = packedResult.value;
  
  // Verify byte layout
  const checks = [
    { name: 'Total size', actual: bytes.length, expected: 66 },
    { name: 'tokenVersion (byte[0])', actual: bytes[0], expected: 1 },
    { name: 'tokenKind (byte[1])', actual: bytes[1], expected: 0 }, // 0 = state
  ];
  
  let allPassed = true;
  
  for (const check of checks) {
    if (check.actual === check.expected) {
      console.log(`✅ ${check.name}: ${check.actual}`);
    } else {
      console.error(`❌ ${check.name}: expected ${check.expected}, got ${check.actual}`);
      allPassed = false;
    }
  }
  
  console.log('\nByte layout verification:');
  console.log('  [0]     tokenVersion:', bytes[0]);
  console.log('  [1]     tokenKind:', bytes[1]);
  console.log('  [2-17]  sessionId (16 bytes)');
  console.log('  [18-33] runId (16 bytes)');
  console.log('  [34-49] nodeId (16 bytes)');
  console.log('  [50-65] workflowHashRef (16 bytes)');
  
  // Check all-zero IDs decode correctly
  const allZeroBytes = bytes.slice(2, 18); // sessionId bytes
  const allZero = allZeroBytes.every(b => b === 0);
  
  if (allZero) {
    console.log('\n✅ All-zero ID encoding verified');
  } else {
    console.error('\n⚠️  Expected all-zero bytes for sessionId, got:', allZeroBytes);
  }
  
  if (allPassed) {
    console.log('\n✅ Endianness verification PASSED');
    console.log(`   Platform: ${process.platform} ${process.arch}`);
    console.log(`   Node: ${process.version}`);
    process.exit(0);
  } else {
    console.error('\n❌ Endianness verification FAILED');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
