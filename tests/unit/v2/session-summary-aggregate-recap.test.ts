/**
 * Session Summary Provider — Aggregate Recap Tests
 *
 * Verifies that extractAggregateRecap (via the summary provider) walks
 * ancestor nodes to build a searchable recap snippet, not just the tip node.
 *
 * Key scenario: a session stopped mid-workflow with the tip (pending step)
 * having no outputs yet — all outputs are on completed ancestor nodes.
 */
import { describe, it, expect } from 'vitest';
import { LocalSessionSummaryProviderV2 } from '../../../src/v2/infra/local/session-summary-provider/index.js';
import type { SessionId } from '../../../src/v2/durable-core/ids/index.js';
import type { DataDirPortV2 } from '../../../src/v2/ports/data-dir.port.js';
import type { DirectoryListingPortV2 } from '../../../src/v2/ports/directory-listing.port.js';
import type { SessionEventLogReadonlyStorePortV2 } from '../../../src/v2/ports/session-event-log-store.port.js';
import type { LoadedSessionTruthV2 } from '../../../src/v2/ports/session-event-log-store.port.js';
import { okAsync } from 'neverthrow';
import { asSessionId } from '../../../src/v2/durable-core/ids/index.js';

// ---------------------------------------------------------------------------
// Minimal event builders
// ---------------------------------------------------------------------------

/**
 * Build a minimal but valid event list for a linear workflow chain.
 * Returns events with strictly incrementing eventIndex values.
 *
 * chain: array of { nodeId, parentNodeId, outputMarkdown? }
 * First entry is the root (parentNodeId must be null).
 * Last entry is the tip (the pending step).
 */
/** Valid SHA256 digest for test events. */
const TEST_WORKFLOW_HASH = 'sha256:' + 'a'.repeat(64);

function buildLinearChain(
  sessionId: string,
  runId: string,
  workflowId: string,
  chain: Array<{ nodeId: string; parentNodeId: string | null; outputMarkdown?: string }>,
): unknown[] {
  const events: unknown[] = [];
  let idx = 0;

  const mk = (kind: string, scope: object, data: object, dedupeKey: string) => ({
    kind,
    eventId: `evt_${kind}_${idx}`,
    eventIndex: idx++,
    sessionId,
    v: 1,
    scope,
    data,
    dedupeKey,
  });

  events.push(mk('session_created', {}, {}, `session_created:${sessionId}`));
  events.push(mk('run_started', { runId }, { workflowId, workflowHash: TEST_WORKFLOW_HASH }, `run_started:${sessionId}:${runId}`));

  for (const entry of chain) {
    events.push(mk(
      'node_created',
      { runId, nodeId: entry.nodeId },
      { nodeKind: 'step', parentNodeId: entry.parentNodeId, workflowHash: TEST_WORKFLOW_HASH, snapshotRef: 'snap_1' },
      `node_created:${sessionId}:${entry.nodeId}`,
    ));

    if (entry.parentNodeId !== null) {
      events.push(mk(
        'edge_created',
        { runId },
        {
          fromNodeId: entry.parentNodeId,
          toNodeId: entry.nodeId,
          edgeKind: 'acked_step',
          cause: { kind: 'advance_recorded', eventId: `evt_cause_${idx}` },
        },
        `edge_created:${sessionId}:${entry.parentNodeId}:${entry.nodeId}`,
      ));
    }

    if (entry.outputMarkdown) {
      const outputId = `out_${entry.nodeId}`;
      events.push(mk(
        'node_output_appended',
        { runId, nodeId: entry.nodeId },
        { outputId, outputChannel: 'recap', payload: { payloadKind: 'notes', notesMarkdown: entry.outputMarkdown } },
        `node_output_appended:${sessionId}:${outputId}`,
      ));
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildProvider(sessionId: string, events: unknown[]) {
  const mockStore: SessionEventLogReadonlyStorePortV2 = {
    load: (_id: SessionId) => okAsync({ sessionId: asSessionId(sessionId), events: events as any } as LoadedSessionTruthV2),
  };

  // DirectoryListingPortV2 has readdir(dirPath) and readdirWithMtime(dirPath)
  const mockDirectoryListing: DirectoryListingPortV2 = {
    readdir: (_dirPath: string) => okAsync([sessionId]),
    readdirWithMtime: (_dirPath: string) => okAsync([{ name: sessionId, mtimeMs: Date.now() }]),
  };

  // DataDirPortV2 — only sessionsDir() and sessionDir() are needed for enumeration
  const mockDataDir: DataDirPortV2 = {
    sessionsDir: () => '/fake/sessions',
    sessionDir: (_id: SessionId) => `/fake/sessions/${String(_id)}`,
    sessionEventsDir: (_id: SessionId) => `/fake/sessions/${String(_id)}/events`,
    sessionManifestPath: (_id: SessionId) => `/fake/sessions/${String(_id)}/manifest.jsonl`,
    sessionLockPath: (_id: SessionId) => `/fake/sessions/${String(_id)}/lock`,
    pinnedWorkflowsDir: () => '/fake/workflows',
    pinnedWorkflowPath: (_hash) => `/fake/workflows/${String(_hash)}.json`,
    snapshotsDir: () => '/fake/snapshots',
    snapshotPath: (_ref) => `/fake/snapshots/${String(_ref)}`,
    keysDir: () => '/fake/keys',
    keyringPath: () => '/fake/keys/keyring.json',
  };

  return new LocalSessionSummaryProviderV2({
    sessionStore: mockStore,
    directoryListing: mockDirectoryListing,
    dataDir: mockDataDir,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('session-summary-provider: aggregate recap from ancestor nodes', () => {
  it('finds recap from a completed ancestor when the tip node has no outputs', async () => {
    const sessionId = 'sess_test_aggregate_recap_01';
    const runId = 'run_test_01';

    // Chain: root(no output) → step1(ALPHA output) → tip(no output, pending)
    const events = buildLinearChain(sessionId, runId, 'test-workflow', [
      { nodeId: 'node_root', parentNodeId: null },
      { nodeId: 'node_step1', parentNodeId: 'node_root', outputMarkdown: 'UNIQUE_MARKER_ALPHA completed' },
      { nodeId: 'node_tip', parentNodeId: 'node_step1' }, // pending, no output
    ]);

    const provider = buildProvider(sessionId, events);
    const result = await provider.loadHealthySummaries();

    expect(result.isOk()).toBe(true);
    const summaries = result._unsafeUnwrap();
    expect(summaries).toHaveLength(1);

    // The recap snippet should include the ancestor's output even though tip has none
    const snippet = summaries[0]!.recapSnippet;
    expect(snippet).not.toBeNull();
    expect(snippet).toContain('UNIQUE_MARKER_ALPHA');
  });

  it('aggregates outputs from multiple ancestor nodes (newest to oldest)', async () => {
    const sessionId = 'sess_test_aggregate_recap_02';
    const runId = 'run_test_02';

    // Chain: root → step1(ALPHA) → step2(BETA) → tip(no output, pending)
    const events = buildLinearChain(sessionId, runId, 'test-workflow', [
      { nodeId: 'node_root_02', parentNodeId: null },
      { nodeId: 'node_step1_02', parentNodeId: 'node_root_02', outputMarkdown: 'ALPHA marker text' },
      { nodeId: 'node_step2_02', parentNodeId: 'node_step1_02', outputMarkdown: 'BETA marker text' },
      { nodeId: 'node_tip_02', parentNodeId: 'node_step2_02' }, // pending, no output
    ]);

    const provider = buildProvider(sessionId, events);
    const result = await provider.loadHealthySummaries();

    expect(result.isOk()).toBe(true);
    const summaries = result._unsafeUnwrap();
    expect(summaries).toHaveLength(1);

    const snippet = summaries[0]!.recapSnippet;
    expect(snippet).not.toBeNull();
    // Both ancestor outputs should be included
    expect(snippet).toContain('ALPHA marker text');
    expect(snippet).toContain('BETA marker text');
  });

  it('still works when the tip node itself has outputs (existing behavior unchanged)', async () => {
    const sessionId = 'sess_test_aggregate_recap_03';
    const runId = 'run_test_03';

    // Chain: root → tip(GAMMA output)
    const events = buildLinearChain(sessionId, runId, 'test-workflow', [
      { nodeId: 'node_root_03', parentNodeId: null },
      { nodeId: 'node_tip_03', parentNodeId: 'node_root_03', outputMarkdown: 'GAMMA tip output' },
    ]);

    const provider = buildProvider(sessionId, events);
    const result = await provider.loadHealthySummaries();

    expect(result.isOk()).toBe(true);
    const summaries = result._unsafeUnwrap();
    expect(summaries).toHaveLength(1);

    const snippet = summaries[0]!.recapSnippet;
    expect(snippet).not.toBeNull();
    expect(snippet).toContain('GAMMA tip output');
  });

  it('returns null recap when no node in the ancestor chain has outputs', async () => {
    const sessionId = 'sess_test_aggregate_recap_04';
    const runId = 'run_test_04';

    // Chain: root → tip — no outputs anywhere
    const events = buildLinearChain(sessionId, runId, 'test-workflow', [
      { nodeId: 'node_root_04', parentNodeId: null },
      { nodeId: 'node_tip_04', parentNodeId: 'node_root_04' },
    ]);

    const provider = buildProvider(sessionId, events);
    const result = await provider.loadHealthySummaries();

    expect(result.isOk()).toBe(true);
    const summaries = result._unsafeUnwrap();
    expect(summaries).toHaveLength(1);

    expect(summaries[0]!.recapSnippet).toBeNull();
  });

  it('derives sessionTitle from the selected run context, not another run in the same session', async () => {
    const sessionId = 'sess_test_selected_run_title';
    const events = [
      {
        kind: 'session_created',
        eventId: 'evt_session',
        eventIndex: 0,
        sessionId,
        v: 1,
        data: {},
        dedupeKey: `session_created:${sessionId}`,
      },
      {
        kind: 'run_started',
        eventId: 'evt_run_old',
        eventIndex: 1,
        sessionId,
        v: 1,
        scope: { runId: 'run_old' },
        data: { workflowId: 'test-workflow', workflowHash: TEST_WORKFLOW_HASH },
        dedupeKey: `run_started:${sessionId}:run_old`,
      },
      {
        kind: 'context_set',
        eventId: 'evt_ctx_old',
        eventIndex: 2,
        sessionId,
        v: 1,
        scope: { runId: 'run_old' },
        data: {
          contextId: 'ctx_old',
          context: { goal: 'Old run title should not win' },
          source: 'initial',
        },
        dedupeKey: `context_set:${sessionId}:run_old:ctx_old`,
      },
      {
        kind: 'node_created',
        eventId: 'evt_node_old',
        eventIndex: 3,
        sessionId,
        v: 1,
        scope: { runId: 'run_old', nodeId: 'node_old' },
        data: { nodeKind: 'step', parentNodeId: null, workflowHash: TEST_WORKFLOW_HASH, snapshotRef: 'snap_old' },
        dedupeKey: `node_created:${sessionId}:node_old`,
      },
      {
        kind: 'run_started',
        eventId: 'evt_run_new',
        eventIndex: 4,
        sessionId,
        v: 1,
        scope: { runId: 'run_new' },
        data: { workflowId: 'test-workflow', workflowHash: TEST_WORKFLOW_HASH },
        dedupeKey: `run_started:${sessionId}:run_new`,
      },
      {
        kind: 'context_set',
        eventId: 'evt_ctx_new',
        eventIndex: 5,
        sessionId,
        v: 1,
        scope: { runId: 'run_new' },
        data: {
          contextId: 'ctx_new',
          context: { goal: 'New run title should win' },
          source: 'initial',
        },
        dedupeKey: `context_set:${sessionId}:run_new:ctx_new`,
      },
      {
        kind: 'node_created',
        eventId: 'evt_node_new',
        eventIndex: 6,
        sessionId,
        v: 1,
        scope: { runId: 'run_new', nodeId: 'node_new' },
        data: { nodeKind: 'step', parentNodeId: null, workflowHash: TEST_WORKFLOW_HASH, snapshotRef: 'snap_new' },
        dedupeKey: `node_created:${sessionId}:node_new`,
      },
    ];

    const provider = buildProvider(sessionId, events);
    const result = await provider.loadHealthySummaries();

    expect(result.isOk()).toBe(true);
    const summaries = result._unsafeUnwrap();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.runId).toBe('run_new');
    expect(summaries[0]!.sessionTitle).toBe('New run title should win');
  });
});
