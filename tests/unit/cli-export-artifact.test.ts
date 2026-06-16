import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as cp from 'child_process';
import { okAsync } from 'neverthrow';

import { executeWorktrainExportArtifactCommand } from '../../src/cli/commands/worktrain-export-artifact.js';
import { handleV2StartWorkflow } from '../../src/mcp/handlers/v2-execution/index.js';
import { setupIntegrationTest, teardownIntegrationTest, resolveService } from '../di/integration-container.js';
import { DI } from '../../src/di/tokens.js';
import type { ToolContext } from '../../src/mcp/types.js';
import { InMemoryWorkflowStorage } from '../../src/infrastructure/storage/in-memory-storage.js';

import { LocalDataDirV2 } from '../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../src/v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../../src/v2/infra/local/sha256/index.js';
import { LocalSessionEventLogStoreV2 } from '../../src/v2/infra/local/session-store/index.js';
import { NodeCryptoV2 } from '../../src/v2/infra/local/crypto/index.js';
import { NodeHmacSha256V2 } from '../../src/v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../../src/v2/infra/local/base64url/index.js';
import { LocalSessionLockV2 } from '../../src/v2/infra/local/session-lock/index.js';
import { LocalSnapshotStoreV2 } from '../../src/v2/infra/local/snapshot-store/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../../src/v2/infra/local/pinned-workflow-store/index.js';
import { ExecutionSessionGateV2 } from '../../src/v2/usecases/execution-session-gate.js';
import { LocalKeyringV2 } from '../../src/v2/infra/local/keyring/index.js';
import { NodeRandomEntropyV2 } from '../../src/v2/infra/local/random-entropy/index.js';
import { NodeTimeClockV2 } from '../../src/v2/infra/local/time-clock/index.js';
import { IdFactoryV2 } from '../../src/v2/infra/local/id-factory/index.js';
import { Bech32mAdapterV2 } from '../../src/v2/infra/local/bech32m/index.js';
import { Base32AdapterV2 } from '../../src/v2/infra/local/base32/index.js';
import { unsafeTokenCodecPorts } from '../../src/v2/durable-core/tokens/index.js';
import { parseShortTokenNative } from '../../src/v2/durable-core/tokens/short-token.js';
import { InMemoryTokenAliasStoreV2 } from '../../src/v2/infra/in-memory/token-alias-store/index.js';
import type { TokenAliasStorePortV2 } from '../../src/v2/ports/token-alias-store.port.js';
import { createTestValidationPipelineDeps } from '../helpers/v2-test-helpers.js';

// Spy/mock child_process.execFile
const mockExecFile = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<any>('child_process');
  return {
    ...actual,
    execFile: (file: string, args: string[], options: any, callback: any) => {
      mockExecFile(file, args, options, callback);
      const cb = typeof callback === 'function' ? callback : typeof options === 'function' ? options : null;
      if (cb) {
        cb(null, { stdout: 'mocked success', stderr: '' });
      }
    },
  };
});

function resolveSessionIdFromToken(token: string, aliasStore: TokenAliasStorePortV2): string {
  const parsed = parseShortTokenNative(token);
  if (!parsed) throw new Error(`Short token parse failed for: ${token}`);
  const entry = aliasStore.lookup(parsed.nonceHex);
  if (!entry) throw new Error(`No alias found for token nonce: ${parsed.nonceHex}`);
  return entry.sessionId;
}

async function mkV2Deps(workspaceRoot?: string) {
  const dataDir = new LocalDataDirV2(process.env);
  const fsPort = new NodeFileSystemV2();
  const sha256 = new NodeSha256V2();
  const crypto = new NodeCryptoV2();
  const hmac = new NodeHmacSha256V2();
  const base64url = new NodeBase64UrlV2();
  const entropy = new NodeRandomEntropyV2();
  const idFactory = new IdFactoryV2(entropy);
  const base32 = new Base32AdapterV2();
  const bech32m = new Bech32mAdapterV2();
  const clock = new NodeTimeClockV2();
  const sessionStore = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256);
  const lockPort = new LocalSessionLockV2(dataDir, fsPort, clock);
  const gate = new ExecutionSessionGateV2(lockPort, sessionStore);
  const snapshotStore = new LocalSnapshotStoreV2(dataDir, fsPort, crypto);
  const pinnedStore = new LocalPinnedWorkflowStoreV2(dataDir, fsPort);
  const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);
  const keyring = await keyringPort.loadOrCreate().match(v => v, e => { throw new Error(`keyring: ${e.code}`); });
  const tokenCodecPorts = unsafeTokenCodecPorts({ keyring, hmac, base64url, base32, bech32m });
  const tokenAliasStore = new InMemoryTokenAliasStoreV2();
  const workspaceResolver = {
    resolve: () => {
      if (workspaceRoot) {
        return okAsync([
          { key: 'repo_root' as const, value: workspaceRoot },
          { key: 'repo_root_hash' as const, value: 'test-hash' }
        ] as const);
      }
      return okAsync([] as const);
    }
  };
  return { gate, sessionStore, snapshotStore, pinnedStore, sha256, crypto, idFactory, entropy, tokenCodecPorts, tokenAliasStore, workspaceResolver, validationPipelineDeps: createTestValidationPipelineDeps() };
}

describe('worktrain export-artifact CLI command', () => {
  let root: string;
  let prevDataDir: string | undefined;
  let ctx: ToolContext;
  let sessionId: string;

  beforeEach(async () => {
    mockExecFile.mockClear();

    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workrail-cli-export-')));
    prevDataDir = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;

    await setupIntegrationTest({
      storage: new InMemoryWorkflowStorage([
        {
          id: 'export-test',
          name: 'Export Test',
          description: 'A test workflow',
          version: '1.0.0',
          steps: [{ id: 'step-1', title: 'Step 1', prompt: 'Do step 1' }],
        } as any,
      ]),
      disableSessionTools: true,
    });

    const workflowService = resolveService<any>(DI.Services.Workflow);
    const featureFlags = resolveService<any>(DI.Infra.FeatureFlags);
    const v2 = await mkV2Deps(root);
    ctx = { workflowService, featureFlags, sessionManager: null, httpServer: null, v2 };

    const start = await handleV2StartWorkflow({ workflowId: 'export-test', workspacePath: root, goal: 'test export' } as any, ctx);
    if (start.type !== 'success') throw new Error('Start failed');
    sessionId = resolveSessionIdFromToken((start.data as any).continueToken, v2.tokenAliasStore);
  });

  afterEach(() => {
    teardownIntegrationTest();
    process.env.WORKRAIL_DATA_DIR = prevDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('stages shadow artifacts in git successfully (happy path)', async () => {
    // Write fake shadow artifact
    const shadowDir = path.join(root, '.workrail', 'artifacts', sessionId);
    fs.mkdirSync(shadowDir, { recursive: true });
    fs.writeFileSync(path.join(shadowDir, 'doc.md'), 'hello world', 'utf8');

    // Run export command
    const res = await executeWorktrainExportArtifactCommand({
      sessionId,
      artifactName: 'doc.md',
    });

    expect(res.kind).toBe('success');
    expect(res.output?.message).toContain('Successfully exported artifact');

    // Ensure it was copied to the workspace root
    const destFile = path.join(root, 'doc.md');
    expect(fs.existsSync(destFile)).toBe(true);
    expect(fs.readFileSync(destFile, 'utf8')).toBe('hello world');

    // Verify git add was called
    expect(mockExecFile).toHaveBeenCalled();
    const gitCall = mockExecFile.mock.calls.find(call => call[0] === 'git' && call[1] && call[1][0] === 'add');
    expect(gitCall).toBeDefined();
    expect(gitCall[1]).toEqual(['add', destFile]);
  });

  it('rejects path traversal attempts outside workspace', async () => {
    const shadowDir = path.join(root, '.workrail', 'artifacts', sessionId);
    fs.mkdirSync(shadowDir, { recursive: true });
    fs.writeFileSync(path.join(shadowDir, 'doc.md'), 'hello world', 'utf8');

    // Attempt to export to a relative path outside workspace
    const res = await executeWorktrainExportArtifactCommand({
      sessionId,
      artifactName: 'doc.md',
      destPath: '../../outside.md',
    });

    expect(res.kind).toBe('failure');
    expect(res.output.message).toContain('Security violation: destination path validation failed');
  });

  it('rejects symlink segments in the path', async () => {
    const shadowDir = path.join(root, '.workrail', 'artifacts', sessionId);
    fs.mkdirSync(shadowDir, { recursive: true });
    fs.writeFileSync(path.join(shadowDir, 'doc.md'), 'hello world', 'utf8');

    // Create a symlinked directory inside workspace pointing to another inner directory
    const innerDir = path.join(root, 'inner-dir');
    fs.mkdirSync(innerDir, { recursive: true });
    const linkDir = path.join(root, 'symlink-dir');
    fs.symlinkSync(innerDir, linkDir);

    const res = await executeWorktrainExportArtifactCommand({
      sessionId,
      artifactName: 'doc.md',
      destPath: 'symlink-dir/doc.md',
    });

    expect(res.kind).toBe('failure');
    expect(res.output.message).toContain('Security violation: destination path validation failed');
    expect(res.output.message).toContain('symbolic link');
  });

  it('retries on git index lock collisions', async () => {
    const shadowDir = path.join(root, '.workrail', 'artifacts', sessionId);
    fs.mkdirSync(shadowDir, { recursive: true });
    fs.writeFileSync(path.join(shadowDir, 'doc.md'), 'hello world', 'utf8');

    // Mock git add to fail with lock collision 3 times, then succeed
    let callCount = 0;
    mockExecFile.mockImplementation((file: string, args: string[], options: any, callback: any) => {
      const cb = typeof callback === 'function' ? callback : typeof options === 'function' ? options : null;
      if (file === 'git' && args[0] === 'add') {
        callCount++;
        if (callCount < 4) {
          const err = new Error('Another git process seems to be running');
          (err as any).stderr = 'fatal: Unable to create \'/fake/.git/index.lock\': File exists.';
          cb(err);
          return;
        }
      }
      cb(null, { stdout: 'mocked success', stderr: '' });
    });

    const res = await executeWorktrainExportArtifactCommand({
      sessionId,
      artifactName: 'doc.md',
    });

    expect(res.kind).toBe('success');
    expect(callCount).toBe(4);
  });

  it('rejects sibling directories that share a prefix with the root (prefix startsWith bypass check)', async () => {
    const parentDir = path.dirname(root);
    const siblingDir = path.join(parentDir, path.basename(root) + '_malicious');
    fs.mkdirSync(siblingDir, { recursive: true });

    const targetFileOutside = path.join(siblingDir, 'hack.md');

    const shadowDir = path.join(root, '.workrail', 'artifacts', sessionId);
    fs.mkdirSync(shadowDir, { recursive: true });
    fs.writeFileSync(path.join(shadowDir, 'doc.md'), 'hello world', 'utf8');

    const res = await executeWorktrainExportArtifactCommand({
      sessionId,
      artifactName: 'doc.md',
      destPath: targetFileOutside,
    });

    expect(res.kind).toBe('failure');
    expect(res.output.message).toContain('Security violation: destination path validation failed');

    fs.rmSync(siblingDir, { recursive: true, force: true });
  });

  it('handles case-insensitive root matching correctly without walking past root', async () => {
    const rootCased = root.toLowerCase() === root ? root.toUpperCase() : root.toLowerCase();
    
    const shadowDir = path.join(root, '.workrail', 'artifacts', sessionId);
    fs.mkdirSync(shadowDir, { recursive: true });
    fs.writeFileSync(path.join(shadowDir, 'doc.md'), 'hello world', 'utf8');

    const destWithCasing = path.join(rootCased, 'doc.md');

    const res = await executeWorktrainExportArtifactCommand({
      sessionId,
      artifactName: 'doc.md',
      destPath: destWithCasing,
    });

    expect(res.kind).toBe('success');
  });
});
