/**
 * Tests for recordCommitShasStage -- the delivery pipeline stage that appends
 * commit SHAs to the session event log after a successful git commit.
 */
import { describe, it, expect, vi } from 'vitest';
import { runDeliveryPipeline, DEFAULT_DELIVERY_PIPELINE, type DeliveryPipelineDeps } from '../../src/trigger/delivery-pipeline.js';
import type { WorkflowRunSuccess } from '../../src/daemon/types.js';
import type { TriggerDefinition } from '../../src/trigger/types.js';
import { okAsync, errAsync } from 'neverthrow';

// ---------------------------------------------------------------------------
// Minimal fakes
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<WorkflowRunSuccess> = {}): WorkflowRunSuccess {
  const handoff = {
    commitType: 'fix',
    commitScope: 'engine',
    commitSubject: 'test subject',
    prTitle: 'fix(engine): test',
    prBody: '## Summary\n- test',
    filesChanged: ['src/foo.ts'],
    followUpTickets: [],
  };
  return {
    _tag: 'success',
    lastStepNotes: `Some notes here\n\`\`\`json\n${JSON.stringify(handoff, null, 2)}\n\`\`\`\n`,
    lastStepArtifacts: [],
    sessionWorkspacePath: '/fake/worktree',
    sessionId: 'sess_test123',
    botIdentity: undefined,
    ...overrides,
  } as WorkflowRunSuccess;
}

function makeTrigger(overrides: Partial<TriggerDefinition> = {}): TriggerDefinition {
  return {
    id: 'test-trigger',
    workflowId: 'wr.coding-task',
    workspacePath: '/fake/workspace',
    branchStrategy: 'worktree',
    autoCommit: true,
    autoOpenPR: false,
    concurrencyMode: 'parallel',
    ...overrides,
  } as unknown as TriggerDefinition;
}

// Fake execFn that simulates a successful git commit
function makeExecFn(sha = 'abc1234') {
  return vi.fn().mockImplementation(async (cmd: string, args: string[]) => {
    if (cmd === 'git' && args[0] === 'add') return { stdout: '', stderr: '' };
    if (cmd === 'git' && args[0] === 'diff') return { stdout: '', stderr: '' };
    if (cmd === 'git' && args[0] === 'commit') return { stdout: `[main ${sha}] fix(engine): test`, stderr: '' };
    if (cmd === 'git' && args[0] === '-C') return { stdout: '', stderr: '' }; // worktree remove
    // Return the expected branch name for --abbrev-ref HEAD check
    if (cmd === 'git' && args[0] === 'rev-parse' && args.includes('--abbrev-ref')) {
      return { stdout: 'worktrain/sess_test123', stderr: '' };
    }
    if (cmd === 'git' && args[0] === 'rev-parse') return { stdout: 'worktrain/sess_test123', stderr: '' };
    return { stdout: '', stderr: '' };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recordCommitShasStage', () => {
  it('appends delivery_recorded event when all conditions are met', async () => {
    const appendedEvents: unknown[] = [];
    const mockGate = {
      withHealthySessionLock: vi.fn().mockImplementation((_sid: unknown, fn: (lock: unknown) => unknown) => {
        const lock = { assertHeld: () => true, sessionId: 'sess_test123' };
        return fn(lock);
      }),
    };
    const mockStore = {
      load: vi.fn().mockReturnValue(okAsync({
        manifest: [],
        events: [
          {
            v: 1,
            eventId: 'evt_0',
            eventIndex: 0,
            sessionId: 'sess_test123',
            kind: 'run_completed',
            dedupeKey: 'run-completed:sess_test123:run_1',
            scope: { runId: 'run_1' },
            data: {
              startGitSha: 'start_sha',
              endGitSha: 'end_sha',
              gitBranch: 'main',
              agentCommitShas: [],
              captureConfidence: 'none',
            },
            timestampMs: 0,
          },
        ],
      })),
      append: vi.fn().mockImplementation((_lock: unknown, plan: { events: unknown[] }) => {
        appendedEvents.push(...plan.events);
        return okAsync(undefined);
      }),
    };
    const mockDeps: DeliveryPipelineDeps = {
      gate: mockGate as never,
      sessionStore: mockStore as never,
      idFactory: { mintEventId: () => 'evt_test' },
    };

    await runDeliveryPipeline(
      DEFAULT_DELIVERY_PIPELINE,
      makeResult(),
      makeTrigger(),
      makeExecFn('deadbeef'),
      'test-trigger',
      mockDeps,
    );

    expect(appendedEvents).toHaveLength(1);
    const evt = appendedEvents[0] as { kind: string; data: { shas: string[] } };
    expect(evt.kind).toBe('delivery_recorded');
    expect(evt.data.shas).toEqual(['deadbeef']);
  });

  it('skips write-back when sessionId is absent', async () => {
    const mockDeps: DeliveryPipelineDeps = {
      gate: { withHealthySessionLock: vi.fn() } as never,
      sessionStore: { load: vi.fn(), append: vi.fn() } as never,
      idFactory: { mintEventId: () => 'evt_test' },
    };

    await runDeliveryPipeline(
      DEFAULT_DELIVERY_PIPELINE,
      makeResult({ sessionId: undefined }),
      makeTrigger(),
      makeExecFn(),
      'test-trigger',
      mockDeps,
    );

    expect((mockDeps.gate as { withHealthySessionLock: ReturnType<typeof vi.fn> }).withHealthySessionLock).not.toHaveBeenCalled();
  });

  it('skips write-back when deps are absent', async () => {
    // No deps passed -- should still complete pipeline without error
    await expect(
      runDeliveryPipeline(
        DEFAULT_DELIVERY_PIPELINE,
        makeResult(),
        makeTrigger(),
        makeExecFn(),
        'test-trigger',
        // no deps
      )
    ).resolves.toBeUndefined();
  });

  it('continues pipeline even when gate fails', async () => {
    const mockDeps: DeliveryPipelineDeps = {
      gate: {
        withHealthySessionLock: vi.fn().mockReturnValue(
          errAsync({ code: 'SESSION_NOT_HEALTHY', message: 'test', sessionId: 'sess_test123', health: { kind: 'corrupt_tail', reason: { code: 'digest_mismatch', message: 'test' } } }),
        ),
      } as never,
      sessionStore: { load: vi.fn(), append: vi.fn() } as never,
      idFactory: { mintEventId: () => 'evt_test' },
    };

    // Should complete without throwing despite gate failure
    await expect(
      runDeliveryPipeline(
        DEFAULT_DELIVERY_PIPELINE,
        makeResult(),
        makeTrigger(),
        makeExecFn(),
        'test-trigger',
        mockDeps,
      )
    ).resolves.toBeUndefined();
  });
});
