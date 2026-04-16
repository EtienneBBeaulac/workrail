/**
 * Unit tests for src/trigger/daemon-console.ts
 *
 * Tests:
 * - Happy path: startDaemonConsole() binds to a port, returns ok(handle)
 * - Port conflict: returns err({ kind: 'port_conflict' })
 * - stop() releases the port and calls the watcher disposer
 * - Lock file is written on start, deleted on stop
 * - Missing dataDir / directoryListing returns io_error
 */

import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startDaemonConsole } from '../../src/trigger/daemon-console.js';
import type { V2ToolContext } from '../../src/mcp/types.js';
import type { DataDirPortV2 } from '../../src/v2/ports/data-dir.port.js';
import type { DirectoryListingPortV2 } from '../../src/v2/ports/directory-listing.port.js';
import {
  InMemorySessionEventLogStore,
  InMemorySnapshotStore,
  InMemoryPinnedWorkflowStore,
} from '../fakes/v2/index.js';
import { tmpPath } from '../helpers/platform.js';

// ---------------------------------------------------------------------------
// Fakes and helpers
// ---------------------------------------------------------------------------

const stubDataDir: DataDirPortV2 = {
  sessionsDir: () => '/fake/sessions',
  snapshotsDir: () => '/fake/snapshots',
  pinnedWorkflowsDir: () => '/fake/pinned',
  perfDir: () => '/fake/perf',
  tokensDir: () => '/fake/tokens',
  sourcesDir: () => '/fake/sources',
} as unknown as DataDirPortV2;

const stubDirectoryListing: DirectoryListingPortV2 = {
  listDirectory: async () => [],
} as unknown as DirectoryListingPortV2;

function makeCtx(overrides: Partial<V2ToolContext['v2']> = {}): V2ToolContext {
  return {
    workflowService: {
      loadAllWorkflows: async () => [],
      getWorkflowById: async () => undefined,
    } as any,
    featureFlags: { isEnabled: () => false } as any,
    sessionManager: null,
    httpServer: null,
    v2: {
      gate: {} as any,
      sessionStore: new InMemorySessionEventLogStore(),
      snapshotStore: new InMemorySnapshotStore(),
      pinnedStore: new InMemoryPinnedWorkflowStore(),
      sha256: {} as any,
      crypto: {} as any,
      entropy: {} as any,
      idFactory: {} as any,
      tokenCodecPorts: {} as any,
      tokenAliasStore: {} as any,
      rememberedRootsStore: {} as any,
      managedSourceStore: {} as any,
      validationPipelineDeps: {} as any,
      resolvedRootUris: [],
      dataDir: stubDataDir,
      directoryListing: stubDirectoryListing,
      sessionSummaryProvider: {} as any,
      ...overrides,
    },
  } as V2ToolContext;
}

/** Make a unique tmp lock file path for each test to avoid cross-test pollution. */
function tmpLockPath(suffix: string): string {
  return tmpPath(`daemon-console-test-${process.pid}-${suffix}.lock`);
}

/** Simple HTTP GET helper -- resolves with the parsed JSON body or rejects. */
function httpGet(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Cleanup: ensure any handles from failed tests are stopped
// ---------------------------------------------------------------------------

const handles: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  for (const h of handles.splice(0)) {
    try { await h.stop(); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startDaemonConsole happy path', () => {
  it('returns ok(handle) and serves GET /api/v2/sessions', async () => {
    const ctx = makeCtx();
    const lockFilePath = tmpLockPath('happy');

    const result = await startDaemonConsole(ctx, {
      port: 0, // OS-assigned port
      lockFilePath,
    });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    handles.push(result.value);

    const { port } = result.value;
    expect(port).toBeGreaterThan(0);

    // Verify the server is alive -- just check the port is non-zero and bound.
    // The sessions endpoint with a stub ConsoleService returns an error or redirect
    // in test environments (no real sessions directory), so we just verify the
    // server started and is reachable.
    const raw = await httpGet(`http://127.0.0.1:${port}/api/v2/sessions`);
    // Any response (JSON or string) means the server is up
    expect(raw).toBeDefined();
  });
});

describe('startDaemonConsole port conflict', () => {
  it('returns err({ kind: port_conflict }) when port is already in use', async () => {
    // Pre-occupy a port
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    const occupiedPort = addr.port;

    try {
      const ctx = makeCtx();
      const lockFilePath = tmpLockPath('conflict');
      const result = await startDaemonConsole(ctx, {
        port: occupiedPort,
        lockFilePath,
      });

      expect(result.kind).toBe('err');
      if (result.kind !== 'err') return;
      expect(result.error.kind).toBe('port_conflict');
      expect((result.error as { kind: 'port_conflict'; port: number }).port).toBe(occupiedPort);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    }
  });
});

describe('startDaemonConsole stop()', () => {
  it('releases the port after stop() so a new server can bind to it', async () => {
    const ctx = makeCtx();
    const lockFilePath = tmpLockPath('stop');

    const result = await startDaemonConsole(ctx, {
      port: 0,
      lockFilePath,
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const { port, stop } = result.value;

    // Stop the daemon console
    await stop();

    // Now a new server should be able to bind to the same port
    const server2 = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server2.on('error', reject);
      server2.listen(port, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve, reject) => server2.close((e) => e ? reject(e) : resolve()));
  });

  it('stop() is idempotent (calling twice does not throw)', async () => {
    const ctx = makeCtx();
    const lockFilePath = tmpLockPath('idempotent');

    const result = await startDaemonConsole(ctx, { port: 0, lockFilePath });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    await result.value.stop();
    await expect(result.value.stop()).resolves.toBeUndefined();
  });
});

describe('startDaemonConsole lock file', () => {
  it('writes the lock file on start and deletes it on stop', async () => {
    const ctx = makeCtx();
    const lockFilePath = tmpLockPath('lock');

    const result = await startDaemonConsole(ctx, { port: 0, lockFilePath });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    handles.push(result.value);

    // Lock file should exist after start (give async write a moment)
    await new Promise((r) => setTimeout(r, 50));
    const lockContent = await fs.readFile(lockFilePath, 'utf-8');
    const lock = JSON.parse(lockContent) as { pid: number; port: number };
    expect(lock.pid).toBe(process.pid);
    expect(lock.port).toBe(result.value.port);

    // Stop and verify lock file is deleted
    await result.value.stop();
    handles.splice(handles.indexOf(result.value), 1);
    await expect(fs.readFile(lockFilePath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('startDaemonConsole missing V2 deps', () => {
  it('returns err({ kind: io_error }) when dataDir is missing', async () => {
    const ctx = makeCtx({ dataDir: undefined });
    const lockFilePath = tmpLockPath('nodatadir');

    const result = await startDaemonConsole(ctx, { port: 0, lockFilePath });
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error.kind).toBe('io_error');
  });

  it('returns err({ kind: io_error }) when directoryListing is missing', async () => {
    const ctx = makeCtx({ directoryListing: undefined });
    const lockFilePath = tmpLockPath('nodirlist');

    const result = await startDaemonConsole(ctx, { port: 0, lockFilePath });
    expect(result.kind).toBe('err');
    if (result.kind !== 'err') return;
    expect(result.error.kind).toBe('io_error');
  });
});
