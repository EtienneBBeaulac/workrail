/**
 * Session Enumeration Tests
 *
 * Tests for enumerating session IDs from the data directory.
 */
import { describe, it, expect } from 'vitest';
import { okAsync, errAsync } from 'neverthrow';
import { enumerateSessions } from '../../../src/v2/usecases/enumerate-sessions.js';
import type { DirectoryListingPortV2 } from '../../../src/v2/ports/directory-listing.port.js';
import type { DataDirPortV2 } from '../../../src/v2/ports/data-dir.port.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakePorts(entries: readonly string[]): { directoryListing: DirectoryListingPortV2; dataDir: DataDirPortV2 } {
  return {
    directoryListing: {
      readdir: (_dirPath: string) => okAsync(entries),
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
