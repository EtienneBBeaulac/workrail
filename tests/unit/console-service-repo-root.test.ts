/**
 * Tests for repoRoot extraction in ConsoleService.getSessionList().
 *
 * repoRoot: derived from observation_recorded event with key === 'repo_root'.
 * Durable -- comes from the event log (written by LocalWorkspaceAnchorV2 at
 * session start). Null when no such observation has been recorded.
 *
 * This field is required by the console frontend's joinSessionsAndWorktrees()
 * to group sessions by repo when no matching worktree is available (standalone
 * console fallback).
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
import type { DomainEventV1 } from '../../src/v2/durable-core/schemas/session/index.js';
import type { SessionEventLogReadonlyStorePortV2 } from '../../src/v2/ports/session-event-log-store.port.js';
import type { SessionId } from '../../src/v2/durable-core/ids/index.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeDirectoryListing(entries: readonly DirEntryWithMtime[]): DirectoryListingPortV2 {
  return {
    readdir: () => okAsync([]),
    readdirWithMtime: () => okAsync(entries),
  };
}

const stubDataDir = { sessionsDir: () => '/fake/sessions' } as unknown as DataDirPortV2;

function makeServiceWithStore(
  sessionId: string,
  store: SessionEventLogReadonlyStorePortV2,
): ConsoleService {
  return new ConsoleService({
    directoryListing: makeDirectoryListing([{ name: sessionId, mtimeMs: Date.now() }]),
    dataDir: stubDataDir,
    sessionStore: store,
    snapshotStore: new InMemorySnapshotStore(),
    pinnedWorkflowStore: new InMemoryPinnedWorkflowStore(),
  });
}

function makeObservationEvent(
  sessionId: string,
  key: string,
  value: string,
  eventIndex: number,
): DomainEventV1 {
  return {
    v: 1,
    eventId: `evt_obs_${eventIndex}`,
    eventIndex,
    sessionId: sessionId as SessionId,
    kind: 'observation_recorded',
    dedupeKey: `observation_recorded:${sessionId}:${key}`,
    data: {
      confidence: 'high',
      key,
      value: { type: 'short_string', value },
    },
  } as DomainEventV1;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConsoleService repoRoot', () => {
  it('is null when no observation_recorded events are present', async () => {
    const sessionId = 'sess_repo001aaaaaaaaaaaaaaa';
    const store: SessionEventLogReadonlyStorePortV2 = {
      load: (_id) => okAsync({ events: [], manifest: [] }),
      loadValidatedPrefix: (_id) => okAsync({ kind: 'complete', truth: { events: [], manifest: [] } }),
    };

    const service = makeServiceWithStore(sessionId, store);
    const result = await service.getSessionList();
    expect(result.isOk()).toBe(true);

    const sessions = result._unsafeUnwrap().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.repoRoot).toBeNull();
  });

  it('is null when observation events exist but none have key repo_root', async () => {
    const sessionId = 'sess_repo002aaaaaaaaaaaaaaa';
    const events: DomainEventV1[] = [
      makeObservationEvent(sessionId, 'git_branch', 'main', 0),
      makeObservationEvent(sessionId, 'git_head_sha', 'abc123', 1),
    ];
    const store: SessionEventLogReadonlyStorePortV2 = {
      load: (_id) => okAsync({ events, manifest: [] }),
      loadValidatedPrefix: (_id) => okAsync({ kind: 'complete', truth: { events, manifest: [] } }),
    };

    const service = makeServiceWithStore(sessionId, store);
    const result = await service.getSessionList();
    expect(result.isOk()).toBe(true);

    const sessions = result._unsafeUnwrap().sessions;
    expect(sessions[0]!.repoRoot).toBeNull();
  });

  it('returns the repo_root value from observation_recorded event', async () => {
    const sessionId = 'sess_repo003aaaaaaaaaaaaaaa';
    const repoRootPath = '/Users/user/git/myproject';
    const events: DomainEventV1[] = [
      makeObservationEvent(sessionId, 'repo_root_hash', 'sha256:abc', 0),
      makeObservationEvent(sessionId, 'repo_root', repoRootPath, 1),
      makeObservationEvent(sessionId, 'git_branch', 'feature/my-branch', 2),
    ];
    const store: SessionEventLogReadonlyStorePortV2 = {
      load: (_id) => okAsync({ events, manifest: [] }),
      loadValidatedPrefix: (_id) => okAsync({ kind: 'complete', truth: { events, manifest: [] } }),
    };

    const service = makeServiceWithStore(sessionId, store);
    const result = await service.getSessionList();
    expect(result.isOk()).toBe(true);

    const sessions = result._unsafeUnwrap().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.repoRoot).toBe(repoRootPath);
  });

  it('returns the first repo_root observation when multiple exist', async () => {
    const sessionId = 'sess_repo004aaaaaaaaaaaaaaa';
    const firstPath = '/Users/user/git/first';
    const secondPath = '/Users/user/git/second';
    const events: DomainEventV1[] = [
      makeObservationEvent(sessionId, 'repo_root', firstPath, 0),
      makeObservationEvent(sessionId, 'repo_root', secondPath, 1),
    ];
    const store: SessionEventLogReadonlyStorePortV2 = {
      load: (_id) => okAsync({ events, manifest: [] }),
      loadValidatedPrefix: (_id) => okAsync({ kind: 'complete', truth: { events, manifest: [] } }),
    };

    const service = makeServiceWithStore(sessionId, store);
    const result = await service.getSessionList();
    expect(result.isOk()).toBe(true);

    const sessions = result._unsafeUnwrap().sessions;
    // First occurrence wins -- consistent with extractGitBranch behavior
    expect(sessions[0]!.repoRoot).toBe(firstPath);
  });
});
