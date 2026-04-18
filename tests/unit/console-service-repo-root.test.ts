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

// ---------------------------------------------------------------------------
// Tests: workspacePath fallback (F1)
// ---------------------------------------------------------------------------

/** Build a minimal context_set event for testing workspacePath fallback. */
function makeContextSetWithWorkspacePath(
  sessionId: string,
  runId: string,
  workspacePath: string,
  source: 'initial' | 'agent_delta',
  eventIndex: number,
): DomainEventV1 {
  return {
    v: 1,
    eventId: `evt_ctx_wp_${eventIndex}`,
    eventIndex,
    sessionId: sessionId as SessionId,
    kind: 'context_set',
    dedupeKey: `context_set:${sessionId}:${runId}:wp-${eventIndex}`,
    scope: { runId },
    data: {
      contextId: `ctx_wp_${eventIndex}`,
      context: { workspacePath },
      source,
    },
  } as DomainEventV1;
}

describe('ConsoleService repoRoot workspacePath fallback', () => {
  it('returns workspacePath from initial context_set when no repo_root observation exists', async () => {
    const sessionId = 'sess_repo005aaaaaaaaaaaaaaa';
    const workspacePath = '/foo';
    const events: DomainEventV1[] = [
      makeContextSetWithWorkspacePath(sessionId, 'run_wp_01', workspacePath, 'initial', 0),
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
    // workspacePath from initial context_set is used as fallback when no repo_root observation exists
    expect(sessions[0]!.repoRoot).toBe(workspacePath);
  });

  it('returns repo_root observation over workspacePath fallback when both present', async () => {
    const sessionId = 'sess_repo006aaaaaaaaaaaaaaa';
    const workspacePath = '/foo';
    const repoRoot = '/bar';
    const events: DomainEventV1[] = [
      makeContextSetWithWorkspacePath(sessionId, 'run_wp_02', workspacePath, 'initial', 0),
      makeObservationEvent(sessionId, 'repo_root', repoRoot, 1),
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
    // observation_recorded repo_root wins over workspacePath fallback
    expect(sessions[0]!.repoRoot).toBe(repoRoot);
  });

  it('returns null when context_set source is agent_delta (not initial)', async () => {
    const sessionId = 'sess_repo007aaaaaaaaaaaaaaa';
    const workspacePath = '/foo';
    const events: DomainEventV1[] = [
      makeContextSetWithWorkspacePath(sessionId, 'run_wp_03', workspacePath, 'agent_delta', 0),
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
    // agent_delta context_set events are excluded from the workspacePath fallback
    expect(sessions[0]!.repoRoot).toBeNull();
  });
});
