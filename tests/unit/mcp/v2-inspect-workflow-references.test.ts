/**
 * Tests that inspect_workflow surfaces workflow-declared references.
 */
import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { handleV2InspectWorkflow } from '../../../src/mcp/handlers/v2-workflow.js';
import type { ToolContext } from '../../../src/mcp/types.js';
import { createWorkflow } from '../../../src/types/workflow.js';
import { createProjectDirectorySource } from '../../../src/types/workflow-source.js';

import { LocalDataDirV2 } from '../../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../../src/v2/infra/local/fs/index.js';
import { NodeCryptoV2 } from '../../../src/v2/infra/local/crypto/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../../../src/v2/infra/local/pinned-workflow-store/index.js';
import { createTestValidationPipelineDeps } from '../../helpers/v2-test-helpers.js';

const REFS_WORKFLOW_ID = 'inspect-refs-test';

function createCtxWithReferences(): ToolContext {
  const wf = createWorkflow(
    {
      id: REFS_WORKFLOW_ID,
      name: 'Workflow With References',
      description: 'Test',
      version: '0.1.0',
      references: [
        {
          id: 'api-spec',
          title: 'API Specification',
          source: './spec/api.json',
          purpose: 'Canonical API contract',
          authoritative: true,
        },
        {
          id: 'team-guide',
          title: 'Team Guide',
          source: './docs/guide.md',
          purpose: 'Team conventions',
          authoritative: false,
        },
      ],
      steps: [{ id: 'step1', title: 'Step 1', prompt: 'Do stuff' }],
    } as any,
    createProjectDirectorySource(path.join(os.tmpdir(), 'workrail-inspect-refs'))
  );

  const dataDir = new LocalDataDirV2(process.env);
  const fsPort = new NodeFileSystemV2();
  const crypto = new NodeCryptoV2();
  const pinnedStore = new LocalPinnedWorkflowStoreV2(dataDir, fsPort);

  return {
    workflowService: {
      listWorkflowSummaries: async () => [],
      getWorkflowById: async (id: string) => (id === REFS_WORKFLOW_ID ? wf : null),
      getNextStep: async () => { throw new Error('not used'); },
      validateStepOutput: async () => ({ valid: true, issues: [], suggestions: [] }),
    } as any,
    featureFlags: null as any,
    sessionManager: null,
    httpServer: null,
    v2: {
      crypto,
      pinnedStore,
      validationPipelineDeps: createTestValidationPipelineDeps(),
    },
  } as any;
}

function createCtxWithoutReferences(): ToolContext {
  const wf = createWorkflow(
    {
      id: 'no-refs',
      name: 'Workflow Without References',
      description: 'Test',
      version: '0.1.0',
      steps: [{ id: 'step1', title: 'Step 1', prompt: 'Do stuff' }],
    } as any,
    createProjectDirectorySource(path.join(os.tmpdir(), 'workrail-inspect-norefs'))
  );

  const dataDir = new LocalDataDirV2(process.env);
  const fsPort = new NodeFileSystemV2();
  const crypto = new NodeCryptoV2();
  const pinnedStore = new LocalPinnedWorkflowStoreV2(dataDir, fsPort);

  return {
    workflowService: {
      listWorkflowSummaries: async () => [],
      getWorkflowById: async (id: string) => (id === 'no-refs' ? wf : null),
      getNextStep: async () => { throw new Error('not used'); },
      validateStepOutput: async () => ({ valid: true, issues: [], suggestions: [] }),
    } as any,
    featureFlags: null as any,
    sessionManager: null,
    httpServer: null,
    v2: {
      crypto,
      pinnedStore,
      validationPipelineDeps: createTestValidationPipelineDeps(),
    },
  } as any;
}

describe('inspect_workflow references', () => {
  it('includes references when workflow declares them', async () => {
    const ctx = createCtxWithReferences();
    const result = await handleV2InspectWorkflow(
      { workflowId: REFS_WORKFLOW_ID, mode: 'preview' } as any,
      ctx,
    );

    expect(result.type).toBe('success');
    if (result.type !== 'success') return;

    const data = result.data as Record<string, unknown>;
    expect(data.references).toBeDefined();
    const refs = data.references as Array<Record<string, unknown>>;
    expect(refs).toHaveLength(2);
    expect(refs[0]!.id).toBe('api-spec');
    expect(refs[0]!.authoritative).toBe(true);
    expect(refs[1]!.id).toBe('team-guide');
    expect(refs[1]!.authoritative).toBe(false);
  });

  it('omits references when workflow has none', async () => {
    const ctx = createCtxWithoutReferences();
    const result = await handleV2InspectWorkflow(
      { workflowId: 'no-refs', mode: 'preview' } as any,
      ctx,
    );

    expect(result.type).toBe('success');
    if (result.type !== 'success') return;

    const data = result.data as Record<string, unknown>;
    expect(data.references).toBeUndefined();
  });
});
