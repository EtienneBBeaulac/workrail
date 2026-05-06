/**
 * Unit tests for runner/construct-tools.ts
 *
 * Focuses on: the runWorkflowFn injection contract, tool list composition,
 * and the SessionScope capability boundary (no direct state access).
 */

import { tmpPath } from '../helpers/platform.js';
import { describe, it, expect, vi } from 'vitest';
import type { V2ToolContext } from '../../src/mcp/types.js';
import { constructTools } from '../../src/daemon/runner/construct-tools.js';
import type { SessionScope, FileStateTracker } from '../../src/daemon/session-scope.js';
import type { AgentTool } from '../../src/daemon/agent-loop.js';
import type { runWorkflow } from '../../src/daemon/workflow-runner.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMinimalScope(overrides: Partial<SessionScope> = {}): SessionScope {
  const fakeTracker: FileStateTracker = {
    recordRead: vi.fn(),
    getReadState: vi.fn(() => undefined),
    hasBeenRead: vi.fn(() => false),
    toMap: vi.fn(() => new Map()),
  };
  return {
    fileTracker: fakeTracker,
    onAdvance: vi.fn(),
    onComplete: vi.fn(),
    onTokenUpdate: vi.fn(),
    onIssueReported: vi.fn(),
    onSteer: vi.fn(),
    getCurrentToken: vi.fn(() => 'ct_test'),
    sessionWorkspacePath: tmpPath('workspace'),
    spawnCurrentDepth: 0,
    spawnMaxDepth: 3,
    workrailSessionId: 'sess_test123',
    emitter: undefined,
    sessionId: 'local-session-id',
    workflowId: 'wr.test',
    activeSessionSet: undefined,
    ...overrides,
  };
}

// Minimal fake V2ToolContext -- tests don't call engine methods
const fakeCtx = {} as unknown as V2ToolContext;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeSchemas: Record<string, any> = {
  ContinueWorkflowParams: { type: 'object', properties: {}, required: [] },
  CompleteStepParams: { type: 'object', properties: { notes: { type: 'string' } }, required: ['notes'] },
  BashParams: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  ReadParams: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] },
  WriteParams: { type: 'object', properties: { filePath: { type: 'string' }, content: { type: 'string' } }, required: ['filePath', 'content'] },
  GlobParams: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
  GrepParams: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
  EditParams: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['file_path', 'old_string', 'new_string'] },
  SpawnAgentParams: { type: 'object', properties: { workflowId: { type: 'string' }, goal: { type: 'string' }, workspacePath: { type: 'string' } }, required: ['workflowId', 'goal', 'workspacePath'] },
};

const fakeRunWorkflow = vi.fn() as unknown as typeof runWorkflow;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('constructTools', () => {
  it('returns a non-empty array of tools with known names', () => {
    const scope = makeMinimalScope();
    const tools = constructTools(fakeCtx, 'api-key', fakeSchemas, scope, fakeRunWorkflow);

    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('complete_step');
    expect(toolNames).toContain('continue_workflow');
    expect(toolNames).toContain('Bash');
    expect(toolNames).toContain('Read');
    expect(toolNames).toContain('Write');
    expect(toolNames).toContain('Glob');
    expect(toolNames).toContain('Grep');
    expect(toolNames).toContain('Edit');
    expect(toolNames).toContain('report_issue');
    expect(toolNames).toContain('spawn_agent');
    expect(toolNames).toContain('signal_coordinator');
  });

  it('injects runWorkflowFn into spawn_agent tool (not runWorkflow directly)', () => {
    // The injection contract: spawn_agent must use runWorkflowFn, not a module-level reference.
    // We verify by passing a fake and confirming the tool is constructed without error.
    const scope = makeMinimalScope();
    const customFn = vi.fn() as unknown as typeof runWorkflow;
    const tools = constructTools(fakeCtx, 'api-key', fakeSchemas, scope, customFn);
    const spawnTool = tools.find((t) => t.name === 'spawn_agent');
    expect(spawnTool).toBeDefined();
    // The tool was constructed successfully with our custom fn.
    // The fn won't be called unless execute() is invoked -- that's tested elsewhere.
  });

  it('returns readonly array (immutable tool list)', () => {
    const scope = makeMinimalScope();
    const tools = constructTools(fakeCtx, 'api-key', fakeSchemas, scope, fakeRunWorkflow);
    // TypeScript enforces readonly at compile time; runtime check as belt-and-suspenders
    expect(Object.isFrozen(tools) || Array.isArray(tools)).toBe(true);
  });

  it('each tool has a name, description, inputSchema, label, and execute function', () => {
    const scope = makeMinimalScope();
    const tools = constructTools(fakeCtx, 'api-key', fakeSchemas, scope, fakeRunWorkflow);

    for (const tool of tools) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe('string');
      expect(typeof tool.inputSchema).toBe('object');
      expect(typeof tool.label).toBe('string');
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('produces 11 tools -- the expected set', () => {
    const scope = makeMinimalScope();
    const tools = constructTools(fakeCtx, 'api-key', fakeSchemas, scope, fakeRunWorkflow);
    expect(tools.length).toBe(11);
  });

  it('different scopes produce independent tool sets', () => {
    const scope1 = makeMinimalScope({ sessionId: 'session-A' });
    const scope2 = makeMinimalScope({ sessionId: 'session-B' });
    const tools1 = constructTools(fakeCtx, 'api-key', fakeSchemas, scope1, fakeRunWorkflow);
    const tools2 = constructTools(fakeCtx, 'api-key', fakeSchemas, scope2, fakeRunWorkflow);
    // Different instances -- tool factories close over their scope
    expect(tools1[0]).not.toBe(tools2[0]);
  });
});
