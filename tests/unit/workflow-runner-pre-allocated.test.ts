/**
 * Unit tests for the _preAllocatedStartResponse branch in workflow-runner.ts.
 *
 * INVARIANT tested: when WorkflowTrigger._preAllocatedStartResponse is set,
 * runWorkflow() MUST NOT call executeStartWorkflow(). The session is already
 * created -- calling it again would create a duplicate session.
 *
 * WHY vi.mock is used here (and not fakes):
 * runWorkflow() calls loadPiAi() (from pi-mono-loader.js) at the top of the
 * function to set up the model -- before the _preAllocatedStartResponse check.
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
// _preAllocatedStartResponse path.
vi.mock('../../src/mcp/handlers/v2-execution/start.js', () => ({
  executeStartWorkflow: mockExecuteStartWorkflow,
}));

import { runWorkflow, type WorkflowTrigger } from '../../src/daemon/workflow-runner.js';
import type { V2ToolContext } from '../../src/mcp/types.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Minimal fake V2ToolContext -- runWorkflow() passes it to tool constructors. */
const FAKE_CTX = {} as V2ToolContext;

/** Minimal fake API key -- not used on the _preAllocatedStartResponse path. */
const FAKE_API_KEY = 'test-api-key';

/**
 * Build a minimal _preAllocatedStartResponse that satisfies the shape read by
 * runWorkflow():
 *   - firstStep.isComplete -- read at line ~1172 to detect single-step completion
 *   - firstStep.continueToken -- read to persist tokens (guarded by `if (startContinueToken)`)
 *   - firstStep.checkpointToken -- read alongside continueToken
 *   - firstStep.pending -- only used after the isComplete check (never reached here)
 *
 * With isComplete = true, runWorkflow() returns early before starting the agent
 * loop. continueToken is undefined so persistTokens() is skipped (if-guard).
 *
 * The shape is cast to the inferred Zod type to avoid importing and running
 * the Zod schema at test time (which would require all transitive imports).
 */
function makePreAllocatedResponse(overrides: { isComplete?: boolean } = {}) {
  return {
    isComplete: overrides.isComplete ?? true,
    continueToken: undefined,
    checkpointToken: undefined,
    pending: null,
    preferences: { autonomy: 'full_auto_stop_on_user_deps' as const, riskPolicy: 'balanced' as const },
    nextIntent: 'complete' as const,
    nextCall: null,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runWorkflow() with _preAllocatedStartResponse', () => {
  beforeEach(() => {
    mockExecuteStartWorkflow.mockClear();
  });

  it('skips executeStartWorkflow() and returns success when _preAllocatedStartResponse.isComplete is true', async () => {
    const trigger: WorkflowTrigger = {
      workflowId: 'coding-task-workflow-agentic',
      goal: 'test goal',
      workspacePath: tmpPath('test-workspace'),
      _preAllocatedStartResponse: makePreAllocatedResponse({ isComplete: true }),
    };

    const result = await runWorkflow(trigger, FAKE_CTX, FAKE_API_KEY);

    // The pre-allocated path returns success immediately -- no agent loop needed.
    expect(result._tag).toBe('success');

    // INVARIANT: executeStartWorkflow MUST NOT be called when _preAllocatedStartResponse is set.
    // Calling it again would create a duplicate session.
    expect(mockExecuteStartWorkflow).not.toHaveBeenCalled();
  });
});
