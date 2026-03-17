import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
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
    const explicitWorkspace = path.join(os.tmpdir(), 'explicit-workspace');
    const rootWorkspace = path.join(os.tmpdir(), 'root-workspace');
    const serverWorkspace = path.join(os.tmpdir(), 'server-workspace');

    expect(resolveRequestWorkspaceDirectory({
      workspacePath: explicitWorkspace,
      resolvedRootUris: [pathToFileURL(rootWorkspace).toString()],
      serverCwd: serverWorkspace,
    })).toBe(explicitWorkspace);
  });

  it('uses the first MCP root URI when workspacePath is absent', () => {
    const rootWorkspaceA = path.join(os.tmpdir(), 'root-workspace-a');
    const rootWorkspaceB = path.join(os.tmpdir(), 'root-workspace-b');
    const serverWorkspace = path.join(os.tmpdir(), 'server-workspace');

    expect(resolveRequestWorkspaceDirectory({
      resolvedRootUris: [
        pathToFileURL(rootWorkspaceA).toString(),
        pathToFileURL(rootWorkspaceB).toString(),
      ],
      serverCwd: serverWorkspace,
    })).toBe(rootWorkspaceA);
  });

  it('falls back to server cwd when no workspacePath or usable root URI exists', () => {
    const serverWorkspace = path.join(os.tmpdir(), 'server-workspace');

    expect(resolveRequestWorkspaceDirectory({
      resolvedRootUris: ['https://example.com/workspace'],
      serverCwd: serverWorkspace,
    })).toBe(serverWorkspace);
  });

  it('appends workflows unless the directory is already workflows', () => {
    const projectDirectory = path.join(os.tmpdir(), 'project');
    const workflowsDirectory = path.join(projectDirectory, 'workflows');

    expect(toProjectWorkflowDirectory(projectDirectory)).toBe(workflowsDirectory);
    expect(toProjectWorkflowDirectory(workflowsDirectory)).toBe(workflowsDirectory);
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
      resolvedRootUris: [pathToFileURL(workspaceA).toString()],
      serverCwd: workspaceB,
    });

    const workflow = await reader.getWorkflowById('workspace-scoped-workflow');
    expect(workflow?.definition.name).toBe('Workspace A');
    expect(workflow?.source.kind).toBe('project');
    expect((workflow?.source.kind === 'project' ? workflow.source.directoryPath : undefined))
      .toBe(path.join(workspaceA, 'workflows'));
  });
});
