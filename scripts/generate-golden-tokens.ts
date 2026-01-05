#!/usr/bin/env node

/**
 * Generate Golden Token Fixtures
 *
 * Creates deterministic golden token fixtures for regression testing.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { packStateTokenPayload, packAckTokenPayload } from '../dist/v2/durable-core/tokens/binary-payload.js';
import { signTokenV1Binary } from '../dist/v2/durable-core/tokens/token-signer.js';
import { asSessionId, asRunId, asNodeId, asAttemptId, asWorkflowHashRef } from '../dist/v2/durable-core/ids/index.js';
import { LocalDataDirV2 } from '../dist/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../dist/v2/infra/local/fs/index.js';
import { NodeHmacSha256V2 } from '../dist/v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../dist/v2/infra/local/base64url/index.js';
import { LocalKeyringV2 } from '../dist/v2/infra/local/keyring/index.js';
import { NodeRandomEntropyV2 } from '../dist/v2/infra/local/random-entropy/index.js';
import { Bech32mAdapterV2 } from '../dist/v2/infra/local/bech32m/index.js';
import { Base32AdapterV2 } from '../dist/v2/infra/local/base32/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, '../tests/unit/v2/golden-tokens/fixtures');

async function main() {
  const base32 = new Base32AdapterV2();
  
  console.log('🔧 Generating golden token fixtures...\n');

  // Ensure fixtures dir exists
  if (!fs.existsSync(FIXTURES_DIR)) {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  }

  // 1. State token - minimal (all zeros)
  const stateMinimal = {
    tokenVersion: 1 as const,
    tokenKind: 'state' as const,
    sessionId: asSessionId('sess_aaaaaaaaaaaaaaaaaaaaaaaaaa'),
    runId: asRunId('run_aaaaaaaaaaaaaaaaaaaaaaaaaa'),
    nodeId: asNodeId('node_aaaaaaaaaaaaaaaaaaaaaaaaaa'),
    workflowHashRef: asWorkflowHashRef('wf_aaaaaaaaaaaaaaaaaaaaaaaaaa'),
  };

  const packedStateMin = packStateTokenPayload(stateMinimal, base32).match(
    (v) => v,
    (e) => { throw new Error(`pack failed: ${e.code}`); }
  );

  const stateMinHex = Array.from(packedStateMin).map(b => b.toString(16).padStart(2, '0')).join('');

  fs.writeFileSync(
    path.join(FIXTURES_DIR, 'state-token-minimal.json'),
    JSON.stringify({
      description: 'Minimal state token with deterministic IDs (all zeros)',
      payload: stateMinimal,
      expectedPackedHex: stateMinHex,
      expectedTokenPrefix: 'st1',
    }, null, 2)
  );

  console.log('✓ Generated: state-token-minimal.json');

  // 2. State token - varied IDs
  const stateVaried = {
    tokenVersion: 1 as const,
    tokenKind: 'state' as const,
    sessionId: asSessionId('sess_aqcqmbyibefawdanb4fqzd4ojy'),
    runId: asRunId('run_ciqdeibugaytemrtgq3tmmzyha'),
    nodeId: asNodeId('node_eaqduibsheydcmzwgy2tcnbyhe'),
    workflowHashRef: asWorkflowHashRef('wf_gaytemzugu3doobzg44tanjqga'),
  };

  const packedStateVar = packStateTokenPayload(stateVaried, base32).match(
    (v) => v,
    (e) => { throw new Error(`pack failed: ${e.code}`); }
  );

  const stateVarHex = Array.from(packedStateVar).map(b => b.toString(16).padStart(2, '0')).join('');

  fs.writeFileSync(
    path.join(FIXTURES_DIR, 'state-token-varied-ids.json'),
    JSON.stringify({
      description: 'State token with varied IDs (non-zero bytes)',
      payload: stateVaried,
      expectedPackedHex: stateVarHex,
      expectedTokenPrefix: 'st1',
    }, null, 2)
  );

  console.log('✓ Generated: state-token-varied-ids.json');

  // 3. Ack token - minimal
  const ackMinimal = {
    tokenVersion: 1 as const,
    tokenKind: 'ack' as const,
    sessionId: asSessionId('sess_aaaaaaaaaaaaaaaaaaaaaaaaaa'),
    runId: asRunId('run_aaaaaaaaaaaaaaaaaaaaaaaaaa'),
    nodeId: asNodeId('node_aaaaaaaaaaaaaaaaaaaaaaaaaa'),
    attemptId: asAttemptId('attempt_aaaaaaaaaaaaaaaaaaaaaaaaaa'),
  };

  const packedAckMin = packAckTokenPayload(ackMinimal, base32).match(
    (v) => v,
    (e) => { throw new Error(`pack failed: ${e.code}`); }
  );

  const ackMinHex = Array.from(packedAckMin).map(b => b.toString(16).padStart(2, '0')).join('');

  fs.writeFileSync(
    path.join(FIXTURES_DIR, 'ack-token-minimal.json'),
    JSON.stringify({
      description: 'Minimal ack token with deterministic IDs (all zeros)',
      payload: ackMinimal,
      expectedPackedHex: ackMinHex,
      expectedTokenPrefix: 'ack1',
    }, null, 2)
  );

  console.log('✓ Generated: ack-token-minimal.json');

  // 4. Generate a golden signed token for end-to-end stability
  console.log('\nGenerating golden signed token...');

  const dataDir = new LocalDataDirV2(process.env);
  const fsPort = new NodeFileSystemV2();
  const hmac = new NodeHmacSha256V2();
  const base64url = new NodeBase64UrlV2();
  const bech32m = new Bech32mAdapterV2();
  const entropy = new NodeRandomEntropyV2();
  const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);

  const keyring = await keyringPort.loadOrCreate().match(
    (v) => v,
    (e) => { throw new Error(`keyring load failed: ${e.code}`); }
  );

  const goldenToken = signTokenV1Binary(stateMinimal, keyring, hmac, base64url, bech32m, base32).match(
    (v) => v,
    (e) => { throw new Error(`sign failed: ${e.code}`); }
  );

  console.log('\n📝 Golden Token (copy into test):');
  console.log(`  ${goldenToken}`);
  console.log(`  Length: ${goldenToken.length} chars`);
  console.log('');
  console.log('✅ All golden fixtures generated');
  console.log('');
  console.log('Next: Run tests to verify:');
  console.log('  npm test tests/unit/v2/golden-tokens/golden-tokens.test.ts');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
