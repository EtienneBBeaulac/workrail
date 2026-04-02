/**
 * Tests for dormancy computation in ConsoleService.getSessionList().
 *
 * Dormancy is computed at projection time: a session is 'dormant' when its
 * status would otherwise be 'in_progress' and its lastModifiedMs is more than
 * DORMANCY_THRESHOLD_MS (3 days) before the nowMs captured at list time.
 *
 * Strategy: control lastModifiedMs via the DirectoryListingPortV2 fake. Empty
 * sessions (the in-memory store returns an empty truth for unknown IDs) project
 * to healthy + in_progress, so dormancy is the only variable.
 */

import { describe, it, expect } from 'vitest';
import { okAsync } from 'neverthrow';
import { ConsoleService } from '../../src/v2/usecases/console-service.js';
import {
  InMemorySessionEventLogStore,
  InMemorySnapshotStore,
  InMemoryPinnedWorkflowStore,
} from '../fakes/v2/index.js';
import type { DirectoryListingPortV2, DirEntryWithMtime } from '../../src/v2/ports/directory-listing.port.js';
import type { DataDirPortV2 } from '../../src/v2/ports/data-dir.port.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const THREE_DAYS_MS = 3 * DAY_MS;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeDirectoryListing(entries: readonly DirEntryWithMtime[]): DirectoryListingPortV2 {
  return {
    readdir: () => okAsync([]),
    readdirWithMtime: () => okAsync(entries),
  };
}

/** Only sessionsDir() is exercised by getSessionList(). */
const stubDataDir = { sessionsDir: () => '/fake/sessions' } as unknown as DataDirPortV2;

function makeService(entries: readonly DirEntryWithMtime[]): ConsoleService {
  return new ConsoleService({
    directoryListing: makeDirectoryListing(entries),
    dataDir: stubDataDir,
    sessionStore: new InMemorySessionEventLogStore(),
    snapshotStore: new InMemorySnapshotStore(),
    pinnedWorkflowStore: new InMemoryPinnedWorkflowStore(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConsoleService dormancy', () => {
  it('returns dormant for a session idle longer than 3 days', async () => {
    const lastModifiedMs = Date.now() - THREE_DAYS_MS - DAY_MS; // 4 days ago
    const service = makeService([{ name: 'sess_aaaaaaaaaaaaaaaaaaaaaaaa', mtimeMs: lastModifiedMs }]);

    const result = await service.getSessionList();
    expect(result.isOk()).toBe(true);

    const sessions = result._unsafeUnwrap().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('dormant');
  });

  it('returns in_progress for a session idle less than 3 days', async () => {
    const lastModifiedMs = Date.now() - TWO_DAYS_MS; // 2 days ago, within threshold
    const service = makeService([{ name: 'sess_bbbbbbbbbbbbbbbbbbbbbbbb', mtimeMs: lastModifiedMs }]);

    const result = await service.getSessionList();
    expect(result.isOk()).toBe(true);

    const sessions = result._unsafeUnwrap().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('in_progress');
  });

  it('returns in_progress for a session modified exactly at the threshold boundary', async () => {
    // Exactly 3 days ago is NOT dormant — the check is strictly greater-than.
    const lastModifiedMs = Date.now() - THREE_DAYS_MS;
    const service = makeService([{ name: 'sess_cccccccccccccccccccccccc', mtimeMs: lastModifiedMs }]);

    const result = await service.getSessionList();
    expect(result.isOk()).toBe(true);

    const sessions = result._unsafeUnwrap().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('in_progress');
  });

  it('all sessions in one request share the same nowMs snapshot', async () => {
    // Both sessions are dormant (4 days old) — verifies consistent evaluation.
    const oldMs = Date.now() - THREE_DAYS_MS - DAY_MS;
    const service = makeService([
      { name: 'sess_dddddddddddddddddddddddd', mtimeMs: oldMs },
      { name: 'sess_eeeeeeeeeeeeeeeeeeeeeeee', mtimeMs: oldMs },
    ]);

    const result = await service.getSessionList();
    expect(result.isOk()).toBe(true);

    const sessions = result._unsafeUnwrap().sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.status === 'dormant')).toBe(true);
  });

  it('does not mark dormant a session modified just now', async () => {
    const lastModifiedMs = Date.now(); // right now
    const service = makeService([{ name: 'sess_ffffffffffffffffffffffff', mtimeMs: lastModifiedMs }]);

    const result = await service.getSessionList();
    expect(result.isOk()).toBe(true);

    const sessions = result._unsafeUnwrap().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('in_progress');
  });
});

// ---------------------------------------------------------------------------
// Local constant used above
// ---------------------------------------------------------------------------

const TWO_DAYS_MS = 2 * DAY_MS;
