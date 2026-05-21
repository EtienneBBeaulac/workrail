import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionCortex, type CortexEvent } from '../../src/daemon/cortex/session-cortex.js';

describe('SessionCortex', () => {
  let tmpDir: string;
  let cortexLogPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workrail-cortex-test-'));
    cortexLogPath = path.join(tmpDir, 'test-cortex.jsonl');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('correctly loads and replays events on startup', async () => {
    const initialEvents = [
      { kind: 'step_failure_observed', stepId: 'step-1', failureCount: 1, errorSummary: 'missing artifact', ts: Date.now() },
      { kind: 'hint_injected', stepId: 'step-1', ts: Date.now() },
      { kind: 'step_failure_observed', stepId: 'step-1', failureCount: 2, errorSummary: 'missing artifact again', ts: Date.now() },
      { kind: 'scaffold_injected', stepId: 'step-1', ts: Date.now() },
      { kind: 'step_advanced', stepId: 'step-1', ts: Date.now() },
      { kind: 'step_failure_observed', stepId: 'step-2', failureCount: 1, errorSummary: 'missing verdict', ts: Date.now() },
      { kind: 'hint_injected', stepId: 'step-2', ts: Date.now() },
    ];

    const lines = initialEvents.map(e => JSON.stringify(eventWithTs(e))).join('\n') + '\n';
    await fs.writeFile(cortexLogPath, lines, 'utf8');

    const cortex = new SessionCortex(cortexLogPath);
    await cortex.load('step-2');

    // To verify state, we can run a new handleTurnEnd with step-2 which should trigger a scaffold (failureCount 2)
    const mockAgent = { steer: () => {} };
    const state = {
      pendingStepIdAfterAdvance: 'step-2',
      pendingSteerParts: [] as string[],
    };

    const blockEvent = {
      type: 'turn_end' as const,
      toolResults: [
        {
          toolName: 'complete_step',
          isError: false,
          result: {
            details: {
              kind: 'blocked',
              blockers: {
                blockers: [
                  {
                    message: 'Missing review verdict',
                    pointer: { kind: 'output_contract', contractRef: 'wr.contracts.review_verdict' },
                  },
                ],
              },
            },
          },
        },
      ],
    };

    await cortex.handleTurnEnd(blockEvent, mockAgent, state);

    expect(state.pendingSteerParts).toHaveLength(1);
    expect(state.pendingSteerParts[0]).toContain('Cortex Interceded (Tier-2 Scaffold)');
    expect(state.pendingSteerParts[0]).toContain('wr.review_verdict');
  });

  it('triggers Tier-1 Hint on first failure, and Tier-2 Scaffold on second failure', async () => {
    const cortex = new SessionCortex(cortexLogPath);
    await cortex.load('step-1');

    const mockAgent = { steer: () => {} };
    const state = {
      pendingStepIdAfterAdvance: 'step-1',
      pendingSteerParts: [] as string[],
    };

    const blockEvent = {
      type: 'turn_end' as const,
      toolResults: [
        {
          toolName: 'complete_step',
          isError: false,
          result: {
            details: {
              kind: 'blocked',
              blockers: {
                blockers: [
                  {
                    message: 'Missing loop control',
                    pointer: { kind: 'output_contract', contractRef: 'wr.contracts.loop_control' },
                  },
                ],
              },
            },
          },
        },
      ],
    };

    // First failure: Hint
    await cortex.handleTurnEnd(blockEvent, mockAgent, state);
    expect(state.pendingSteerParts).toHaveLength(1);
    expect(state.pendingSteerParts[0]).toContain('Cortex Interceded (Tier-1 Hint)');
    expect(state.pendingSteerParts[0]).toContain('wr.contracts.loop_control');

    // Second failure: Scaffold
    state.pendingSteerParts = [];
    await cortex.handleTurnEnd(blockEvent, mockAgent, state);
    expect(state.pendingSteerParts).toHaveLength(1);
    expect(state.pendingSteerParts[0]).toContain('Cortex Interceded (Tier-2 Scaffold)');
    expect(state.pendingSteerParts[0]).toContain('wr.contracts.loop_control');

    // Third failure: No-op (exceeded Phase 2 maximum of tier 2)
    state.pendingSteerParts = [];
    await cortex.handleTurnEnd(blockEvent, mockAgent, state);
    expect(state.pendingSteerParts).toHaveLength(0);
  });

  it('resets failure counts when step advances', async () => {
    const cortex = new SessionCortex(cortexLogPath);
    await cortex.load('step-1');

    const mockAgent = { steer: () => {} };
    const state = {
      pendingStepIdAfterAdvance: 'step-1',
      pendingSteerParts: [] as string[],
    };

    const blockEvent = {
      type: 'turn_end' as const,
      toolResults: [
        {
          toolName: 'complete_step',
          isError: false,
          result: {
            details: {
              kind: 'blocked',
              blockers: {
                blockers: [
                  {
                    message: 'Missing loop control',
                    pointer: { kind: 'output_contract', contractRef: 'wr.contracts.loop_control' },
                  },
                ],
              },
            },
          },
        },
      ],
    };

    // First failure on step-1: Hint
    await cortex.handleTurnEnd(blockEvent, mockAgent, state);
    expect(state.pendingSteerParts).toHaveLength(1);
    expect(state.pendingSteerParts[0]).toContain('Tier-1 Hint');

    // Step advances! We transition to step-2
    state.pendingStepIdAfterAdvance = 'step-2';
    state.pendingSteerParts = [];

    // Success or other non-blocked turn_end on step-2
    const successEvent = {
      type: 'turn_end' as const,
      toolResults: [],
    };
    await cortex.handleTurnEnd(successEvent, mockAgent, state);
    expect(state.pendingSteerParts).toHaveLength(0);

    // Now step-2 fails: should trigger Tier-1 Hint, NOT Tier-2 Scaffold
    await cortex.handleTurnEnd(blockEvent, mockAgent, state);
    expect(state.pendingSteerParts).toHaveLength(1);
    expect(state.pendingSteerParts[0]).toContain('Tier-1 Hint');
  });
});

function eventWithTs(e: Omit<CortexEvent, 'ts'> & { ts?: number }): CortexEvent {
  return { ...e, ts: e.ts ?? Date.now() } as CortexEvent;
}
