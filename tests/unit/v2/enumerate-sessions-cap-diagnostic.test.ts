/**
 * Session Enumeration Cap Regression Test
 *
 * PURPOSE: Verify that resume_session finds recent sessions even when >50 sessions exist.
 *
 * Regression for bug: alphabetical sort + 50-session cap excluded recent sessions
 * whose IDs sorted after position 50. Now uses enumerateSessionsByRecency (mtime desc)
 * to ensure the cap retains the most relevant sessions.
 */
import { describe, it, expect } from 'vitest';
import { okAsync } from 'neverthrow';
import { enumerateSessions, enumerateSessionsByRecency } from '../../../src/v2/usecases/enumerate-sessions.js';
import type { DirectoryListingPortV2, DirEntryWithMtime } from '../../../src/v2/ports/directory-listing.port.js';
import type { DataDirPortV2 } from '../../../src/v2/ports/data-dir.port.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate N session IDs that are lexicographically ordered.
 * Uses hex chars to create predictable alphabetical ordering.
 */
function generateSessionIds(count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    // Pad with leading zeros for consistent sort: sess_0000, sess_0001, ...
    ids.push(`sess_${String(i).padStart(4, '0')}`);
  }
  return ids;
}

function fakePorts(entries: readonly string[]): { directoryListing: DirectoryListingPortV2; dataDir: DataDirPortV2 } {
  return {
    directoryListing: {
      readdir: () => okAsync(entries),
      readdirWithMtime: () => okAsync([]),
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
      readdir: () => okAsync(entries.map(e => e.name)),
      readdirWithMtime: () => okAsync(entries),
    },
    dataDir: {
      sessionsDir: () => '/fake/sessions',
      segmentDir: () => '/fake/segments',
      cacheDir: () => '/fake/cache',
    } as DataDirPortV2,
  };
}

// ---------------------------------------------------------------------------
// Diagnostic Tests
// ---------------------------------------------------------------------------

describe('Session enumeration cap regression', () => {
  it('with 60 sessions sorted alphabetically, sessions after position 50 are returned (no cap in enumerate)', async () => {
    // enumerateSessions does NOT cap — it returns ALL sessions sorted.
    // The cap happens in LocalSessionSummaryProviderV2.loadHealthySummaries().
    const ids = generateSessionIds(60);
    const ports = fakePorts(ids);
    const result = await enumerateSessions(ports);

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    // enumerateSessions returns ALL 60 — no cap here
    expect(result.value).toHaveLength(60);
    expect(result.value.map(String)).toContain('sess_0055'); // position 56 (0-indexed 55)
  });

  it('the cap is applied by LocalSessionSummaryProviderV2, not enumerateSessions', async () => {
    // Verify: enumerateSessions returns all, then .slice(0, 50) is applied by the provider
    const ids = generateSessionIds(60);
    const ports = fakePorts(ids);
    const result = await enumerateSessions(ports);

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    // Simulate the cap that loadHealthySummaries applies
    const capped = result.value.slice(0, 50);
    expect(capped).toHaveLength(50);

    // Target session at position 55 is EXCLUDED
    expect(capped.map(String)).not.toContain('sess_0055');

    // But it IS in the full list
    expect(result.value.map(String)).toContain('sess_0055');
  });

  it('[REGRESSION] reproduced original bug: alphabetical sort excluded recent session at position >50', async () => {
    // Create a mix: 181 random-looking IDs + the actual E1 session ID
    // The E1 session ID: sess_dlzozumq6yypgv6lfspxxr7oq4
    const fakeIds: string[] = [];
    // Generate IDs that sort before "d" (a, b, c prefix)
    for (let i = 0; i < 60; i++) fakeIds.push(`sess_a${String(i).padStart(10, '0')}`);
    for (let i = 0; i < 60; i++) fakeIds.push(`sess_b${String(i).padStart(10, '0')}`);
    for (let i = 0; i < 60; i++) fakeIds.push(`sess_c${String(i).padStart(10, '0')}`);

    // Add the real E1 session ID (starts with 'd')
    fakeIds.push('sess_dlzozumq6yypgv6lfspxxr7oq4');

    const ports = fakePorts(fakeIds);
    const result = await enumerateSessions(ports);

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    // All 181 returned from enumerate
    expect(result.value).toHaveLength(181);

    // Find E1's position
    const sorted = result.value.map(String);
    const e1Position = sorted.indexOf('sess_dlzozumq6yypgv6lfspxxr7oq4');
    console.log(`[H1 EVIDENCE] E1 session position in sorted list: ${e1Position + 1} of ${sorted.length}`);

    // E1 is at position > 50 (180 IDs before 'd' prefix)
    expect(e1Position).toBeGreaterThanOrEqual(50);

    // After the provider's cap:
    const capped = sorted.slice(0, 50);
    expect(capped).not.toContain('sess_dlzozumq6yypgv6lfspxxr7oq4');

    console.log(`[REGRESSION] Alphabetical sort places E1 at position ${e1Position + 1} outside cap`);
  });

  it('[FIX] enumerateSessionsByRecency includes recent sessions even when >50 exist', async () => {
    // 60 sessions with seq IDs for alphabetical ordering
    // sess_0001 through sess_0060
    // Give sess_0060 (alphabetically last) the newest mtime
    const entries: DirEntryWithMtime[] = [];
    for (let i = 1; i <= 60; i++) {
      entries.push({
        name: `sess_${String(i).padStart(4, '0')}`,
        mtimeMs: i === 60 ? 99999 : i, // sess_0060 is newest despite sorting last
      });
    }

    const ports = fakePortsWithMtime(entries);
    const result = await enumerateSessionsByRecency(ports);

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value).toHaveLength(60);
    // sess_0060 should be first (newest mtime)
    expect(String(result.value[0])).toBe('sess_0060');

    // After provider cap at 50:
    const capped = result.value.slice(0, 50);
    // sess_0060 IS in the capped list (it's first)
    expect(capped.map(String)).toContain('sess_0060');

    console.log('[FIX VERIFIED] Most recent session (sess_0060) is first despite alphabetically last');
  });

  it('[FIX REAL DATA] with recency sort, sess_dlzozumq would be included if it were most recent', async () => {
    // Simulate: 181 sessions, give E1 the newest mtime
    const fakeIds: string[] = [];
    for (let i = 0; i < 60; i++) fakeIds.push(`sess_a${String(i).padStart(10, '0')}`);
    for (let i = 0; i < 60; i++) fakeIds.push(`sess_b${String(i).padStart(10, '0')}`);
    for (let i = 0; i < 60; i++) fakeIds.push(`sess_c${String(i).padStart(10, '0')}`);
    fakeIds.push('sess_dlzozumq6yypgv6lfspxxr7oq4'); // alphabetically late

    const entries: DirEntryWithMtime[] = fakeIds.map((name, idx) => ({
      name,
      mtimeMs: name === 'sess_dlzozumq6yypgv6lfspxxr7oq4' ? 999999 : idx,
    }));

    const ports = fakePortsWithMtime(entries);
    const result = await enumerateSessionsByRecency(ports);

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const sorted = result.value.map(String);
    // E1 should be first (newest mtime)
    expect(sorted[0]).toBe('sess_dlzozumq6yypgv6lfspxxr7oq4');

    // After cap at 50:
    const capped = sorted.slice(0, 50);
    expect(capped).toContain('sess_dlzozumq6yypgv6lfspxxr7oq4');

    console.log('[FIX VERIFIED] E1 session now included despite alphabetically late position');
  });
});
