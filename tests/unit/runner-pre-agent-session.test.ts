/**
 * Unit tests for runner/pre-agent-session.ts -- buildPreAgentSession
 *
 * Focuses on: error paths (model error, start_workflow failure, persist failure),
 * instant single-step completion, pre-allocated session source, and registry
 * registration semantics.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { V2ToolContext } from '../../src/mcp/types.js';
import type { WorkflowTrigger, SessionSource, AllocatedSession } from '../../src/daemon/types.js';
import { buildPreAgentSession } from '../../src/daemon/runner/pre-agent-session.js';
import { ActiveSessionSet } from '../../src/daemon/active-sessions.js';

// ---------------------------------------------------------------------------
// Module mocks -- must be hoisted before imports
// ---------------------------------------------------------------------------

const {
  mockExecuteStartWorkflow,
  mockParseContinueTokenOrFail,
  mockPersistTokens,
  mockBuildAgentClient,
} = vi.hoisted(() => ({
  mockExecuteStartWorkflow: vi.fn(),
  mockParseContinueTokenOrFail: vi.fn(),
  mockPersistTokens: vi.fn(),
  mockBuildAgentClient: vi.fn(),
}));

vi.mock('../../src/mcp/handlers/v2-execution/start.js', () => ({
  executeStartWorkflow: mockExecuteStartWorkflow,
}));

vi.mock('../../src/mcp/handlers/v2-token-ops.js', () => ({
  parseContinueTokenOrFail: mockParseContinueTokenOrFail,
}));

vi.mock('../../src/daemon/tools/_shared.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/daemon/tools/_shared.js')>();
  return { ...original, persistTokens: mockPersistTokens };
});

vi.mock('../../src/daemon/core/agent-client.js', () => ({
  buildAgentClient: mockBuildAgentClient,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_CTX = {
  v2: {
    tokenCodecPorts: {},
    tokenAliasStore: {},
    sessionStore: {},
    workflowService: null,
  },
} as unknown as V2ToolContext;

const FAKE_TOKEN = 'ct_faketoken12345678901234567890';
const FAKE_MODEL = { agentClient: {} as never, modelId: 'claude-test' };

function makeTrigger(overrides: Partial<WorkflowTrigger> = {}): WorkflowTrigger {
  return { workflowId: 'wr.test', goal: 'test', workspacePath: '/tmp/ws', ...overrides };
}

function makePendingStart() {
  return {
    isOk: () => true, isErr: () => false,
    value: { response: { continueToken: FAKE_TOKEN, checkpointToken: null, isComplete: false, pending: { prompt: 'Step 1' } } },
  };
}

function makeCompleteStart() {
  return {
    isOk: () => true, isErr: () => false,
    value: { response: { continueToken: undefined, checkpointToken: undefined, isComplete: true, pending: null } },
  };
}

function makeStartError(kind: string) {
  return { isOk: () => false, isErr: () => true, error: { kind, message: 'test error' } };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workrail-pre-agent-'));
  mockExecuteStartWorkflow.mockReset();
  mockParseContinueTokenOrFail.mockReset();
  mockPersistTokens.mockReset();
  mockBuildAgentClient.mockReset();

  mockBuildAgentClient.mockReturnValue(FAKE_MODEL);
  mockParseContinueTokenOrFail.mockReturnValue({
    isOk: () => true, isErr: () => false,
    value: { sessionId: 'sess_test123' },
  });
  mockPersistTokens.mockResolvedValue({ kind: 'ok', value: undefined });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests: model client errors
// ---------------------------------------------------------------------------

describe('buildPreAgentSession -- model setup errors', () => {
  it('returns complete/error when buildAgentClient throws', async () => {
    mockBuildAgentClient.mockImplementation(() => { throw new Error('invalid model format'); });

    const result = await buildPreAgentSession(
      makeTrigger(), FAKE_CTX, 'api-key', 'sess-001', Date.now(),
      tmpDir, tmpDir, undefined, undefined, undefined,
    );

    expect(result.kind).toBe('complete');
    if (result.kind === 'complete') {
      expect(result.result._tag).toBe('error');
      expect((result.result as { message: string }).message).toContain('invalid model format');
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: executeStartWorkflow errors
// ---------------------------------------------------------------------------

describe('buildPreAgentSession -- executeStartWorkflow errors', () => {
  it('returns complete/error when start_workflow fails', async () => {
    mockExecuteStartWorkflow.mockResolvedValue(makeStartError('workflow_not_found'));

    const result = await buildPreAgentSession(
      makeTrigger(), FAKE_CTX, 'api-key', 'sess-001', Date.now(),
      tmpDir, tmpDir, undefined, undefined, undefined,
    );

    expect(result.kind).toBe('complete');
    if (result.kind === 'complete') {
      expect(result.result._tag).toBe('error');
      expect((result.result as { message: string }).message).toContain('start_workflow failed');
    }
  });

  it('returns complete/error when persistTokens fails on initial write', async () => {
    mockExecuteStartWorkflow.mockResolvedValue(makePendingStart());
    mockPersistTokens.mockResolvedValue({ kind: 'err', error: { code: 'WRITE_FAILED', message: 'disk full' } });

    const result = await buildPreAgentSession(
      makeTrigger(), FAKE_CTX, 'api-key', 'sess-001', Date.now(),
      tmpDir, tmpDir, undefined, undefined, undefined,
    );

    expect(result.kind).toBe('complete');
    if (result.kind === 'complete') {
      expect(result.result._tag).toBe('error');
      expect((result.result as { message: string }).message).toContain('persist failed');
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: instant single-step completion
// ---------------------------------------------------------------------------

describe('buildPreAgentSession -- instant completion', () => {
  it('returns complete/success when workflow is already complete on start', async () => {
    mockExecuteStartWorkflow.mockResolvedValue(makeCompleteStart());

    const result = await buildPreAgentSession(
      makeTrigger(), FAKE_CTX, 'api-key', 'sess-001', Date.now(),
      tmpDir, tmpDir, undefined, undefined, undefined,
    );

    expect(result.kind).toBe('complete');
    if (result.kind === 'complete') {
      expect(result.result._tag).toBe('success');
    }
  });

  it('returns complete/success for pre_allocated source with isComplete=true', async () => {
    const trigger = makeTrigger();
    const session: AllocatedSession = {
      continueToken: '', checkpointToken: undefined,
      firstStepPrompt: '', isComplete: true, triggerSource: 'daemon',
    };
    const source: SessionSource = { kind: 'pre_allocated', trigger, session };

    const result = await buildPreAgentSession(
      trigger, FAKE_CTX, 'api-key', 'sess-001', Date.now(),
      tmpDir, tmpDir, undefined, undefined, undefined, source,
    );

    expect(result.kind).toBe('complete');
    if (result.kind === 'complete') {
      expect(result.result._tag).toBe('success');
      // executeStartWorkflow must NOT have been called (pre-allocated)
      expect(mockExecuteStartWorkflow).not.toHaveBeenCalled();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: happy path -- returns ready
// ---------------------------------------------------------------------------

describe('buildPreAgentSession -- happy path', () => {
  it('returns ready when workflow has a pending step', async () => {
    mockExecuteStartWorkflow.mockResolvedValue(makePendingStart());

    const result = await buildPreAgentSession(
      makeTrigger(), FAKE_CTX, 'api-key', 'sess-local-001', Date.now(),
      tmpDir, tmpDir, undefined, undefined, undefined,
    );

    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') {
      expect(result.session.sessionId).toBe('sess-local-001');
      expect(result.session.continueToken).toBe(FAKE_TOKEN);
      expect(result.session.firstStepPrompt).toBe('Step 1');
      expect(result.session.modelId).toBe('claude-test');
    }
  });

  it('sets workrailSessionId from decoded token', async () => {
    mockExecuteStartWorkflow.mockResolvedValue(makePendingStart());

    const result = await buildPreAgentSession(
      makeTrigger(), FAKE_CTX, 'api-key', 'sess-001', Date.now(),
      tmpDir, tmpDir, undefined, undefined, undefined,
    );

    if (result.kind === 'ready') {
      expect(result.session.workrailSessionId).toBe('sess_test123');
    }
  });

  it('workrailSessionId is null when token decode fails', async () => {
    mockExecuteStartWorkflow.mockResolvedValue(makePendingStart());
    mockParseContinueTokenOrFail.mockReturnValue({
      isOk: () => false, isErr: () => true,
      error: { message: 'bad token' },
    });

    const result = await buildPreAgentSession(
      makeTrigger(), FAKE_CTX, 'api-key', 'sess-001', Date.now(),
      tmpDir, tmpDir, undefined, undefined, undefined,
    );

    if (result.kind === 'ready') {
      expect(result.session.workrailSessionId).toBeNull();
    }
  });

  it('uses pre_allocated continueToken without calling executeStartWorkflow', async () => {
    const trigger = makeTrigger();
    const session: AllocatedSession = {
      continueToken: 'ct_preallocated', checkpointToken: null,
      firstStepPrompt: 'Pre-allocated step 1', isComplete: false,
      triggerSource: 'daemon',
    };
    const source: SessionSource = { kind: 'pre_allocated', trigger, session };

    const result = await buildPreAgentSession(
      trigger, FAKE_CTX, 'api-key', 'sess-001', Date.now(),
      tmpDir, tmpDir, undefined, undefined, undefined, source,
    );

    expect(mockExecuteStartWorkflow).not.toHaveBeenCalled();
    if (result.kind === 'ready') {
      expect(result.session.continueToken).toBe('ct_preallocated');
      expect(result.session.firstStepPrompt).toBe('Pre-allocated step 1');
    }
  });

  it('writes sidecar file for crash recovery', async () => {
    mockExecuteStartWorkflow.mockResolvedValue(makePendingStart());

    await buildPreAgentSession(
      makeTrigger(), FAKE_CTX, 'api-key', 'sess-crash-test', Date.now(),
      tmpDir, tmpDir, undefined, undefined, undefined,
    );

    expect(mockPersistTokens).toHaveBeenCalledWith(
      'sess-crash-test',
      FAKE_TOKEN,
      null,
      undefined,
      expect.objectContaining({ workflowId: 'wr.test' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: registry registration
// ---------------------------------------------------------------------------

describe('buildPreAgentSession -- registry registration', () => {
  it('registers with ActiveSessionSet when workrailSessionId is decoded', async () => {
    mockExecuteStartWorkflow.mockResolvedValue(makePendingStart());
    const activeSessionSet = new ActiveSessionSet();

    await buildPreAgentSession(
      makeTrigger(), FAKE_CTX, 'api-key', 'sess-001', Date.now(),
      tmpDir, tmpDir, undefined, undefined, activeSessionSet,
    );

    // Session should be registered
    expect(activeSessionSet.size).toBe(1);
  });

  it('handle is provided in ready result when registration succeeds', async () => {
    mockExecuteStartWorkflow.mockResolvedValue(makePendingStart());
    const activeSessionSet = new ActiveSessionSet();

    const result = await buildPreAgentSession(
      makeTrigger(), FAKE_CTX, 'api-key', 'sess-001', Date.now(),
      tmpDir, tmpDir, undefined, undefined, activeSessionSet,
    );

    if (result.kind === 'ready') {
      expect(result.session.handle).toBeDefined();
    }
  });

  it('does not register when workrailSessionId is null (token decode failed)', async () => {
    mockExecuteStartWorkflow.mockResolvedValue(makePendingStart());
    mockParseContinueTokenOrFail.mockReturnValue({
      isOk: () => false, isErr: () => true, error: { message: 'bad token' },
    });
    const activeSessionSet = new ActiveSessionSet();

    await buildPreAgentSession(
      makeTrigger(), FAKE_CTX, 'api-key', 'sess-001', Date.now(),
      tmpDir, tmpDir, undefined, undefined, activeSessionSet,
    );

    expect(activeSessionSet.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: spawnDepth forwarding
// ---------------------------------------------------------------------------

describe('buildPreAgentSession -- spawn depth', () => {
  it('uses trigger.spawnDepth as spawnCurrentDepth (defaults to 0)', async () => {
    mockExecuteStartWorkflow.mockResolvedValue(makePendingStart());

    const result = await buildPreAgentSession(
      makeTrigger(), FAKE_CTX, 'api-key', 'sess-001', Date.now(),
      tmpDir, tmpDir, undefined, undefined, undefined,
    );

    if (result.kind === 'ready') {
      expect(result.session.spawnCurrentDepth).toBe(0);
    }
  });

  it('forwards spawnDepth from trigger', async () => {
    mockExecuteStartWorkflow.mockResolvedValue(makePendingStart());

    const result = await buildPreAgentSession(
      makeTrigger({ spawnDepth: 2 }), FAKE_CTX, 'api-key', 'sess-001', Date.now(),
      tmpDir, tmpDir, undefined, undefined, undefined,
    );

    if (result.kind === 'ready') {
      expect(result.session.spawnCurrentDepth).toBe(2);
    }
  });

  it('uses agentConfig.maxSubagentDepth for spawnMaxDepth (defaults to 3)', async () => {
    mockExecuteStartWorkflow.mockResolvedValue(makePendingStart());

    const result = await buildPreAgentSession(
      makeTrigger(), FAKE_CTX, 'api-key', 'sess-001', Date.now(),
      tmpDir, tmpDir, undefined, undefined, undefined,
    );

    if (result.kind === 'ready') {
      expect(result.session.spawnMaxDepth).toBe(3);
    }
  });
});
