import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { handleV2ContinueWorkflow } from '../../src/mcp/handlers/v2-execution.js';
import type { ToolContext, V2Dependencies } from '../../src/mcp/types.js';

import { LocalDataDirV2 } from '../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../src/v2/infra/local/fs/index.js';
import { NodeCryptoV2 } from '../../src/v2/infra/local/crypto/index.js';
import { NodeHmacSha256V2 } from '../../src/v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../../src/v2/infra/local/base64url/index.js';
import { NodeSha256V2 } from '../../src/v2/infra/local/sha256/index.js';
import { LocalKeyringV2 } from '../../src/v2/infra/local/keyring/index.js';
import { LocalSessionLockV2 } from '../../src/v2/infra/local/session-lock/index.js';
import { LocalSessionEventLogStoreV2 } from '../../src/v2/infra/local/session-store/index.js';
import { LocalSnapshotStoreV2 } from '../../src/v2/infra/local/snapshot-store/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../../src/v2/infra/local/pinned-workflow-store/index.js';
import { ExecutionSessionGateV2 } from '../../src/v2/usecases/execution-session-gate.js';
import { NodeRandomEntropyV2 } from '../../src/v2/infra/local/random-entropy/index.js';
import { NodeTimeClockV2 } from '../../src/v2/infra/local/time-clock/index.js';

import { encodeTokenPayloadV1, signTokenV1 } from '../../src/v2/durable-core/tokens/index.js';
import { StateTokenPayloadV1Schema, AckTokenPayloadV1Schema } from '../../src/v2/durable-core/tokens/index.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-exec-'));
}

async function mkV2Deps(): Promise<V2Dependencies> {
  const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: process.env.WORKRAIL_DATA_DIR || await mkTempDataDir() });
  const fsPort = new NodeFileSystemV2();
  const sha256Port = new NodeSha256V2();
  const clock = new NodeTimeClockV2();
  const lockPort = new LocalSessionLockV2(dataDir, fsPort, clock);
  const sessionStore = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256Port);
  const crypto = new NodeCryptoV2();
  const hmac = new NodeHmacSha256V2();
  const base64url = new NodeBase64UrlV2();
  const entropy = new NodeRandomEntropyV2();
  const snapshotStore = new LocalSnapshotStoreV2(dataDir, fsPort, crypto);
  const pinnedStore = new LocalPinnedWorkflowStoreV2(dataDir, fsPort);
  const keyring = await new LocalKeyringV2(dataDir, fsPort, base64url, entropy).loadOrCreate().match(
    (v) => v,
    (e) => {
      throw new Error(`unexpected keyring error: ${e.code}`);
    }
  );
  const gate = new ExecutionSessionGateV2(lockPort, sessionStore);

  return {
    gate,
    sessionStore,
    snapshotStore,
    pinnedStore,
    keyring,
    crypto,
    hmac,
    base64url,
  };
}

async function dummyCtx(): Promise<ToolContext> {
  const v2Deps = await mkV2Deps();
  return {
    workflowService: null as any,
    featureFlags: null as any,
    sessionManager: null,
    httpServer: null,
    v2: v2Deps,
  };
}

async function mkSignedToken(args: {
  root: string;
  unsignedPrefix: 'st.v1.' | 'ack.v1.';
  payload: unknown;
}): Promise<string> {
  const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: args.root });
  const fsPort = new NodeFileSystemV2();
  const hmac = new NodeHmacSha256V2();
  const base64url = new NodeBase64UrlV2();
  const entropy = new NodeRandomEntropyV2();
  const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);
  const keyring = await keyringPort.loadOrCreate().match(
    (v) => v,
    (e) => {
      throw new Error(`unexpected keyring error: ${e.code}`);
    }
  );

  const payloadBytes = encodeTokenPayloadV1(args.payload as any).match(
    (v) => v,
    (e) => {
      throw new Error(`unexpected token payload encode error: ${e.code}`);
    }
  );

  const token = signTokenV1(args.unsignedPrefix, payloadBytes, keyring, hmac, base64url).match(
    (v) => v,
    (e) => {
      throw new Error(`unexpected token sign error: ${e.code}`);
    }
  );
  return String(token);
}

describe('v2 execution placeholder handlers (Slice 3.2 boundary validation)', () => {
  it('returns VALIDATION_ERROR for an invalid stateToken', async () => {
    const res = await handleV2ContinueWorkflow({ stateToken: 'not-a-token' } as any, await dummyCtx());
    expect(res.type).toBe('error');
    if (res.type !== 'error') return;
    expect(res.code).toBe('TOKEN_INVALID_FORMAT');
  });

  it('returns TOKEN_UNKNOWN_NODE for a valid stateToken without durable run state (rehydrate path)', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {

      const payload = StateTokenPayloadV1Schema.parse({
        tokenVersion: 1,
        tokenKind: 'state',
        sessionId: 'sess_1',
        runId: 'run_1',
        nodeId: 'node_1',
        workflowHash: 'sha256:5b2d9fb885d0adc6565e1fd59e6abb3769b69e4dba5a02b6eea750137a5c0be2',
      });

      const token = await mkSignedToken({ root, unsignedPrefix: 'st.v1.', payload });
      const res = await handleV2ContinueWorkflow({ stateToken: token } as any, await dummyCtx());

      expect(res.type).toBe('error');
      if (res.type !== 'error') return;
      expect(res.code).toBe('TOKEN_UNKNOWN_NODE');
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });

  it('returns TOKEN_SCOPE_MISMATCH when ackToken scope mismatches stateToken', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {

      const statePayload = StateTokenPayloadV1Schema.parse({
        tokenVersion: 1,
        tokenKind: 'state',
        sessionId: 'sess_1',
        runId: 'run_1',
        nodeId: 'node_A',
        workflowHash: 'sha256:5b2d9fb885d0adc6565e1fd59e6abb3769b69e4dba5a02b6eea750137a5c0be2',
      });

      const ackPayload = AckTokenPayloadV1Schema.parse({
        tokenVersion: 1,
        tokenKind: 'ack',
        sessionId: 'sess_1',
        runId: 'run_1',
        nodeId: 'node_B', // mismatch
        attemptId: 'attempt_1',
      });

      const stateToken = await mkSignedToken({ root, unsignedPrefix: 'st.v1.', payload: statePayload });
      const ackToken = await mkSignedToken({ root, unsignedPrefix: 'ack.v1.', payload: ackPayload });

      const res = await handleV2ContinueWorkflow({ stateToken, ackToken } as any, await dummyCtx());
      expect(res.type).toBe('error');
      if (res.type !== 'error') return;
      expect(res.code).toBe('TOKEN_SCOPE_MISMATCH');
      expect(res.message).toContain('nodeId mismatch');
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });
});
