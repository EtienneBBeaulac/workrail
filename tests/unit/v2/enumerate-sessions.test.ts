/**
 * Session Enumeration Tests
 *
 * Tests for enumerating session IDs from the data directory.
 */
import { describe, it, expect } from 'vitest';
import { okAsync, errAsync } from 'neverthrow';
import { enumerateSessions, enumerateSessionsByRecency } from '../../../src/v2/usecases/enumerate-sessions.js';
import type { DirectoryListingPortV2, DirEntryWithMtime } from '../../../src/v2/ports/directory-listing.port.js';
import type { DataDirPortV2 } from '../../../src/v2/ports/data-dir.port.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakePorts(entries: readonly string[]): { directoryListing: DirectoryListingPortV2; dataDir: DataDirPortV2 } {
  return {
    directoryListing: {
      readdir: (_dirPath: string) => okAsync(entries),
      readdirWithMtime: (_dirPath: string) => okAsync([]),
    },
    dataDir: {
      sessionsDir: () => '/fake/sessions',
      segmentDir: () => '/fake/segments',
      cacheDir: () => '/fake/cache',
    } as DataDirPortV2,
  };
}

function fakePortsWithMtime(entries: readonly DirEntryWithMtime[]): { directoryListing: DirectoryListingPortV2; dataDir: DataDirPortV2 } {
  return {
    directoryListing: {
      readdir: (_dirPath: string) => okAsync(entries.map(e => e.name)),
      readdirWithMtime: (_dirPath: string) => okAsync(entries),
    },
    dataDir: {
      sessionsDir: () => '/fake/sessions',
      segmentDir: () => '/fake/segments',
      cacheDir: () => '/fake/cache',
    } as DataDirPortV2,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enumerateSessions', () => {
  it('returns session IDs matching the sess_ prefix', async () => {
    const ports = fakePorts(['sess_abc123', 'sess_def456', 'not-a-session', '.hidden']);
    const result = await enumerateSessions(ports);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value).toEqual([
      expect.stringContaining('sess_abc123'),
      expect.stringContaining('sess_def456'),
    ]);
  });

  it('returns empty array when no sessions exist', async () => {
    const ports = fakePorts([]);
    const result = await enumerateSessions(ports);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value).toEqual([]);
  });

  it('returns sorted session IDs', async () => {
    const ports = fakePorts(['sess_zzz', 'sess_aaa', 'sess_mmm']);
    const result = await enumerateSessions(ports);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    const ids = result.value.map(String);
    expect(ids).toEqual([...ids].sort());
  });

  it('propagates readdir errors', async () => {
    const ports = {
      directoryListing: {
        readdir: () => errAsync({ code: 'ENOENT' as const, message: 'Not found', path: '/fake' }),
        readdirWithMtime: () => errAsync({ code: 'ENOENT' as const, message: 'Not found', path: '/fake' }),
      },
      dataDir: {
        sessionsDir: () => '/fake/sessions',
        segmentDir: () => '/fake/segments',
        cacheDir: () => '/fake/cache',
      } as DataDirPortV2,
    };
    const result = await enumerateSessions(ports);
    expect(result.isErr()).toBe(true);
  });
});

describe('enumerateSessionsByRecency', () => {
  it('sorts sessions by mtime descending (most recent first)', async () => {
    const entries: DirEntryWithMtime[] = [
      { name: 'sess_aaa', mtimeMs: 1000 }, // oldest
      { name: 'sess_zzz', mtimeMs: 3000 }, // newest
      { name: 'sess_mmm', mtimeMs: 2000 }, // middle
    ];
    const ports = fakePortsWithMtime(entries);
    const result = await enumerateSessionsByRecency(ports);

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const ids = result.value.map(String);
    // Most recent first
    expect(ids).toEqual(['sess_zzz', 'sess_mmm', 'sess_aaa']);
  });

  it('tie-breaks by session ID alphabetically when mtime is equal', async () => {
    const entries: DirEntryWithMtime[] = [
      { name: 'sess_zzz', mtimeMs: 1000 },
      { name: 'sess_aaa', mtimeMs: 1000 }, // same mtime
      { name: 'sess_mmm', mtimeMs: 1000 }, // same mtime
    ];
    const ports = fakePortsWithMtime(entries);
    const result = await enumerateSessionsByRecency(ports);

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const ids = result.value.map(String);
    // All same mtime → alphabetical
    expect(ids).toEqual(['sess_aaa', 'sess_mmm', 'sess_zzz']);
  });

  it('filters non-session entries', async () => {
    const entries: DirEntryWithMtime[] = [
      { name: 'sess_valid', mtimeMs: 1000 },
      { name: 'not-a-session', mtimeMs: 2000 },
      { name: '.hidden', mtimeMs: 3000 },
    ];
    const ports = fakePortsWithMtime(entries);
    const result = await enumerateSessionsByRecency(ports);

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.map(String)).toEqual(['sess_valid']);
  });

  it('returns empty array when no sessions exist', async () => {
    const ports = fakePortsWithMtime([]);
    const result = await enumerateSessionsByRecency(ports);

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value).toEqual([]);
  });

  it('with >50 sessions sorted by recency, the most recent is first even if it sorts last alphabetically', async () => {
    // Generate 60 sessions: sess_0001 through sess_0060 (alphabetical)
    // Give sess_0060 the newest mtime — it should be first despite sorting last alphabetically
    const entries: DirEntryWithMtime[] = [];
    for (let i = 1; i <= 60; i++) {
      entries.push({
        name: `sess_${String(i).padStart(4, '0')}`,
        mtimeMs: i === 60 ? 99999 : i, // sess_0060 is newest
      });
    }

    const ports = fakePortsWithMtime(entries);
    const result = await enumerateSessionsByRecency(ports);

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value).toHaveLength(60);
    // Most recent first (mtimeMs=99999), even though it's alphabetically last
    expect(String(result.value[0])).toBe('sess_0060');
  });
});
