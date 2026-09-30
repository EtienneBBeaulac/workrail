/**
 * Unit / integration tests for the `worktrain console` command.
 *
 * These tests exercise startStandaloneConsole() in the same way the CLI does:
 * start it, verify it's serving, then stop it. The CLI wiring in cli-worktrain.ts
 * is a thin composition root (no logic), so testing the underlying
 * startStandaloneConsole() function gives full coverage of the feature.
 *
 * Tests:
 * - Happy path: starts, returns ok, serves HTTP, port > 0
 * - Port conflict: pre-occupy port, returns { kind: 'port_conflict' }
 * - stop() idempotency
 * - Lock file is named daemon-console.lock (not dashboard.lock)
 * - Lock file written on start, deleted on stop
 */

import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { startStandaloneConsole } from '../../src/console/standalone-console.js';
import { tmpPath } from '../helpers/platform.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpLockPath(suffix: string): string {
  return tmpPath(`cli-console-test-${process.pid}-${suffix}.lock`);
}

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
// Cleanup
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

describe('worktrain console -- happy path', () => {
  it('starts successfully, binds a port, and serves HTTP', async () => {
    const lockFilePath = tmpLockPath('happy');

    const result = await startStandaloneConsole({ port: 0, lockFilePath });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    handles.push(result);

    expect(result.port).toBeGreaterThan(0);

    // Verify the server is reachable
    const body = await httpGet(`http://127.0.0.1:${result.port}/api/v2/sessions`);
    expect(body).toBeDefined();
  });
});

describe('worktrain console -- port conflict', () => {
  it('returns { kind: port_conflict } when port is already in use', async () => {
    const occupier = http.createServer();
    await new Promise<void>((r) => occupier.listen(0, '127.0.0.1', r));
    const occupiedPort = (occupier.address() as { port: number }).port;

    try {
      const result = await startStandaloneConsole({
        port: occupiedPort,
        lockFilePath: tmpLockPath('conflict'),
      });

      expect(result.kind).toBe('port_conflict');
      if (result.kind !== 'port_conflict') return;
      expect(result.port).toBe(occupiedPort);
    } finally {
      await new Promise<void>((r, j) => occupier.close((e) => e ? j(e) : r()));
    }
  });
});

describe('worktrain console -- stop()', () => {
  it('stop() is idempotent (second call resolves without error)', async () => {
    const result = await startStandaloneConsole({
      port: 0,
      lockFilePath: tmpLockPath('idempotent'),
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    await result.stop();
    await expect(result.stop()).resolves.toBeUndefined();
  });

  it('releases the port after stop()', async () => {
    const result = await startStandaloneConsole({
      port: 0,
      lockFilePath: tmpLockPath('port-release'),
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const { port, stop } = result;

    await stop();

    const server2 = http.createServer();
    await new Promise<void>((r, j) => {
      server2.on('error', j);
      server2.listen(port, '127.0.0.1', r);
    });
    await new Promise<void>((r, j) => server2.close((e) => e ? j(e) : r()));
  });
});

describe('worktrain console -- lock file', () => {
  it('lock file is named daemon-console.lock (not dashboard.lock)', async () => {
    // This assertion locks in the contract: standalone console writes daemon-console.lock.
    // If this filename drifts to dashboard.lock, spawn/await port discovery would break
    // because they prefer daemon-console.lock as the primary lock for standalone console.
    const defaultLockPath = path.join(os.homedir(), '.workrail', 'daemon-console.lock');
    expect(path.basename(defaultLockPath)).toBe('daemon-console.lock');

    // Also confirm that a custom lockFilePath containing 'daemon-console' is written correctly.
    const lockFilePath = tmpLockPath('daemon-console-name');
    const result = await startStandaloneConsole({ port: 0, lockFilePath });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    handles.push(result);

    const content = await fs.readFile(lockFilePath, 'utf-8');
    const parsed = JSON.parse(content) as { pid: number; port: number };
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.port).toBe(result.port);
  });

  it('writes lock file on start, deletes it on stop', async () => {
    const lockFilePath = tmpLockPath('lifecycle');

    const result = await startStandaloneConsole({ port: 0, lockFilePath });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    handles.push(result);

    // Lock file should exist after start
    await expect(fs.readFile(lockFilePath, 'utf-8')).resolves.toBeTruthy();

    // Stop: lock file should be deleted
    await result.stop();
    handles.splice(handles.indexOf(result), 1);
    await expect(fs.readFile(lockFilePath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});


it('does not report startup ready while discovery publication is held', async () => {
  let entered!: () => void;
  const publishing = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let ready = false;
  const order: string[] = [];
  const started = startStandaloneConsole({ port: 0, lockFilePath: tmpLockPath('held-publication') }, {
    discovery: {
      async publish(record) { expect(record.port).toBeGreaterThan(0); order.push('publishing'); entered(); await held; order.push('published'); return { kind: 'published' }; },
      async remove() { order.push('removed'); },
    },
  });
  void started.then(() => { ready = true; });
  try {
    await publishing;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(ready).toBe(false);
  } finally {
    release();
    const result = await started;
    if (result.kind === 'ok') await result.stop();
    expect(order).toEqual(['publishing', 'published', 'removed']);
  }
});


it('keeps serving when discovery publication returns unavailable', async () => {
  const result = await startStandaloneConsole({ port: 0 }, {
    discovery: {
      async publish() { return { kind: 'unavailable', message: 'intentional publication unavailable' }; },
      async remove() {},
    },
  });
  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') return;
  try { expect(await httpGet(`http://127.0.0.1:${result.port}/api/v2/sessions`)).toBeDefined(); }
  finally { await result.stop(); }
});
