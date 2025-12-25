import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { handleV2ContinueWorkflow, handleV2StartWorkflow } from '../../src/mcp/handlers/v2-execution.js';
import type { ToolContext } from '../../src/mcp/types.js';
import type { SessionHealthDetails } from '../../src/mcp/types.js';

import { createWorkflow } from '../../src/types/workflow.js';
import { createProjectDirectorySource } from '../../src/types/workflow-source.js';

import { parseTokenV1 } from '../../src/v2/durable-core/tokens/index.js';
import { LocalDataDirV2 } from '../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../src/v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../../src/v2/infra/local/sha256/index.js';
import { LocalSessionEventLogStoreV2 } from '../../src/v2/infra/local/session-store/index.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-health-'));
}

function mkCtxWithWorkflow(workflowId: string): ToolContext {
  const wf = createWorkflow(
    {
      id: workflowId,
      name: 'Test Workflow',
      description: 'Test',
      version: '0.1.0',
      steps: [{ id: 'triage', title: 'Triage', prompt: 'Do triage' }],
    } as any,
    createProjectDirectorySource('/tmp/project')
  );

  return {
    workflowService: {
      listWorkflowSummaries: async () => [],
      getWorkflowById: async (id: string) => (id === workflowId ? wf : null),
      getNextStep: async () => {
        throw new Error('not used');
      },
      validateStepOutput: async () => ({ valid: true, issues: [], suggestions: [] }),
    } as any,
    featureFlags: null as any,
    sessionManager: null,
    httpServer: null,
  };
}

describe('v2 execution: SESSION_NOT_HEALTHY error response', () => {
  it('returns SESSION_NOT_HEALTHY with proper MCP envelope when session manifest is corrupted', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const workflowId = 'test-workflow';
      const ctx = mkCtxWithWorkflow(workflowId);

      // Create a healthy session initially
      const started = await handleV2StartWorkflow({ workflowId } as any, ctx);
      expect(started.type).toBe('success');
      if (started.type !== 'success') return;

      const stateToken = started.data.stateToken;
      const parsedState = parseTokenV1(stateToken)._unsafeUnwrap();
      const sessionId = parsedState.payload.sessionId;

      // Corrupt the session manifest file by truncating it
      const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
      const manifestPath = dataDir.sessionManifestPath(sessionId);
      
      // Truncate the file to make it invalid JSON
      const fd = await fs.open(manifestPath, 'w');
      await fd.truncate(5); // Truncate to 5 bytes, rendering it invalid JSON
      await fd.close();

      // Try to load the session - should fail with SESSION_NOT_HEALTHY
      const result = await handleV2ContinueWorkflow({ stateToken } as any, ctx);

      // Assert: error response
      expect(result.type).toBe('error');
      if (result.type !== 'error') return;

      // Assert: exact error code
      expect(result.code).toBe('SESSION_NOT_HEALTHY');

      // Assert: not retryable
      expect(result.retry.kind).toBe('not_retryable');

      // Assert: details contain health information with proper structure
      expect(result.details).toBeDefined();
      const details = result.details as SessionHealthDetails;
      expect(details).toHaveProperty('health');
      expect(details.health).toHaveProperty('kind');
      expect(['corrupt_tail', 'corrupt_head', 'unknown_version']).toContain(details.health.kind);
      
      // Assert: reason is populated
      expect(details.health).toHaveProperty('reason');
      if (details.health.reason) {
        expect(details.health.reason).toHaveProperty('code');
        expect(details.health.reason).toHaveProperty('message');
        expect(typeof details.health.reason.code).toBe('string');
        expect(typeof details.health.reason.message).toBe('string');
      }

      // Assert: message and suggestion exist
      expect(result.message).toBeTruthy();
      expect(result.suggestion).toBeTruthy();
      expect(result.suggestion).toContain('healthy session');
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });

  it('SESSION_NOT_HEALTHY uses correct type-safe health discriminators', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const workflowId = 'test-workflow';
      const ctx = mkCtxWithWorkflow(workflowId);

      // Create and corrupt session
      const started = await handleV2StartWorkflow({ workflowId } as any, ctx);
      expect(started.type).toBe('success');
      if (started.type !== 'success') return;

      const stateToken = started.data.stateToken;
      const parsedState = parseTokenV1(stateToken)._unsafeUnwrap();
      const sessionId = parsedState.payload.sessionId;

      // Corrupt manifest
      const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
      const manifestPath = dataDir.sessionManifestPath(sessionId);
      const fd = await fs.open(manifestPath, 'w');
      await fd.truncate(3);
      await fd.close();

      // Get error
      const result = await handleV2ContinueWorkflow({ stateToken } as any, ctx);
      expect(result.type).toBe('error');
      if (result.type !== 'error') return;

      const details = result.details as SessionHealthDetails;
      
      // Type assertion: health.kind must be one of the valid discriminators
      const validKinds: readonly string[] = ['corrupt_tail', 'corrupt_head', 'unknown_version'];
      expect(validKinds).toContain(details.health.kind);
      
      // Verify reason structure is present and valid
      if (details.health.reason) {
        const reason = details.health.reason;
        expect(typeof reason.code).toBe('string');
        expect(typeof reason.message).toBe('string');
        expect(reason.code.length).toBeGreaterThan(0);
        expect(reason.message.length).toBeGreaterThan(0);
      }
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });
});
