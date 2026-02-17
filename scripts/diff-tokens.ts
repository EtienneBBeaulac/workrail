#!/usr/bin/env node

/**
 * Diff Tokens CLI
 *
 * Compares two binary tokens field-by-field.
 *
 * Usage:
 *   npm run diff-tokens <token1> <token2>
 *   node scripts/diff-tokens.ts st1abc... st1def...
 */

import { parseTokenV1Binary } from '../dist/v2/durable-core/tokens/token-codec.js';
import { Bech32mAdapterV2 } from '../dist/v2/infra/local/bech32m/index.js';

function main() {
  const args = process.argv.slice(2);

  if (args.length !== 2) {
    console.error('Usage: npm run diff-tokens <token1> <token2>');
    console.error('');
    console.error('Example:');
    console.error('  npm run diff-tokens st1abc... st1def...');
    process.exit(1);
  }

  const [token1Raw, token2Raw] = args;

  console.log('🔍 Token Diff\n');

  const bech32m = new Bech32mAdapterV2();

  const parsed1 = parseTokenV1Binary(token1Raw, bech32m);
  const parsed2 = parseTokenV1Binary(token2Raw, bech32m);

  if (parsed1.isErr()) {
    console.error('❌ Token 1 parse failed');
    console.error(`Code: ${parsed1.error.code}`);
    console.error(`Message: ${parsed1.error.message}`);
    process.exit(1);
  }

  if (parsed2.isErr()) {
    console.error('❌ Token 2 parse failed');
    console.error(`Code: ${parsed2.error.code}`);
    console.error(`Message: ${parsed2.error.message}`);
    process.exit(1);
  }

  const t1 = parsed1.value;
  const t2 = parsed2.value;

  console.log('Token 1 vs Token 2:\n');

  // HRP
  console.log(`HRP:           ${t1.hrp} ${t1.hrp === t2.hrp ? '==' : '!='} ${t2.hrp}`);

  // Payload fields
  const p1 = t1.payload;
  const p2 = t2.payload;

  console.log(`tokenVersion:  ${p1.tokenVersion} ${p1.tokenVersion === p2.tokenVersion ? '==' : '!='} ${p2.tokenVersion}`);
  console.log(`tokenKind:     ${p1.tokenKind} ${p1.tokenKind === p2.tokenKind ? '==' : '!='} ${p2.tokenKind}`);
  console.log(`sessionId:     ${p1.sessionId} ${p1.sessionId === p2.sessionId ? '==' : '!='} ${p2.sessionId}`);
  console.log(`runId:         ${p1.runId} ${p1.runId === p2.runId ? '==' : '!='} ${p2.runId}`);
  console.log(`nodeId:        ${p1.nodeId} ${p1.nodeId === p2.nodeId ? '==' : '!='} ${p2.nodeId}`);

  if (p1.tokenKind === 'state' && p2.tokenKind === 'state') {
    console.log(`workflowHashRef: ${(p1 as any).workflowHashRef} ${(p1 as any).workflowHashRef === (p2 as any).workflowHashRef ? '==' : '!='} ${(p2 as any).workflowHashRef}`);
  } else if (p1.tokenKind === 'ack' && p2.tokenKind === 'ack') {
    console.log(`attemptId:     ${(p1 as any).attemptId} ${(p1 as any).attemptId === (p2 as any).attemptId ? '==' : '!='} ${(p2 as any).attemptId}`);
  } else if (p1.tokenKind === 'checkpoint' && p2.tokenKind === 'checkpoint') {
    console.log(`attemptId:     ${(p1 as any).attemptId} ${(p1 as any).attemptId === (p2 as any).attemptId ? '==' : '!='} ${(p2 as any).attemptId}`);
  }

  console.log('');

  // Signature comparison
  const sig1Hex = Array.from(t1.signatureBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const sig2Hex = Array.from(t2.signatureBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  if (sig1Hex === sig2Hex) {
    console.log('Signature:     IDENTICAL');
  } else {
    console.log('Signature:     DIFFERENT');
    console.log(`  Token 1: ${sig1Hex.slice(0, 16)}...${sig1Hex.slice(-16)}`);
    console.log(`  Token 2: ${sig2Hex.slice(0, 16)}...${sig2Hex.slice(-16)}`);
  }

  console.log('');

  // Summary
  const allFieldsMatch =
    t1.hrp === t2.hrp &&
    p1.tokenVersion === p2.tokenVersion &&
    p1.tokenKind === p2.tokenKind &&
    p1.sessionId === p2.sessionId &&
    p1.runId === p2.runId &&
    p1.nodeId === p2.nodeId &&
    sig1Hex === sig2Hex;

  if (allFieldsMatch) {
    console.log('✅ Tokens are IDENTICAL (same payload and signature)');
  } else {
    console.log('⚠️  Tokens are DIFFERENT');
  }
}

main();
