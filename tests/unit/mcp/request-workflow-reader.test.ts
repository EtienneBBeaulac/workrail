import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { StaticFeatureFlagProvider } from '../../../src/config/feature-flags.js';
import {
  createWorkflowReaderForRequest,
  resolveRequestWorkspaceDirectory,
  toProjectWorkflowDirectory,
} from '../../../src/mcp/handlers/shared/request-workflow-reader.js';

function writeWorkflow(workspaceDir: string, name: string): void {
  const workflowsDir = path.join(workspaceDir, 'workflows');
  fs.mkdirSync(workflowsDir, { recursive: true });
  fs.writeFileSync(
    path.join(workflowsDir, 'workspace-scoped-workflow.v2.json'),
    JSON.stringify({
      id: 'workspace-scoped-workflow',
      name,
      description: `${name} description`,
      version: '0.0.1',
      steps: [
        {
          id: 'step-1',
          title: 'Step 1',
          prompt: 'Do the thing',
        },
      ],
    }, null, 2),
    'utf8',
  );
}

describe('request-workflow-reader', () => {
  it('prefers explicit workspacePath over roots and server cwd', () => {
    expect(resolveRequestWorkspaceDirectory({
      workspacePath: '/tmp/explicit',
      resolvedRootUris: ['file:///tmp/root'],
      serverCwd: '/tmp/cwd',
    })).toBe('/tmp/explicit');
  });

  it('uses the first MCP root URI when workspacePath is absent', () => {
    expect(resolveRequestWorkspaceDirectory({
      resolvedRootUris: ['file:///tmp/root-a', 'file:///tmp/root-b'],
      serverCwd: '/tmp/cwd',
    })).toBe('/tmp/root-a');
  });

  it('falls back to server cwd when no workspacePath or usable root URI exists', () => {
    expect(resolveRequestWorkspaceDirectory({
      resolvedRootUris: ['https://example.com/workspace'],
      serverCwd: '/tmp/cwd',
    })).toBe('/tmp/cwd');
  });

  it('appends workflows unless the directory is already workflows', () => {
    expect(toProjectWorkflowDirectory('/tmp/project')).toBe('/tmp/project/workflows');
    expect(toProjectWorkflowDirectory('/tmp/project/workflows')).toBe('/tmp/project/workflows');
  });

  it('loads project workflows from the request workspace instead of server cwd', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-request-reader-'));
    const workspaceA = path.join(tempRoot, 'workspace-a');
    const workspaceB = path.join(tempRoot, 'workspace-b');
    writeWorkflow(workspaceA, 'Workspace A');
    writeWorkflow(workspaceB, 'Workspace B');

    const reader = createWorkflowReaderForRequest({
      featureFlags: new StaticFeatureFlagProvider({
        v2Tools: true,
        leanWorkflows: false,
        agenticRoutines: false,
        experimentalWorkflows: false,
      }),
      resolvedRootUris: [`file://${workspaceA}`],
      serverCwd: workspaceB,
    });

    const workflow = await reader.getWorkflowById('workspace-scoped-workflow');
    expect(workflow?.definition.name).toBe('Workspace A');
    expect(workflow?.source.kind).toBe('project');
    expect((workflow?.source.kind === 'project' ? workflow.source.directoryPath : undefined))
      .toBe(path.join(workspaceA, 'workflows'));
  });
});
