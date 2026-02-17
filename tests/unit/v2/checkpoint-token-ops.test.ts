/**
 * Checkpoint Token Operations Tests
 *
 * Tests for checkpoint token parsing, signing, and the
 * parseCheckpointTokenOrFail function.
 */

import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { parseCheckpointTokenOrFail, signTokenOrErr } from '../../../src/mcp/handlers/v2-token-ops.js';
import { unsafeTokenCodecPorts } from '../../../src/v2/durable-core/tokens/index.js';
import { NodeHmacSha256V2 } from '../../../src/v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../../../src/v2/infra/local/base64url/index.js';
import { Base32AdapterV2 } from '../../../src/v2/infra/local/base32/index.js';
import { Bech32mAdapterV2 } from '../../../src/v2/infra/local/bech32m/index.js';
import { LocalDataDirV2 } from '../../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../../src/v2/infra/local/fs/index.js';
import { LocalKeyringV2 } from '../../../src/v2/infra/local/keyring/index.js';
import { NodeRandomEntropyV2 } from '../../../src/v2/infra/local/random-entropy/index.js';
import { encodeBase32LowerNoPad } from '../../../src/v2/durable-core/encoding/base32-lower.js';
import { asWorkflowHash, asSha256Digest } from '../../../src/v2/durable-core/ids/index.js';
import { deriveWorkflowHashRef } from '../../../src/v2/durable-core/ids/workflow-hash-ref.js';
import type { TokenCodecPorts } from '../../../src/v2/durable-core/tokens/index.js';

// Generate valid binary-compatible IDs (prefix + 26-char base32)
function mkId(prefix: string, fill: number): string {
  const bytes = new Uint8Array(16);
  bytes.fill(fill);
  return `${prefix}_${encodeBase32LowerNoPad(bytes)}`;
}

async function createTestPorts(): Promise<TokenCodecPorts> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workrail-chk-test-'));
  const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
  const fsPort = new NodeFileSystemV2();
  const hmac = new NodeHmacSha256V2();
  const base64url = new NodeBase64UrlV2();
  const entropy = new NodeRandomEntropyV2();
  const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);
  const base32 = new Base32AdapterV2();
  const bech32m = new Bech32mAdapterV2();

  const keyring = await keyringPort.loadOrCreate().match(
    (v) => v,
    (e) => { throw new Error(`unexpected keyring error: ${e.code}`); }
  );

  return unsafeTokenCodecPorts({ keyring, hmac, base64url, base32, bech32m });
}

// Pre-generate valid IDs for all tests
// Prefixes must match what binary-payload.ts expects:
// sessionIdToBytes → 'sess', runIdToBytes → 'run', nodeIdToBytes → 'node', attemptIdToBytes → 'attempt'
const SESS_ID = mkId('sess', 1);
const RUN_ID = mkId('run', 2);
const NODE_ID = mkId('node', 3);
const ATT_ID = mkId('attempt', 4);
const ATT_ID_2 = mkId('attempt', 5);

function mintCheckpointToken(
  ports: TokenCodecPorts,
  overrides: { attemptId?: string } = {},
): string {
  const res = signTokenOrErr({
    payload: {
      tokenVersion: 1,
      tokenKind: 'checkpoint' as const,
      sessionId: SESS_ID,
      runId: RUN_ID,
      nodeId: NODE_ID,
      attemptId: overrides.attemptId ?? ATT_ID,
    },
    ports,
  });
  expect(res.isOk()).toBe(true);
  return res._unsafeUnwrap();
}

describe('parseCheckpointTokenOrFail', () => {
  let ports: TokenCodecPorts;

  it('setup', async () => {
    ports = await createTestPorts();
  });

  it('parses a valid checkpoint token', () => {
    const token = mintCheckpointToken(ports);
    const result = parseCheckpointTokenOrFail(token, ports);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token.payload.tokenKind).toBe('checkpoint');
      expect(String(result.token.payload.sessionId)).toBe(SESS_ID);
      expect(String(result.token.payload.runId)).toBe(RUN_ID);
      expect(String(result.token.payload.nodeId)).toBe(NODE_ID);
      expect(String(result.token.payload.attemptId)).toBe(ATT_ID);
    }
  });

  it('rejects a state token', () => {
    const wfHash = asWorkflowHash(asSha256Digest('sha256:5b2d9fb885d0adc6565e1fd59e6abb3769b69e4dba5a02b6eea750137a5c0be2'));
    const wfRef = deriveWorkflowHashRef(wfHash)._unsafeUnwrap();
    const stateRes = signTokenOrErr({
      payload: {
        tokenVersion: 1,
        tokenKind: 'state' as const,
        sessionId: SESS_ID,
        runId: RUN_ID,
        nodeId: NODE_ID,
        workflowHashRef: String(wfRef),
      },
      ports,
    });
    expect(stateRes.isOk()).toBe(true);

    const result = parseCheckpointTokenOrFail(stateRes._unsafeUnwrap(), ports);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain('checkpoint');
    }
  });

  it('rejects an ack token', () => {
    const ackRes = signTokenOrErr({
      payload: {
        tokenVersion: 1,
        tokenKind: 'ack' as const,
        sessionId: SESS_ID,
        runId: RUN_ID,
        nodeId: NODE_ID,
        attemptId: ATT_ID,
      },
      ports,
    });
    expect(ackRes.isOk()).toBe(true);

    const result = parseCheckpointTokenOrFail(ackRes._unsafeUnwrap(), ports);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).toContain('checkpoint');
    }
  });

  it('rejects garbage input', () => {
    const result = parseCheckpointTokenOrFail('garbage-not-a-token', ports);
    expect(result.ok).toBe(false);
  });

  it('rejects tampered token', () => {
    const token = mintCheckpointToken(ports);
    // Tamper with the last character
    const tampered = token.slice(0, -1) + (token.slice(-1) === 'q' ? 'p' : 'q');
    const result = parseCheckpointTokenOrFail(tampered, ports);
    expect(result.ok).toBe(false);
  });
});

describe('checkpoint token format', () => {
  let ports: TokenCodecPorts;

  it('setup', async () => {
    ports = await createTestPorts();
  });

  it('checkpoint token starts with chk1', () => {
    const token = mintCheckpointToken(ports);
    expect(token).toMatch(/^chk1/);
  });

  it('checkpoint token is deterministic for same inputs', () => {
    const token1 = mintCheckpointToken(ports);
    const token2 = mintCheckpointToken(ports);
    expect(token1).toBe(token2);
  });

  it('different attemptIds produce different tokens', () => {
    const token1 = mintCheckpointToken(ports, { attemptId: ATT_ID });
    const token2 = mintCheckpointToken(ports, { attemptId: ATT_ID_2 });
    expect(token1).not.toBe(token2);
  });
});
