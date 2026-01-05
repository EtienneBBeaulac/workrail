#!/usr/bin/env node

/**
 * Benchmark Token Size
 *
 * Measures and reports token sizes for binary format (Direction B).
 * Compares against expected targets and reports reduction percentages.
 *
 * Usage:
 *   npm run benchmark-token-size
 */

import * as crypto from 'crypto';
import { writeFile } from 'fs/promises';
import { LocalDataDirV2 } from '../dist/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../dist/v2/infra/local/fs/index.js';
import { NodeHmacSha256V2 } from '../dist/v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../dist/v2/infra/local/base64url/index.js';
import { LocalKeyringV2 } from '../dist/v2/infra/local/keyring/index.js';
import { NodeRandomEntropyV2 } from '../dist/v2/infra/local/random-entropy/index.js';
import { Bech32mAdapterV2 } from '../dist/v2/infra/local/bech32m/index.js';
import { Base32AdapterV2 } from '../dist/v2/infra/local/base32/index.js';
import { IdFactoryV2 } from '../dist/v2/infra/local/id-factory/index.js';
import { NodeCryptoV2 } from '../dist/v2/infra/local/crypto/index.js';

import { signTokenV1Binary } from '../dist/v2/durable-core/tokens/token-signer.js';
import type { StateTokenPayloadV1, AckTokenPayloadV1, CheckpointTokenPayloadV1 } from '../dist/v2/durable-core/tokens/payloads.js';
import { asWorkflowHash, asSha256Digest } from '../dist/v2/durable-core/ids/index.js';
import { deriveWorkflowHashRef } from '../dist/v2/durable-core/ids/workflow-hash-ref.js';

async function main() {
  console.log('📊 WorkRail v2 Token Size Benchmark\n');
  console.log('Direction B: Binary Payload + Bech32m Encoding\n');

  // Setup dependencies
  const dataDir = new LocalDataDirV2(process.env);
  const fs = new NodeFileSystemV2();
  const hmac = new NodeHmacSha256V2();
  const base64url = new NodeBase64UrlV2();
  const base32 = new Base32AdapterV2();
  const bech32m = new Bech32mAdapterV2();
  const entropy = new NodeRandomEntropyV2();
  const idFactory = new IdFactoryV2(entropy);
  const keyringPort = new LocalKeyringV2(dataDir, fs, base64url, entropy);

  const keyring = await keyringPort.loadOrCreate().match(
    (v) => v,
    (e) => {
      console.error(`Failed to load keyring: ${e.code}`);
      process.exit(1);
    }
  );

  // Create sample payloads
  const sessionId = idFactory.mintSessionId();
  const runId = idFactory.mintRunId();
  const nodeId = idFactory.mintNodeId();
  const attemptId = idFactory.mintAttemptId();

  const workflowHash = asWorkflowHash(
    asSha256Digest('sha256:' + crypto.randomBytes(32).toString('hex'))
  );
  const workflowHashRef = deriveWorkflowHashRef(workflowHash).match(
    (v) => v,
    (e) => {
      console.error(`Failed to derive workflow hash ref: ${e.code}`);
      process.exit(1);
    }
  );

  const statePayload: StateTokenPayloadV1 = {
    tokenVersion: 1,
    tokenKind: 'state',
    sessionId,
    runId,
    nodeId,
    workflowHashRef,
  };

  const ackPayload: AckTokenPayloadV1 = {
    tokenVersion: 1,
    tokenKind: 'ack',
    sessionId,
    runId,
    nodeId,
    attemptId,
  };

  const checkpointPayload: CheckpointTokenPayloadV1 = {
    tokenVersion: 1,
    tokenKind: 'checkpoint',
    sessionId,
    runId,
    nodeId,
    attemptId,
  };

  // Sign tokens
  const stateToken = signTokenV1Binary(statePayload, keyring, hmac, base64url, bech32m, base32).match(
    (v) => v,
    (e) => {
      console.error(`State token signing failed: ${e.code}`);
      process.exit(1);
    }
  );

  const ackToken = signTokenV1Binary(ackPayload, keyring, hmac, base64url, bech32m, base32).match(
    (v) => v,
    (e) => {
      console.error(`Ack token signing failed: ${e.code}`);
      process.exit(1);
    }
  );

  const checkpointToken = signTokenV1Binary(checkpointPayload, keyring, hmac, base64url, bech32m, base32).match(
    (v) => v,
    (e) => {
      console.error(`Checkpoint token signing failed: ${e.code}`);
      process.exit(1);
    }
  );

  // Measure
  const stateLen = stateToken.length;
  const ackLen = ackToken.length;
  const chkLen = checkpointToken.length;

  // Report
  console.log('Token Sizes:\n');

  console.log(`State Token:       ${stateLen} chars`);
  console.log(`  Target:          ≤ 170 chars`);
  console.log(`  Status:          ${stateLen <= 170 ? '✅ PASS' : '❌ FAIL'}`);
  console.log('');

  console.log(`Ack Token:         ${ackLen} chars`);
  console.log(`  Target:          ≤ 170 chars`);
  console.log(`  Status:          ${ackLen <= 170 ? '✅ PASS' : '❌ FAIL'}`);
  console.log('');

  console.log(`Checkpoint Token:  ${chkLen} chars`);
  console.log(`  Target:          ≤ 170 chars`);
  console.log(`  Status:          ${chkLen <= 170 ? '✅ PASS' : '❌ FAIL'}`);
  console.log('');

  // Baseline comparison (from original JCS + base64url format)
  const BASELINE_STATE = 290;
  const BASELINE_ACK = 310;
  const BASELINE_CHECKPOINT = 310;

  const stateReduction = ((BASELINE_STATE - stateLen) / BASELINE_STATE * 100).toFixed(1);
  const ackReduction = ((BASELINE_ACK - ackLen) / BASELINE_ACK * 100).toFixed(1);
  const chkReduction = ((BASELINE_CHECKPOINT - chkLen) / BASELINE_CHECKPOINT * 100).toFixed(1);

  console.log('Reduction from Baseline (JCS + base64url):\n');
  console.log(`State:      ${BASELINE_STATE} → ${stateLen} chars  (-${stateReduction}%)`);
  console.log(`Ack:        ${BASELINE_ACK} → ${ackLen} chars  (-${ackReduction}%)`);
  console.log(`Checkpoint: ${BASELINE_CHECKPOINT} → ${chkLen} chars  (-${chkReduction}%)`);
  console.log('');

  // Overall
  const avgReduction = ((+stateReduction + +ackReduction + +chkReduction) / 3).toFixed(1);
  console.log(`Average Reduction: ${avgReduction}%`);
  console.log('');

  const allSuccess = stateLen <= 170 && ackLen <= 170 && chkLen <= 170;
  
  if (allSuccess) {
    console.log('✅ All token sizes meet target (≤ 170 chars)');
  } else {
    console.log('❌ Some tokens exceed target');
  }

  // Emit JSON results file for CI/automation
  const results = {
    timestamp: new Date().toISOString(),
    format: 'binary+bech32m',
    tokens: {
      state: { length: stateLen, target: 170, pass: stateLen <= 170 },
      ack: { length: ackLen, target: 170, pass: ackLen <= 170 },
      checkpoint: { length: chkLen, target: 170, pass: chkLen <= 170 },
    },
    baseline: {
      state: BASELINE_STATE,
      ack: BASELINE_ACK,
      checkpoint: BASELINE_CHECKPOINT,
    },
    reductions: {
      state: stateReduction,
      ack: ackReduction,
      checkpoint: chkReduction,
      average: avgReduction,
    },
    success: allSuccess,
  };

  await writeFile('benchmark-token-size-results.json', JSON.stringify(results, null, 2));
  console.log('');
  console.log('📄 Results saved to: benchmark-token-size-results.json');

  process.exit(allSuccess ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
