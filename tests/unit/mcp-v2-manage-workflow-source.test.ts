import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { okAsync, errAsync } from 'neverthrow';
import { handleV2ManageWorkflowSource } from '../../src/mcp/handlers/v2-manage-workflow-source.js';
import type { ToolContext } from '../../src/mcp/types.js';
import { EnvironmentFeatureFlagProvider } from '../../src/config/feature-flags.js';
import { createTestValidationPipelineDeps } from '../helpers/v2-test-helpers.js';
import { LocalDataDirV2 } from '../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../src/v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../../src/v2/infra/local/sha256/index.js';
import { NodeCryptoV2 } from '../../src/v2/infra/local/crypto/index.js';
import { LocalSessionEventLogStoreV2 } from '../../src/v2/infra/local/session-store/index.js';
import { LocalSessionLockV2 } from '../../src/v2/infra/local/session-lock/index.js';
import { LocalSnapshotStoreV2 } from '../../src/v2/infra/local/snapshot-store/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../../src/v2/infra/local/pinned-workflow-store/index.js';
import { LocalKeyringV2 } from '../../src/v2/infra/local/keyring/index.js';
import { LocalManagedSourceStoreV2 } from '../../src/v2/infra/local/managed-source-store/index.js';
import { ExecutionSessionGateV2 } from '../../src/v2/usecases/execution-session-gate.js';
import { unsafeTokenCodecPorts } from '../../src/v2/durable-core/tokens/index.js';
import { InMemoryTokenAliasStoreV2 } from '../../src/v2/infra/in-memory/token-alias-store/index.js';
import { InMemoryManagedSourceStoreV2 } from '../../src/v2/infra/in-memory/managed-source-store/index.js';
import { NodeHmacSha256V2 } from '../../src/v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../../src/v2/infra/local/base64url/index.js';
import { NodeRandomEntropyV2 } from '../../src/v2/infra/local/random-entropy/index.js';
import { NodeTimeClockV2 } from '../../src/v2/infra/local/time-clock/index.js';
import { IdFactoryV2 } from '../../src/v2/infra/local/id-factory/index.js';
import { Bech32mAdapterV2 } from '../../src/v2/infra/local/bech32m/index.js';
import { Base32AdapterV2 } from '../../src/v2/infra/local/base32/index.js';
import type { SessionSummaryProviderPortV2 } from '../../src/v2/ports/session-summary-provider.port.js';
import type { ManagedSourceStorePortV2, ManagedSourceStoreError } from '../../src/v2/ports/managed-source-store.port.js';
import type { ResultAsync } from 'neverthrow';

async function mkTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function buildCtxWithManagedStore(
  dataRoot: string,
  managedSourceStore: ManagedSourceStorePortV2,
): Promise<ToolContext> {
  const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: dataRoot });
  const fsPort = new NodeFileSystemV2();
  const sha256 = new NodeSha256V2();
  const crypto = new NodeCryptoV2();
  const sessionStore = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256);
  const clock = new NodeTimeClockV2();
  const lockPort = new LocalSessionLockV2(dataDir, fsPort, clock);
  const gate = new ExecutionSessionGateV2(lockPort, sessionStore);
  const snapshotStore = new LocalSnapshotStoreV2(dataDir, fsPort, crypto);
  const pinnedStore = new LocalPinnedWorkflowStoreV2(dataDir, fsPort);
  const hmac = new NodeHmacSha256V2();
  const base64url = new NodeBase64UrlV2();
  const entropy = new NodeRandomEntropyV2();
  const idFactory = new IdFactoryV2(entropy);
  const base32 = new Base32AdapterV2();
  const bech32m = new Bech32mAdapterV2();
  const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);
  const keyringRes = await keyringPort.loadOrCreate();
  if (keyringRes.isErr()) throw new Error(`keyring load failed: ${keyringRes.error.code}`);

  const sessionSummaryProvider: SessionSummaryProviderPortV2 = {
    loadHealthySummaries: () => okAsync([]),
  };

  const tokenCodecPorts = unsafeTokenCodecPorts({
    keyring: keyringRes.value,
    hmac,
    base64url,
    base32,
    bech32m,
  });

  const ctx: ToolContext = {
    workflowService: {
      listWorkflowSummaries: async () => [],
      getWorkflowById: async () => null,
      getNextStep: async () => { throw new Error('not used'); },
      validateStepOutput: async () => ({ valid: true, issues: [], suggestions: [] }),
    } as any,
    featureFlags: EnvironmentFeatureFlagProvider.withEnv({}),
    sessionManager: null,
    httpServer: null,
    v2: {
      gate,
      sessionStore,
      snapshotStore,
      pinnedStore,
      sha256,
      crypto,
      entropy,
      idFactory,
      tokenCodecPorts,
      tokenAliasStore: new InMemoryTokenAliasStoreV2(),
      managedSourceStore,
      sessionSummaryProvider,
      validationPipelineDeps: createTestValidationPipelineDeps(),
      resolvedRootUris: [],
    },
  };

  return ctx;
}

describe('manage_workflow_source: attach', () => {
  it('attach succeeds and persists path to the local store', async () => {
    const dataRoot = await mkTempDir('workrail-mws-attach-data-');
    const workflowDir = await mkTempDir('workrail-mws-attach-dir-');
    const localStore = new LocalManagedSourceStoreV2(
      new LocalDataDirV2({ WORKRAIL_DATA_DIR: dataRoot }),
      new NodeFileSystemV2(),
    );
    const ctx = await buildCtxWithManagedStore(dataRoot, localStore);

    const result = await handleV2ManageWorkflowSource({ action: 'attach', path: workflowDir }, ctx);

    expect(result.type).toBe('success');
    const data = result.data as { action: string; path: string };
    expect(data.action).toBe('attach');
    expect(data.path).toBe(workflowDir);

    // Verify persistence: reload store and check the path is present
    const reloadedStore = new LocalManagedSourceStoreV2(
      new LocalDataDirV2({ WORKRAIL_DATA_DIR: dataRoot }),
      new NodeFileSystemV2(),
    );
    const listResult = await reloadedStore.list();
    expect(listResult.isOk()).toBe(true);
    const sources = listResult._unsafeUnwrap();
    expect(sources.map((s) => s.path)).toContain(path.resolve(workflowDir));
  });

  it('attach is idempotent: calling twice does not create a duplicate', async () => {
    const dataRoot = await mkTempDir('workrail-mws-idem-data-');
    const workflowDir = await mkTempDir('workrail-mws-idem-dir-');
    const localStore = new LocalManagedSourceStoreV2(
      new LocalDataDirV2({ WORKRAIL_DATA_DIR: dataRoot }),
      new NodeFileSystemV2(),
    );
    const ctx = await buildCtxWithManagedStore(dataRoot, localStore);

    const first = await handleV2ManageWorkflowSource({ action: 'attach', path: workflowDir }, ctx);
    const second = await handleV2ManageWorkflowSource({ action: 'attach', path: workflowDir }, ctx);

    expect(first.type).toBe('success');
    expect(second.type).toBe('success');

    const reloadedStore = new LocalManagedSourceStoreV2(
      new LocalDataDirV2({ WORKRAIL_DATA_DIR: dataRoot }),
      new NodeFileSystemV2(),
    );
    const listResult = await reloadedStore.list();
    expect(listResult.isOk()).toBe(true);
    const sources = listResult._unsafeUnwrap();
    const matchingPaths = sources.filter((s) => s.path === path.resolve(workflowDir));
    expect(matchingPaths.length).toBe(1);
  });

  it('attach idempotency via in-memory store: second attach succeeds and store has one entry', async () => {
    const dataRoot = await mkTempDir('workrail-mws-idem-inmem-data-');
    const store = new InMemoryManagedSourceStoreV2();
    const ctx = await buildCtxWithManagedStore(dataRoot, store);

    const workflowDir = '/abs/workflows/shared';
    const first = await handleV2ManageWorkflowSource({ action: 'attach', path: workflowDir }, ctx);
    const second = await handleV2ManageWorkflowSource({ action: 'attach', path: workflowDir }, ctx);

    expect(first.type).toBe('success');
    expect(second.type).toBe('success');
    expect((await store.list())._unsafeUnwrap()).toHaveLength(1);
  });
});

describe('manage_workflow_source: detach', () => {
  it('detach removes a previously attached path', async () => {
    const dataRoot = await mkTempDir('workrail-mws-detach-data-');
    const workflowDir = await mkTempDir('workrail-mws-detach-dir-');
    const localStore = new LocalManagedSourceStoreV2(
      new LocalDataDirV2({ WORKRAIL_DATA_DIR: dataRoot }),
      new NodeFileSystemV2(),
    );
    const ctx = await buildCtxWithManagedStore(dataRoot, localStore);

    // Attach first
    const attachResult = await handleV2ManageWorkflowSource({ action: 'attach', path: workflowDir }, ctx);
    expect(attachResult.type).toBe('success');

    // Then detach
    const detachResult = await handleV2ManageWorkflowSource({ action: 'detach', path: workflowDir }, ctx);
    expect(detachResult.type).toBe('success');
    const data = detachResult.data as { action: string; path: string };
    expect(data.action).toBe('detach');
    expect(data.path).toBe(workflowDir);

    // Verify the path is gone
    const reloadedStore = new LocalManagedSourceStoreV2(
      new LocalDataDirV2({ WORKRAIL_DATA_DIR: dataRoot }),
      new NodeFileSystemV2(),
    );
    const listResult = await reloadedStore.list();
    expect(listResult.isOk()).toBe(true);
    const sources = listResult._unsafeUnwrap();
    expect(sources.map((s) => s.path)).not.toContain(path.resolve(workflowDir));
  });

  it('detach is idempotent: detaching an absent path succeeds', async () => {
    const dataRoot = await mkTempDir('workrail-mws-detach-idem-data-');
    const workflowDir = await mkTempDir('workrail-mws-detach-idem-dir-');
    const localStore = new LocalManagedSourceStoreV2(
      new LocalDataDirV2({ WORKRAIL_DATA_DIR: dataRoot }),
      new NodeFileSystemV2(),
    );
    const ctx = await buildCtxWithManagedStore(dataRoot, localStore);

    // Detach a path that was never attached
    const result = await handleV2ManageWorkflowSource({ action: 'detach', path: workflowDir }, ctx);
    expect(result.type).toBe('success');
  });
});

describe('manage_workflow_source: error handling', () => {
  it('returns PRECONDITION_FAILED when managedSourceStore is absent from v2 dependencies', async () => {
    const dataRoot = await mkTempDir('workrail-mws-nostore-data-');
    const ctx = await buildCtxWithManagedStore(dataRoot, new InMemoryManagedSourceStoreV2());
    // Remove managedSourceStore from v2 to simulate missing wiring
    const ctxWithoutStore: ToolContext = {
      ...ctx,
      v2: { ...ctx.v2!, managedSourceStore: undefined },
    };

    const result = await handleV2ManageWorkflowSource(
      { action: 'attach', path: '/some/absolute/path' },
      ctxWithoutStore,
    );

    expect(result.type).toBe('error');
    expect((result as { code: string }).code).toBe('PRECONDITION_FAILED');
  });

  it('returns PRECONDITION_FAILED when v2 is null', async () => {
    const ctx: ToolContext = {
      workflowService: null as any,
      featureFlags: EnvironmentFeatureFlagProvider.withEnv({}),
      sessionManager: null,
      httpServer: null,
      v2: null,
    };

    const result = await handleV2ManageWorkflowSource(
      { action: 'attach', path: '/some/absolute/path' },
      ctx,
    );

    expect(result.type).toBe('error');
    expect((result as { code: string }).code).toBe('PRECONDITION_FAILED');
  });

  it('maps MANAGED_SOURCE_BUSY to retryable INTERNAL_ERROR', async () => {
    const busyStore: ManagedSourceStorePortV2 = {
      list: () => okAsync([]),
      attach: () => errAsync({
        code: 'MANAGED_SOURCE_BUSY',
        message: 'locked',
        retry: { kind: 'retryable_after_ms', afterMs: 250 },
        lockPath: '/tmp/managed-sources.lock',
      } as ManagedSourceStoreError),
      detach: () => okAsync(undefined),
    };
    const dataRoot = await mkTempDir('workrail-mws-busy-data-');
    const ctx = await buildCtxWithManagedStore(dataRoot, busyStore);

    const result = await handleV2ManageWorkflowSource(
      { action: 'attach', path: '/some/absolute/path' },
      ctx,
    );

    expect(result.type).toBe('error');
    const err = result as { code: string; retry: { kind: string; afterMs: number } };
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(err.retry.kind).toBe('retryable_after_ms');
    expect(err.retry.afterMs).toBe(250);
  });

  it('maps MANAGED_SOURCE_IO_ERROR to non-retryable INTERNAL_ERROR', async () => {
    const ioErrorStore: ManagedSourceStorePortV2 = {
      list: () => okAsync([]),
      attach: () => errAsync({
        code: 'MANAGED_SOURCE_IO_ERROR',
        message: 'disk full',
      } as ManagedSourceStoreError),
      detach: () => okAsync(undefined),
    };
    const dataRoot = await mkTempDir('workrail-mws-ioerr-data-');
    const ctx = await buildCtxWithManagedStore(dataRoot, ioErrorStore);

    const result = await handleV2ManageWorkflowSource(
      { action: 'attach', path: '/some/absolute/path' },
      ctx,
    );

    expect(result.type).toBe('error');
    const err = result as { code: string; retry: { kind: string } };
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(err.retry.kind).toBe('not_retryable');
  });

  it('maps MANAGED_SOURCE_CORRUPTION to non-retryable INTERNAL_ERROR', async () => {
    const corruptStore: ManagedSourceStorePortV2 = {
      list: () => okAsync([]),
      attach: () => errAsync({
        code: 'MANAGED_SOURCE_CORRUPTION',
        message: 'invalid JSON',
      } as ManagedSourceStoreError),
      detach: () => okAsync(undefined),
    };
    const dataRoot = await mkTempDir('workrail-mws-corrupt-data-');
    const ctx = await buildCtxWithManagedStore(dataRoot, corruptStore);

    const result = await handleV2ManageWorkflowSource(
      { action: 'attach', path: '/some/absolute/path' },
      ctx,
    );

    expect(result.type).toBe('error');
    const err = result as { code: string; retry: { kind: string } };
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(err.retry.kind).toBe('not_retryable');
  });
});

describe('manage_workflow_source: in-memory fake smoke tests', () => {
  it('in-memory store attach + list works correctly', async () => {
    const store = new InMemoryManagedSourceStoreV2();
    const attachRes = await store.attach('/abs/path/to/workflows');
    expect(attachRes.isOk()).toBe(true);

    const listRes = await store.list();
    expect(listRes.isOk()).toBe(true);
    const sources = listRes._unsafeUnwrap();
    expect(sources.map((s) => s.path)).toContain(path.resolve('/abs/path/to/workflows'));
  });

  it('in-memory store detach removes the path', async () => {
    const store = new InMemoryManagedSourceStoreV2();
    await store.attach('/abs/some/dir');
    await store.detach('/abs/some/dir');

    const listRes = await store.list();
    expect(listRes.isOk()).toBe(true);
    expect(listRes._unsafeUnwrap()).toHaveLength(0);
  });

  it('in-memory store idempotent attach does not duplicate', async () => {
    const store = new InMemoryManagedSourceStoreV2();
    await store.attach('/abs/dir');
    await store.attach('/abs/dir');

    const listRes = await store.list();
    expect(listRes.isOk()).toBe(true);
    expect(listRes._unsafeUnwrap()).toHaveLength(1);
  });

  it('in-memory store idempotent detach on absent path is no-op', async () => {
    const store = new InMemoryManagedSourceStoreV2();
    const res = await store.detach('/abs/never/attached');
    expect(res.isOk()).toBe(true);
  });
});
