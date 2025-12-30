import { describe, it, expect } from 'vitest';

import { InvalidWorkflowError } from '../../src/core/error-handler';
import { InMemoryWorkflowStorage } from '../../src/infrastructure/storage/in-memory-storage';
import { SchemaValidatingCompositeWorkflowStorage } from '../../src/infrastructure/storage/schema-validating-workflow-storage';
import { EnhancedMultiSourceWorkflowStorage } from '../../src/infrastructure/storage/enhanced-multi-source-workflow-storage';
import type { WorkflowDefinition } from '../../src/types/workflow';
import { createBundledSource, createProjectDirectorySource } from '../../src/types/workflow';

function def(id: string, name = id): WorkflowDefinition {
  return {
    id,
    name,
    description: 'desc',
    version: '1.0.0',
    steps: [
      {
        id: 'step-1',
        title: 'Step 1',
        prompt: 'Do the thing',
      },
    ],
  };
}

describe('SchemaValidatingCompositeWorkflowStorage namespace enforcement', () => {
  it('rejects wr.* on save (uses project sourceKind conservatively)', async () => {
    const inner = new EnhancedMultiSourceWorkflowStorage({
      includeBundled: false,
      includeUser: false,
      includeProject: false,
    });

    const storage = new SchemaValidatingCompositeWorkflowStorage(inner);

    await expect(storage.save(def('wr.hacked'))).rejects.toThrow(InvalidWorkflowError);
  });

  it('filters wr.* from non-bundled sources on load', async () => {
    const bundled = new InMemoryWorkflowStorage([def('wr.core', 'Bundled Core')], createBundledSource());
    const project = new InMemoryWorkflowStorage(
      [def('wr.sneaky', 'Shadow Attempt'), def('project.valid', 'Valid Project')],
      createProjectDirectorySource('/tmp/workrail-project')
    );

    const base = new EnhancedMultiSourceWorkflowStorage({
      includeBundled: false,
      includeUser: false,
      includeProject: false,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (base as any).storageInstances = [bundled, project];

    const storage = new SchemaValidatingCompositeWorkflowStorage(base);

    const workflows = await storage.loadAllWorkflows();
    const wrWorkflows = workflows.filter((w) => w.definition.id.startsWith('wr.'));

    // Only bundled wr.* workflows should pass validation
    expect(wrWorkflows.every((w) => w.source.kind === 'bundled')).toBe(true);
    expect(wrWorkflows.map((w) => w.definition.id)).toEqual(['wr.core']);
  });

  it('allows loading legacy IDs (warn-only)', async () => {
    const inner = new EnhancedMultiSourceWorkflowStorage({
      includeBundled: false,
      includeUser: false,
      includeProject: false,
    });

    const project = new InMemoryWorkflowStorage([def('legacy-id')], createProjectDirectorySource('/tmp/proj'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (inner as any).storageInstances = [project];

    const storage = new SchemaValidatingCompositeWorkflowStorage(inner);

    const workflows = await storage.loadAllWorkflows();
    expect(workflows.map((w) => w.definition.id)).toContain('legacy-id');
  });

  it('rejects saving legacy IDs (no dot)', async () => {
    const inner = new EnhancedMultiSourceWorkflowStorage({
      includeBundled: false,
      includeUser: false,
      includeProject: false,
    });

    const storage = new SchemaValidatingCompositeWorkflowStorage(inner);

    await expect(storage.save(def('legacy_id'))).rejects.toThrow(InvalidWorkflowError);
  });
});
