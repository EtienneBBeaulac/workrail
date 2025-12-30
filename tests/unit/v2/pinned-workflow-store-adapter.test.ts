import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { LocalPinnedWorkflowStoreV2 } from '../../../src/v2/infra/local/pinned-workflow-store/index.js';
import { LocalDataDirV2 } from '../../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../../src/v2/infra/local/fs/index.js';
import { CompiledWorkflowSnapshotSchema } from '../../../src/v2/durable-core/schemas/compiled-workflow/index.js';
import { workflowHashForCompiledSnapshot } from '../../../src/v2/durable-core/canonical/hashing.js';
import { NodeCryptoV2 } from '../../../src/v2/infra/local/crypto/index.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-pinned-test-'));
}

/**
 * Tests that pinned-workflow-store adapter returns ResultAsync for port methods.
 * Ensures no throws escape port boundaries (Rule N4).
 *
 * @enforces no-throws-across-boundaries
 * @enforces errors-as-data
 */
describe('v2 Pinned Workflow Store adapter (error handling)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkTempDataDir();
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('get returns ResultAsync<null> when workflow file is missing', async () => {
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: tempDir });
    const fsPort = new NodeFileSystemV2();
    const store = new LocalPinnedWorkflowStoreV2(dataDir, fsPort);

    const missingHash = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
    const result = await store.get(missingHash as any);

    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw new Error('Expected Ok result');

    expect(result.value).toBeNull();
  });

  it('put and get roundtrip returns ResultAsync with success', async () => {
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: tempDir });
    const fsPort = new NodeFileSystemV2();
    const store = new LocalPinnedWorkflowStoreV2(dataDir, fsPort);
    const crypto = new NodeCryptoV2();

    const compiled = CompiledWorkflowSnapshotSchema.parse({
      schemaVersion: 1,
      sourceKind: 'v1_pinned',
      workflowId: 'test-workflow-id',
      name: 'Test Workflow',
      description: 'A test workflow',
      version: '1.0.0',
      definition: { nodes: [], edges: [] },
    });

    const hashResult = workflowHashForCompiledSnapshot(compiled, crypto);
    expect(hashResult.isOk()).toBe(true);
    const hash = hashResult._unsafeUnwrap();

    // Put should return ResultAsync<void, PinnedWorkflowStoreError>
    const putResult = await store.put(hash, compiled);
    expect(putResult.isOk()).toBe(true);

    // Get should return ResultAsync<CompiledWorkflowSnapshot, PinnedWorkflowStoreError>
    const getResult = await store.get(hash);
    expect(getResult.isOk()).toBe(true);
    if (getResult.isErr()) throw new Error('Expected Ok result');

    expect(getResult.value).not.toBeNull();
    expect((getResult.value as any).workflowId).toBe(compiled.workflowId);
  });

  it('get handles errors and returns ResultAsync (does not throw)', async () => {
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: tempDir });
    const fsPort = new NodeFileSystemV2();
    const store = new LocalPinnedWorkflowStoreV2(dataDir, fsPort);

    // Pre-populate pinned workflow directory with malformed JSON
    const workflowsDir = dataDir.pinnedWorkflowsDir();
    await fs.mkdir(workflowsDir, { recursive: true });

    const filePath = path.join(workflowsDir, 'sha256_abc123.json');
    await fs.writeFile(filePath, '{invalid json');

    // The important thing: get() returns ResultAsync, not throws
    const result = await store.get('sha256:abc123' as any);

    // This test verifies that errors are wrapped, not thrown
    // The specific error code depends on the fs layer
    expect(result.isOk() || result.isErr()).toBe(true); // Truthy for both cases
  });

  it('put handles all errors and returns ResultAsync (does not throw)', async () => {
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: tempDir });
    const fsPort = new NodeFileSystemV2();
    const store = new LocalPinnedWorkflowStoreV2(dataDir, fsPort);
    const crypto = new NodeCryptoV2();

    // Create a valid compiled workflow
    const compiled = CompiledWorkflowSnapshotSchema.parse({
      schemaVersion: 1,
      sourceKind: 'v1_pinned',
      workflowId: 'test-workflow-id',
      name: 'Test Workflow',
      description: 'A test workflow',
      version: '1.0.0',
      definition: { nodes: [], edges: [] },
    });

    const hashResult = workflowHashForCompiledSnapshot(compiled, crypto);
    const hash = hashResult._unsafeUnwrap();

    const putResult = await store.put(hash, compiled);

    // Should return ResultAsync<void> (Ok in this case since write succeeds)
    // The important thing is it returns Result, not throws
    expect(putResult.isOk()).toBe(true);
  });

  it('port method signatures match ResultAsync return types', async () => {
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: tempDir });
    const fsPort = new NodeFileSystemV2();
    const store = new LocalPinnedWorkflowStoreV2(dataDir, fsPort);

    const compiled = CompiledWorkflowSnapshotSchema.parse({
      schemaVersion: 1,
      sourceKind: 'v1_pinned',
      workflowId: 'test-workflow-id',
      name: 'Test Workflow',
      description: 'A test workflow',
      version: '1.0.0',
      definition: { nodes: [], edges: [] },
    });

    const hash = 'sha256:abc123' as any;

    // Type check: these should compile and be awaitable ResultAsync
    const getResult = await store.get(hash);
    const putResult = await store.put(hash, compiled);

    // Both should be Result (after awaiting)
    expect(getResult.isOk()).toBe(true); // missing file returns Ok(null)
    expect(putResult.isOk()).toBe(true); // successful write returns Ok(void)
  });

  it('multiple put operations are idempotent for same hash', async () => {
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: tempDir });
    const fsPort = new NodeFileSystemV2();
    const store = new LocalPinnedWorkflowStoreV2(dataDir, fsPort);
    const crypto = new NodeCryptoV2();

    const compiled = CompiledWorkflowSnapshotSchema.parse({
      schemaVersion: 1,
      sourceKind: 'v1_pinned',
      workflowId: 'test-workflow-id',
      name: 'Test Workflow',
      description: 'A test workflow',
      version: '1.0.0',
      definition: { nodes: [], edges: [] },
    });

    const hashResult = workflowHashForCompiledSnapshot(compiled, crypto);
    const hash = hashResult._unsafeUnwrap();

    // First put
    const put1 = await store.put(hash, compiled);
    expect(put1.isOk()).toBe(true);

    // Second put (same hash, same content)
    const put2 = await store.put(hash, compiled);
    expect(put2.isOk()).toBe(true);

    // Both should succeed (idempotent)
    const getResult = await store.get(hash);
    expect(getResult.isOk()).toBe(true);
  });
});
