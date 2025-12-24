import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { setupIntegrationTest, teardownIntegrationTest, resolveService } from '../di/integration-container';
import { DI } from '../../src/di/tokens.js';
import type { ToolContext } from '../../src/mcp/types.js';

import { handleV2StartWorkflow, handleV2ContinueWorkflow } from '../../src/mcp/handlers/v2-execution.js';
import { InMemoryWorkflowStorage } from '../../src/infrastructure/storage/in-memory-storage.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-exec-contract-'));
}

describe('MCP contract: v2 start_workflow / continue_workflow (Slice 3)', () => {
  let root: string;
  let prevDataDir: string | undefined;

  beforeEach(async () => {
    root = await mkTempDataDir();
    prevDataDir = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;

    await setupIntegrationTest({
      storage: new InMemoryWorkflowStorage([
        {
          id: 'v2-exec-contract',
          name: 'V2 Exec Contract',
          description: 'Contract test workflow for v2 execution surface',
          version: '1.0.0',
          steps: [{ id: 'triage', title: 'Triage', prompt: 'Do triage' }],
        } as any,
      ]),
      disableSessionTools: true,
    });
  });

  afterEach(async () => {
    teardownIntegrationTest();
    process.env.WORKRAIL_DATA_DIR = prevDataDir;
  });

  it('start -> rehydrate -> ack replay is deterministic and idempotent', async () => {
    const workflowService = resolveService<any>(DI.Services.Workflow);
    const featureFlags = resolveService<any>(DI.Infra.FeatureFlags);

    const ctx: ToolContext = {
      workflowService,
      featureFlags,
      sessionManager: null,
      httpServer: null,
    };

    const start = await handleV2StartWorkflow({ workflowId: 'v2-exec-contract', context: {} } as any, ctx);
    expect(start.type).toBe('success');
    if (start.type !== 'success') return;

    expect(start.data.pending?.stepId).toBe('triage');
    expect(start.data.isComplete).toBe(false);

    const rehydrate1 = await handleV2ContinueWorkflow({ stateToken: start.data.stateToken } as any, ctx);
    expect(rehydrate1.type).toBe('success');
    if (rehydrate1.type !== 'success') return;
    expect(rehydrate1.data.kind).toBe('ok');
    expect(rehydrate1.data.pending?.stepId).toBe('triage');

    const rehydrate2 = await handleV2ContinueWorkflow({ stateToken: start.data.stateToken } as any, ctx);
    expect(rehydrate2.type).toBe('success');
    if (rehydrate2.type !== 'success') return;
    // Rehydrate is side-effect-free and deterministic in content, but may mint fresh ack/checkpoint tokens.
    expect(rehydrate2.data.kind).toBe('ok');
    expect(rehydrate2.data.stateToken).toBe(rehydrate1.data.stateToken);
    expect(rehydrate2.data.isComplete).toBe(rehydrate1.data.isComplete);
    expect(rehydrate2.data.pending).toEqual(rehydrate1.data.pending);

    const ack1 = await handleV2ContinueWorkflow({ stateToken: start.data.stateToken, ackToken: start.data.ackToken } as any, ctx);
    expect(ack1.type).toBe('success');
    if (ack1.type !== 'success') return;
    // This workflow has a single step; after acknowledging it we should complete.
    expect(ack1.data.kind).toBe('ok');
    expect(ack1.data.isComplete).toBe(true);
    expect(ack1.data.pending).toBeNull();

    const ack2 = await handleV2ContinueWorkflow({ stateToken: start.data.stateToken, ackToken: start.data.ackToken } as any, ctx);
    expect(ack2).toEqual(ack1); // idempotent replay
  });
});
