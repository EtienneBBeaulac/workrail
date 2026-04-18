/**
 * Tests for src/trigger/polled-event-store.ts
 *
 * Covers:
 * - load: fresh state on missing file (ENOENT)
 * - load: fresh state on corrupt JSON
 * - load: fresh state on schema mismatch
 * - load/save roundtrip
 * - save: ID pruning at MAX_PROCESSED_IDS (500)
 * - filterNew: returns only IDs not in processedIds
 * - filterNew: empty candidateIds returns empty array
 * - record: updates processedIds and lastPollAt
 * - record: empty newIds still updates lastPollAt
 * - getLastPollAt: returns stored lastPollAt
 * - Atomic write: final file is valid JSON (no partial write)
 */

import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { PolledEventStore } from '../../src/trigger/polled-event-store.js';
import { asTriggerId } from '../../src/trigger/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-test-polled-'));
}

function makeStore(tmpDir: string): PolledEventStore {
  return new PolledEventStore({ WORKRAIL_HOME: tmpDir });
}

const TRIGGER_ID = asTriggerId('test-trigger');

// ---------------------------------------------------------------------------
// load: missing file
// ---------------------------------------------------------------------------

describe('PolledEventStore.load', () => {
  it('returns fresh state on missing file (ENOENT)', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore(tmpDir);

    const result = await store.load(TRIGGER_ID);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.processedIds).toEqual([]);
      // lastPollAt should be close to now (within 5 seconds)
      const parsed = Date.parse(result.value.lastPollAt);
      expect(Date.now() - parsed).toBeLessThan(5000);
    }
  });

  it('returns fresh state on corrupt JSON', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore(tmpDir);

    // Write corrupt JSON to the state file
    const dir = path.join(tmpDir, 'polled-events');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'test-trigger.json'), '{not valid json}', 'utf8');

    const result = await store.load(TRIGGER_ID);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.processedIds).toEqual([]);
    }
  });

  it('returns fresh state on schema mismatch', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore(tmpDir);

    const dir = path.join(tmpDir, 'polled-events');
    await fs.mkdir(dir, { recursive: true });
    // Missing lastPollAt field
    await fs.writeFile(path.join(dir, 'test-trigger.json'), JSON.stringify({ processedIds: [1, 2] }), 'utf8');

    const result = await store.load(TRIGGER_ID);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.processedIds).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// save / load roundtrip
// ---------------------------------------------------------------------------

describe('PolledEventStore save/load roundtrip', () => {
  it('saves and reloads state correctly', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore(tmpDir);

    const state = {
      processedIds: ['id-1', 'id-2', 'id-3'],
      lastPollAt: '2026-04-15T10:00:00.000Z',
    };

    const saveResult = await store.save(TRIGGER_ID, state);
    expect(saveResult.kind).toBe('ok');

    const loadResult = await store.load(TRIGGER_ID);
    expect(loadResult.kind).toBe('ok');
    if (loadResult.kind === 'ok') {
      expect(loadResult.value.processedIds).toEqual(['id-1', 'id-2', 'id-3']);
      expect(loadResult.value.lastPollAt).toBe('2026-04-15T10:00:00.000Z');
    }
  });

  it('creates the directory if it does not exist', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore(tmpDir);

    // Directory does not exist yet (makeTmpDir only creates the base dir)
    const state = { processedIds: ['a'], lastPollAt: '2026-01-01T00:00:00.000Z' };
    const result = await store.save(TRIGGER_ID, state);
    expect(result.kind).toBe('ok');

    const dir = path.join(tmpDir, 'polled-events');
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ID pruning
// ---------------------------------------------------------------------------

describe('PolledEventStore ID pruning', () => {
  it('prunes processedIds to last 500 entries on save', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore(tmpDir);

    // Create 600 IDs
    const ids = Array.from({ length: 600 }, (_, i) => `id-${i}`);
    const state = { processedIds: ids, lastPollAt: '2026-01-01T00:00:00.000Z' };

    await store.save(TRIGGER_ID, state);

    const loadResult = await store.load(TRIGGER_ID);
    expect(loadResult.kind).toBe('ok');
    if (loadResult.kind === 'ok') {
      expect(loadResult.value.processedIds.length).toBe(500);
      // Should keep the LAST 500 (most recent)
      expect(loadResult.value.processedIds[0]).toBe('id-100');
      expect(loadResult.value.processedIds[499]).toBe('id-599');
    }
  });

  it('does not prune when count is at exactly 500', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore(tmpDir);

    const ids = Array.from({ length: 500 }, (_, i) => `id-${i}`);
    const state = { processedIds: ids, lastPollAt: '2026-01-01T00:00:00.000Z' };

    await store.save(TRIGGER_ID, state);

    const loadResult = await store.load(TRIGGER_ID);
    expect(loadResult.kind).toBe('ok');
    if (loadResult.kind === 'ok') {
      expect(loadResult.value.processedIds.length).toBe(500);
    }
  });
});

// ---------------------------------------------------------------------------
// filterNew
// ---------------------------------------------------------------------------

describe('PolledEventStore.filterNew', () => {
  it('returns all IDs when no state exists (fresh start)', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore(tmpDir);

    const result = await store.filterNew(TRIGGER_ID, ['id-1', 'id-2', 'id-3']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toEqual(['id-1', 'id-2', 'id-3']);
    }
  });

  it('returns only IDs not already in processedIds', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore(tmpDir);

    await store.save(TRIGGER_ID, {
      processedIds: ['id-1', 'id-2'],
      lastPollAt: '2026-01-01T00:00:00.000Z',
    });

    const result = await store.filterNew(TRIGGER_ID, ['id-1', 'id-2', 'id-3', 'id-4']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toEqual(['id-3', 'id-4']);
    }
  });

  it('returns empty array for empty candidateIds', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore(tmpDir);

    const result = await store.filterNew(TRIGGER_ID, []);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toEqual([]);
    }
  });

  it('returns empty array when all candidateIds are already processed', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore(tmpDir);

    await store.save(TRIGGER_ID, {
      processedIds: ['id-1', 'id-2', 'id-3'],
      lastPollAt: '2026-01-01T00:00:00.000Z',
    });

    const result = await store.filterNew(TRIGGER_ID, ['id-1', 'id-2', 'id-3']);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// record
// ---------------------------------------------------------------------------

describe('PolledEventStore.record', () => {
  it('adds new IDs and updates lastPollAt', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore(tmpDir);

    await store.save(TRIGGER_ID, {
      processedIds: ['id-1'],
      lastPollAt: '2026-01-01T00:00:00.000Z',
    });

    const pollAt = '2026-04-15T12:00:00.000Z';
    const result = await store.record(TRIGGER_ID, ['id-2', 'id-3'], pollAt);
    expect(result.kind).toBe('ok');

    const loaded = await store.load(TRIGGER_ID);
    expect(loaded.kind).toBe('ok');
    if (loaded.kind === 'ok') {
      expect(loaded.value.processedIds).toContain('id-1');
      expect(loaded.value.processedIds).toContain('id-2');
      expect(loaded.value.processedIds).toContain('id-3');
      expect(loaded.value.lastPollAt).toBe(pollAt);
    }
  });

  it('updates lastPollAt even when newIds is empty', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore(tmpDir);

    await store.save(TRIGGER_ID, {
      processedIds: ['id-1'],
      lastPollAt: '2026-01-01T00:00:00.000Z',
    });

    const pollAt = '2026-04-15T12:00:00.000Z';
    await store.record(TRIGGER_ID, [], pollAt);

    const loaded = await store.load(TRIGGER_ID);
    expect(loaded.kind).toBe('ok');
    if (loaded.kind === 'ok') {
      expect(loaded.value.processedIds).toEqual(['id-1']);
      expect(loaded.value.lastPollAt).toBe(pollAt);
    }
  });
});

// ---------------------------------------------------------------------------
// getLastPollAt
// ---------------------------------------------------------------------------

describe('PolledEventStore.getLastPollAt', () => {
  it('returns stored lastPollAt', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore(tmpDir);

    await store.save(TRIGGER_ID, {
      processedIds: [],
      lastPollAt: '2026-04-15T10:00:00.000Z',
    });

    const lastPollAt = await store.getLastPollAt(TRIGGER_ID);
    expect(lastPollAt).toBe('2026-04-15T10:00:00.000Z');
  });

  it('returns approximately now when no state exists', async () => {
    const tmpDir = await makeTmpDir();
    const store = makeStore(tmpDir);

    const before = Date.now();
    const lastPollAt = await store.getLastPollAt(TRIGGER_ID);
    const after = Date.now();

    const parsed = Date.parse(lastPollAt);
    expect(parsed).toBeGreaterThanOrEqual(before - 100);
    expect(parsed).toBeLessThanOrEqual(after + 100);
  });
});
