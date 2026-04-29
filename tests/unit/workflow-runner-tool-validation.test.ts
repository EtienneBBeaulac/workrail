/**
 * Tool param validation tests.
 *
 * Verifies that tool factories throw with a clear message when required
 * params are missing or wrong type at the LLM boundary (execute() call).
 *
 * Philosophy: validate at boundaries. The LLM is an external system that can
 * produce structurally wrong params. AgentLoop._executeTools() catches all throws
 * from execute() and converts them to isError tool_results so the LLM can
 * self-correct. These tests verify that boundary validation fires correctly.
 *
 * complete_step is already covered by workflow-runner-complete-step.test.ts.
 * continue_workflow delegates validation to the engine (no redundant check here).
 */

import { describe, it, expect } from 'vitest';
import {
  makeBashTool,
  makeReadTool,
  makeWriteTool,
  makeGlobTool,
  makeGrepTool,
  makeEditTool,
  makeSpawnAgentTool,
  makeReportIssueTool,
  makeSignalCoordinatorTool,
  createSessionState,
} from '../../src/daemon/workflow-runner.js';
import { tmpPath } from '../helpers/platform.js';

// Minimal stubs -- validation checks fire before any real I/O
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeSchemas: Record<string, any> = {
  BashParams: {},
  ReadParams: {},
  WriteParams: {},
  GlobParams: {},
  GrepParams: {},
  EditParams: {},
  SpawnAgentParams: {},
};
const workspacePath = tmpPath('test-workspace');
const readFileState = new Map();
const sessionId = 'test-session-id';

// Helper: call execute() and expect it to throw with a message containing the substring
async function expectThrows(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executeFn: (id: string, params: any) => Promise<unknown>,
  params: Record<string, unknown>,
  expectedMsg: string,
): Promise<void> {
  await expect(executeFn('tool-call-1', params)).rejects.toThrow(expectedMsg);
}

describe('Bash tool validation', () => {
  const tool = makeBashTool(workspacePath, fakeSchemas);

  it('throws when command is missing', async () => {
    await expectThrows(tool.execute.bind(tool), {}, 'Bash: command');
  });

  it('throws when command is not a string', async () => {
    await expectThrows(tool.execute.bind(tool), { command: 42 }, 'Bash: command');
  });

  it('throws when command is empty string', async () => {
    await expectThrows(tool.execute.bind(tool), { command: '' }, 'Bash: command');
  });
});

describe('Read tool validation', () => {
  const tool = makeReadTool(readFileState, fakeSchemas);

  it('throws when filePath is missing', async () => {
    await expectThrows(tool.execute.bind(tool), {}, 'Read: filePath');
  });

  it('throws when filePath is not a string', async () => {
    await expectThrows(tool.execute.bind(tool), { filePath: 123 }, 'Read: filePath');
  });
});

describe('Write tool validation', () => {
  const tool = makeWriteTool(readFileState, fakeSchemas);

  it('throws when filePath is missing', async () => {
    await expectThrows(tool.execute.bind(tool), { content: 'x' }, 'Write: filePath');
  });

  it('throws when content is missing', async () => {
    await expectThrows(tool.execute.bind(tool), { filePath: '/tmp/f' }, 'Write: content');
  });

  it('throws when content is not a string', async () => {
    await expectThrows(tool.execute.bind(tool), { filePath: '/tmp/f', content: null }, 'Write: content');
  });
});

describe('Glob tool validation', () => {
  const tool = makeGlobTool(workspacePath, fakeSchemas);

  it('throws when pattern is missing', async () => {
    await expectThrows(tool.execute.bind(tool), {}, 'Glob: pattern');
  });

  it('throws when pattern is empty', async () => {
    await expectThrows(tool.execute.bind(tool), { pattern: '' }, 'Glob: pattern');
  });
});

describe('Grep tool validation', () => {
  const tool = makeGrepTool(workspacePath, fakeSchemas);

  it('throws when pattern is missing', async () => {
    await expectThrows(tool.execute.bind(tool), {}, 'Grep: pattern');
  });
});

describe('Edit tool validation', () => {
  const tool = makeEditTool(workspacePath, readFileState, fakeSchemas);

  it('throws when file_path is missing', async () => {
    await expectThrows(tool.execute.bind(tool), { old_string: 'a', new_string: 'b' }, 'Edit: file_path');
  });

  it('throws when old_string is missing', async () => {
    await expectThrows(tool.execute.bind(tool), { file_path: '/tmp/f', new_string: 'b' }, 'Edit: old_string');
  });

  it('throws when new_string is missing', async () => {
    await expectThrows(tool.execute.bind(tool), { file_path: '/tmp/f', old_string: 'a' }, 'Edit: new_string');
  });
});

describe('spawn_agent tool validation', () => {
  // Minimal fake runWorkflow for construction
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakeRunWorkflow = async () => ({ _tag: 'success' as const, workflowId: 'x', stopReason: 'stop' });
  const state = createSessionState('ct_test');
  const tool = makeSpawnAgentTool(
    sessionId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any, // ctx
    'fake-api-key',
    'sess_parent',
    0,
    3,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fakeRunWorkflow as any,
    fakeSchemas,
  );

  it('throws when workflowId is missing', async () => {
    await expectThrows(tool.execute.bind(tool), { goal: 'g', workspacePath: '/tmp' }, 'spawn_agent: workflowId');
  });

  it('throws when goal is missing', async () => {
    await expectThrows(tool.execute.bind(tool), { workflowId: 'wf', workspacePath: '/tmp' }, 'spawn_agent: goal');
  });

  it('throws when workspacePath is missing', async () => {
    await expectThrows(tool.execute.bind(tool), { workflowId: 'wf', goal: 'g' }, 'spawn_agent: workspacePath');
  });
});

describe('report_issue tool validation', () => {
  const tool = makeReportIssueTool(sessionId);

  it('throws when kind is missing', async () => {
    await expectThrows(tool.execute.bind(tool), { severity: 'error', summary: 's' }, 'report_issue: kind');
  });

  it('throws when severity is missing', async () => {
    await expectThrows(tool.execute.bind(tool), { kind: 'tool_failure', summary: 's' }, 'report_issue: severity');
  });

  it('throws when summary is missing', async () => {
    await expectThrows(tool.execute.bind(tool), { kind: 'tool_failure', severity: 'error' }, 'report_issue: summary');
  });
});

describe('signal_coordinator tool validation', () => {
  const tool = makeSignalCoordinatorTool(sessionId);

  it('throws when signalKind is missing', async () => {
    await expectThrows(tool.execute.bind(tool), { payload: {} }, 'signal_coordinator: signalKind');
  });

  it('throws when signalKind is empty', async () => {
    await expectThrows(tool.execute.bind(tool), { signalKind: '', payload: {} }, 'signal_coordinator: signalKind');
  });
});
