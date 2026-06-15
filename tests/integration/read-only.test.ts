import { describe, it, expect, vi } from 'vitest';
import { constructTools } from '../../src/daemon/runner/construct-tools.js';
import type { SessionScope } from '../../src/daemon/session-scope.js';
import type { V2ToolContext } from '../../src/mcp/types.js';

describe('Read-Only Subagent Tool Stripping Integration Tests', () => {
  const mockCtx = {} as V2ToolContext;
  const mockSchemas = {
    SpawnAgentParams: {},
  };
  const runWorkflowFn = vi.fn();

  function makeMockScope(agentConfig?: { enableWriteTools?: boolean; enable_write_tools?: boolean }): SessionScope {
    return {
      fileTracker: {
        recordRead: vi.fn(),
        getReadState: vi.fn(),
        hasBeenRead: vi.fn(),
        toMap: () => new Map(),
      },
      onAdvance: vi.fn(),
      onComplete: vi.fn(),
      onTokenUpdate: vi.fn(),
      onIssueReported: vi.fn(),
      onSteer: vi.fn(),
      getCurrentToken: () => 'token',
      sessionWorkspacePath: '/path/to/workspace',
      spawnCurrentDepth: 0,
      spawnMaxDepth: 3,
      workrailSessionId: 'session-id',
      emitter: undefined,
      sessionId: 'run-id' as any,
      workflowId: 'test-wf',
      triggerWorkspacePath: '/path/to/workspace',
      triggerGoal: 'goal',
      triggerBranchStrategy: 'none',
      triggerContext: {},
      triggerAgentConfig: agentConfig,
      activeSessionSet: undefined,
      onGateParked: vi.fn(),
    };
  }

  it('should include all tools by default when enableWriteTools is not set', () => {
    const scope = makeMockScope();
    const tools = constructTools(mockCtx, 'api-key', mockSchemas, scope, runWorkflowFn);

    const toolNames = tools.map(t => t.name);
    expect(toolNames).toContain('Bash');
    expect(toolNames).toContain('Write');
    expect(toolNames).toContain('Edit');
    expect(toolNames).toContain('Read');
    expect(toolNames).toContain('spawn_agent');
  });

  it('should strip write and bash tools when enableWriteTools is false', () => {
    const scope = makeMockScope({ enableWriteTools: false });
    const tools = constructTools(mockCtx, 'api-key', mockSchemas, scope, runWorkflowFn);

    const toolNames = tools.map(t => t.name);
    expect(toolNames).not.toContain('Bash');
    expect(toolNames).not.toContain('Write');
    expect(toolNames).not.toContain('Edit');
    expect(toolNames).toContain('Read');
    expect(toolNames).toContain('spawn_agent');
  });

  it('should strip write and bash tools when enable_write_tools is false', () => {
    const scope = makeMockScope({ enable_write_tools: false });
    const tools = constructTools(mockCtx, 'api-key', mockSchemas, scope, runWorkflowFn);

    const toolNames = tools.map(t => t.name);
    expect(toolNames).not.toContain('Bash');
    expect(toolNames).not.toContain('Write');
    expect(toolNames).not.toContain('Edit');
    expect(toolNames).toContain('Read');
    expect(toolNames).toContain('spawn_agent');
  });
});
