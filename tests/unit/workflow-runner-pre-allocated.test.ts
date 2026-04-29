/**
 * Unit tests for the SessionSource pre_allocated branch in workflow-runner.ts.
 *
 * INVARIANT tested: when a pre_allocated SessionSource is passed to runWorkflow(),
 * it MUST NOT call executeStartWorkflow(). The session is already created --
 * calling it again would create a duplicate session.
 *
 * WHY vi.mock is used here (and not fakes):
 * runWorkflow() calls loadPiAi() (from pi-mono-loader.js) at the top of the
 * function to set up the model -- before the SessionSource check.
 * There are no injection points for loadPiAi or executeStartWorkflow in
 * runWorkflow()'s signature. vi.mock is the only way to stub these out in the
 * CJS test environment without refactoring production code.
 *
 * This follows the repo pattern established in plugin-workflow-storage.test.ts,
 * using vi.hoisted() so mock variables are available when vi.mock factories run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tmpPath } from '../helpers/platform.js';

// ── Mock variables (hoisted alongside vi.mock) ────────────────────────────────
//
// vi.mock calls are hoisted to the top of the file by vitest's transformer.
// Variables used inside vi.mock factory functions must also be hoisted via
// vi.hoisted() -- otherwise they are not yet initialized when the factory runs.
const { mockExecuteStartWorkflow } = vi.hoisted(() => ({
  mockExecuteStartWorkflow: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────
//
// Mock pi-mono-loader so loadPiAi() returns a minimal fake model factory.
// Without this, the test would fail when vitest tries to load the ESM-only
// @mariozechner/pi-ai package in a CJS test environment.
vi.mock('../../src/daemon/pi-mono-loader.js', () => ({
  loadPiAi: async () => ({
    getModel: () => ({}),
  }),
  loadPiAgentCore: async () => ({}),
}));

// Mock start.js so we can assert executeStartWorkflow is NOT called.
// The mock never resolves since it must not be called on the
// pre_allocated SessionSource path.
vi.mock('../../src/mcp/handlers/v2-execution/start.js', () => ({
  executeStartWorkflow: mockExecuteStartWorkflow,
}));

import { runWorkflow, type WorkflowTrigger, type SessionSource, type AllocatedSession } from '../../src/daemon/workflow-runner.js';
import type { V2ToolContext } from '../../src/mcp/types.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Minimal fake V2ToolContext -- runWorkflow() passes it to tool constructors. */
const FAKE_CTX = {} as V2ToolContext;

/** Minimal fake API key -- not used on the pre_allocated SessionSource path. */
const FAKE_API_KEY = 'test-api-key';

/**
 * Build a minimal SessionSource with kind 'pre_allocated' that satisfies the
 * shape read by runWorkflow() / buildPreAgentSession():
 *   - session.isComplete -- read to detect single-step completion
 *   - session.continueToken -- read to persist tokens (guarded by `if (startContinueToken)`)
 *   - session.checkpointToken -- read alongside continueToken
 *   - session.firstStepPrompt -- only used after the isComplete check (never reached here)
 *
 * With isComplete = true, runWorkflow() returns early before starting the agent
 * loop. continueToken is '' so persistTokens() is skipped (if-guard on empty string).
 */
function makePreAllocatedSource(
  trigger: WorkflowTrigger,
  overrides: { isComplete?: boolean } = {},
): SessionSource {
  const session: AllocatedSession = {
    continueToken: '',
    checkpointToken: undefined,
    firstStepPrompt: '',
    isComplete: overrides.isComplete ?? true,
    triggerSource: 'daemon',
  };
  return { kind: 'pre_allocated', trigger, session };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runWorkflow() with pre_allocated SessionSource', () => {
  beforeEach(() => {
    mockExecuteStartWorkflow.mockClear();
  });

  it('skips executeStartWorkflow() and returns success when session.isComplete is true', async () => {
    const trigger: WorkflowTrigger = {
      workflowId: 'wr.coding-task',
      goal: 'test goal',
      workspacePath: tmpPath('test-workspace'),
    };
    const source = makePreAllocatedSource(trigger, { isComplete: true });

    const result = await runWorkflow(trigger, FAKE_CTX, FAKE_API_KEY, undefined, undefined, undefined, undefined, undefined, source);

    // The pre-allocated path returns success immediately -- no agent loop needed.
    expect(result._tag).toBe('success');

    // INVARIANT: executeStartWorkflow MUST NOT be called when source.kind === 'pre_allocated'.
    // Calling it again would create a duplicate session.
    expect(mockExecuteStartWorkflow).not.toHaveBeenCalled();
  });
});
