import { describe, expect, it } from 'vitest';
import { okAsync } from 'neverthrow';
import { ConsoleService } from '../../../src/v2/usecases/console-service.js';
import type { DirectoryListingPortV2 } from '../../../src/v2/ports/directory-listing.port.js';
import type { DataDirPortV2 } from '../../../src/v2/ports/data-dir.port.js';
import type { SessionEventLogReadonlyStorePortV2 } from '../../../src/v2/ports/session-event-log-store.port.js';
import type { SnapshotStorePortV2 } from '../../../src/v2/ports/snapshot-store.port.js';
import type { PinnedWorkflowStorePortV2 } from '../../../src/v2/ports/pinned-workflow-store.port.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

describe('ConsoleService executionTraceSummary integration', () => {
  it('includes projected execution trace summary on session detail runs', async () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_session',
        eventIndex: 0,
        sessionId: 'sess_test',
        kind: 'session_created',
        dedupeKey: 'session_created:sess_test',
        data: {},
      } as DomainEventV1,
      {
        v: 1,
        eventId: 'evt_run',
        eventIndex: 1,
        sessionId: 'sess_test',
        kind: 'run_started',
        dedupeKey: 'run_started:sess_test:run_1',
        scope: { runId: 'run_1' },
        data: {
          workflowId: 'project.example',
          workflowHash: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
          workflowSourceKind: 'project',
          workflowSourceRef: 'workflows/example.json',
        },
      } as DomainEventV1,
      {
        v: 1,
        eventId: 'evt_node',
        eventIndex: 2,
        sessionId: 'sess_test',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_test:run_1:node_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          nodeKind: 'step',
          parentNodeId: null,
          workflowHash: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
          snapshotRef: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
        },
      } as DomainEventV1,
      {
        v: 1,
        eventId: 'evt_trace',
        eventIndex: 3,
        sessionId: 'sess_test',
        kind: 'decision_trace_appended',
        dedupeKey: 'decision_trace_appended:sess_test:trace_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          traceId: 'trace_1',
          entries: [
            {
              kind: 'selected_next_step',
              summary: "Selected next step 'step-plan'.",
              refs: [{ kind: 'step_id', stepId: 'step-plan' }],
            },
          ],
        },
      } as DomainEventV1,
      {
        v: 1,
        eventId: 'evt_context',
        eventIndex: 4,
        sessionId: 'sess_test',
        kind: 'context_set',
        dedupeKey: 'context_set:sess_test:run_1:ctx_1',
        scope: { runId: 'run_1' },
        data: {
          contextId: 'ctx_1',
          context: { taskComplexity: 'Small' },
          source: 'initial',
        },
      } as DomainEventV1,
    ];

    const directoryListing: DirectoryListingPortV2 = {
      readdir: () => okAsync([]),
      readdirWithMtime: () => okAsync([]),
    };

    const dataDir: DataDirPortV2 = {
      rememberedRootsPath: () => '/tmp/roots.json',
      rememberedRootsLockPath: () => '/tmp/roots.lock',
      pinnedWorkflowsDir: () => '/tmp/workflows',
      pinnedWorkflowPath: () => '/tmp/workflow.json',
      snapshotsDir: () => '/tmp/snapshots',
      snapshotPath: () => '/tmp/snapshot.json',
      keysDir: () => '/tmp/keys',
      keyringPath: () => '/tmp/keyring.json',
      sessionsDir: () => '/tmp/sessions',
      sessionDir: () => '/tmp/session',
      sessionEventsDir: () => '/tmp/session/events',
      sessionManifestPath: () => '/tmp/session/manifest.jsonl',
      sessionLockPath: () => '/tmp/session/lock',
      tokenIndexPath: () => '/tmp/token-index.json',
    };

    const sessionStore: SessionEventLogReadonlyStorePortV2 = {
      load: () => okAsync({ events, manifest: [] }),
      loadValidatedPrefix: () => okAsync({ kind: 'complete', truth: { events, manifest: [] } }),
    };

    const snapshotStore: SnapshotStorePortV2 = {
      putExecutionSnapshotV1: () => {
        throw new Error('not used');
      },
      getExecutionSnapshotV1: () => okAsync(null),
    };

    const pinnedWorkflowStore: PinnedWorkflowStorePortV2 = {
      get: () => okAsync(null),
      put: () => okAsync(undefined),
    };

    const service = new ConsoleService({
      directoryListing,
      dataDir,
      sessionStore,
      snapshotStore,
      pinnedWorkflowStore,
    });

    const result = await service.getSessionDetail('sess_test');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.runs).toHaveLength(1);
      expect(result.value.runs[0]?.executionTraceSummary).toEqual({
        items: [
          {
            kind: 'selected_next_step',
            summary: "Selected next step 'step-plan'.",
            recordedAtEventIndex: 3,
            refs: [
              { kind: 'node_id', value: 'node_1' },
              { kind: 'step_id', value: 'step-plan' },
            ],
          },
        ],
        contextFacts: [{ key: 'taskComplexity', value: 'Small' }],
      });
    }
  });

  it('explains a sparse fast-path run without inventing extra DAG nodes', async () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_session',
        eventIndex: 0,
        sessionId: 'sess_sparse',
        kind: 'session_created',
        dedupeKey: 'session_created:sess_sparse',
        data: {},
      } as DomainEventV1,
      {
        v: 1,
        eventId: 'evt_run',
        eventIndex: 1,
        sessionId: 'sess_sparse',
        kind: 'run_started',
        dedupeKey: 'run_started:sess_sparse:run_1',
        scope: { runId: 'run_1' },
        data: {
          workflowId: 'project.example',
          workflowHash: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
          workflowSourceKind: 'project',
          workflowSourceRef: 'workflows/example.json',
        },
      } as DomainEventV1,
      {
        v: 1,
        eventId: 'evt_node',
        eventIndex: 2,
        sessionId: 'sess_sparse',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_sparse:run_1:node_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          nodeKind: 'step',
          parentNodeId: null,
          workflowHash: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
          snapshotRef: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
        },
      } as DomainEventV1,
      {
        v: 1,
        eventId: 'evt_context',
        eventIndex: 3,
        sessionId: 'sess_sparse',
        kind: 'context_set',
        dedupeKey: 'context_set:sess_sparse:run_1:ctx_1',
        scope: { runId: 'run_1' },
        data: {
          contextId: 'ctx_1',
          context: { taskComplexity: 'Small' },
          source: 'initial',
        },
      } as DomainEventV1,
      {
        v: 1,
        eventId: 'evt_trace',
        eventIndex: 4,
        sessionId: 'sess_sparse',
        kind: 'decision_trace_appended',
        dedupeKey: 'decision_trace_appended:sess_sparse:trace_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          traceId: 'trace_1',
          entries: [
            {
              kind: 'selected_next_step',
              summary: "Selected next step 'step-implement' via small-task fast path.",
              refs: [{ kind: 'step_id', stepId: 'step-implement' }],
            },
          ],
        },
      } as DomainEventV1,
      {
        v: 1,
        eventId: 'evt_divergence',
        eventIndex: 5,
        sessionId: 'sess_sparse',
        kind: 'divergence_recorded',
        dedupeKey: 'divergence_recorded:sess_sparse:div_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          divergenceId: 'div_1',
          reason: 'efficiency_skip',
          summary: 'Skipped broad planning phase because the task was classified as small.',
          relatedStepId: 'step-plan',
        },
      } as DomainEventV1,
    ];

    const directoryListing: DirectoryListingPortV2 = {
      readdir: () => okAsync([]),
      readdirWithMtime: () => okAsync([]),
    };

    const dataDir: DataDirPortV2 = {
      rememberedRootsPath: () => '/tmp/roots.json',
      rememberedRootsLockPath: () => '/tmp/roots.lock',
      pinnedWorkflowsDir: () => '/tmp/workflows',
      pinnedWorkflowPath: () => '/tmp/workflow.json',
      snapshotsDir: () => '/tmp/snapshots',
      snapshotPath: () => '/tmp/snapshot.json',
      keysDir: () => '/tmp/keys',
      keyringPath: () => '/tmp/keyring.json',
      sessionsDir: () => '/tmp/sessions',
      sessionDir: () => '/tmp/session',
      sessionEventsDir: () => '/tmp/session/events',
      sessionManifestPath: () => '/tmp/session/manifest.jsonl',
      sessionLockPath: () => '/tmp/session/lock',
      tokenIndexPath: () => '/tmp/token-index.json',
    };

    const sessionStore: SessionEventLogReadonlyStorePortV2 = {
      load: () => okAsync({ events, manifest: [] }),
      loadValidatedPrefix: () => okAsync({ kind: 'complete', truth: { events, manifest: [] } }),
    };

    const snapshotStore: SnapshotStorePortV2 = {
      putExecutionSnapshotV1: () => {
        throw new Error('not used');
      },
      getExecutionSnapshotV1: () => okAsync(null),
    };

    const pinnedWorkflowStore: PinnedWorkflowStorePortV2 = {
      get: () => okAsync(null),
      put: () => okAsync(undefined),
    };

    const service = new ConsoleService({
      directoryListing,
      dataDir,
      sessionStore,
      snapshotStore,
      pinnedWorkflowStore,
    });

    const result = await service.getSessionDetail('sess_sparse');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.runs).toHaveLength(1);
      expect(result.value.runs[0]?.nodes).toHaveLength(1);
      expect(result.value.runs[0]?.edges).toHaveLength(0);
      expect(result.value.runs[0]?.executionTraceSummary).toEqual({
        items: [
          {
            kind: 'selected_next_step',
            summary: "Selected next step 'step-implement' via small-task fast path.",
            recordedAtEventIndex: 4,
            refs: [
              { kind: 'node_id', value: 'node_1' },
              { kind: 'step_id', value: 'step-implement' },
            ],
          },
          {
            kind: 'divergence',
            summary: 'Skipped broad planning phase because the task was classified as small.',
            recordedAtEventIndex: 5,
            refs: [
              { kind: 'node_id', value: 'node_1' },
              { kind: 'step_id', value: 'step-plan' },
            ],
          },
        ],
        contextFacts: [{ key: 'taskComplexity', value: 'Small' }],
      });
    }
  });
});
