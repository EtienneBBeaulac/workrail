import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';

import { InvalidWorkflowError } from '../../src/core/error-handler';
import { InMemoryWorkflowStorage } from '../../src/infrastructure/storage/in-memory-storage';
import { SchemaValidatingCompositeWorkflowStorage, SchemaValidatingWorkflowStorage } from '../../src/infrastructure/storage/schema-validating-workflow-storage';
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
      createProjectDirectorySource(path.join(os.tmpdir(), 'workrail-project'))
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

    const project = new InMemoryWorkflowStorage([def('legacy-id')], createProjectDirectorySource(path.join(os.tmpdir(), 'workrail-proj')));
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

// ---------------------------------------------------------------------------
// loadAllWorkflowsWithWarnings() -- validation warnings surface
// ---------------------------------------------------------------------------

describe('SchemaValidatingCompositeWorkflowStorage.loadAllWorkflowsWithWarnings()', () => {
  it('returns warning entry for non-bundled workflow that fails schema validation', async () => {
    const projectSource = createProjectDirectorySource(path.join(os.tmpdir(), 'wr-test-warnings'));
    // A definition missing 'steps' will fail Ajv validation (steps is required).
    const invalidDef = { id: 'invalid-workflow', name: 'Bad', description: 'desc', version: '1.0.0' } as unknown as WorkflowDefinition;
    const project = new InMemoryWorkflowStorage([invalidDef], projectSource);

    const base = new EnhancedMultiSourceWorkflowStorage({
      includeBundled: false,
      includeUser: false,
      includeProject: false,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (base as any).storageInstances = [project];

    const storage = new SchemaValidatingCompositeWorkflowStorage(base);
    const { workflows, warnings } = await storage.loadAllWorkflowsWithWarnings();

    expect(workflows).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.workflowId).toBe('invalid-workflow');
    expect(warnings[0]!.sourceKind).toBe('project');
    expect(warnings[0]!.errors).toHaveLength(1);
    expect(warnings[0]!.errors[0]).toBeTruthy();
  });

  it('does NOT include bundled workflow failures in warnings', async () => {
    const bundledSource = createBundledSource();
    const invalidDef = { id: 'wr.invalid', name: 'Bad', description: 'desc', version: '1.0.0' } as unknown as WorkflowDefinition;
    const bundled = new InMemoryWorkflowStorage([invalidDef], bundledSource);

    const base = new EnhancedMultiSourceWorkflowStorage({
      includeBundled: false,
      includeUser: false,
      includeProject: false,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (base as any).storageInstances = [bundled];

    const storage = new SchemaValidatingCompositeWorkflowStorage(base);
    const { workflows, warnings } = await storage.loadAllWorkflowsWithWarnings();

    // Bundled failure should be excluded from warnings (still filtered from workflows)
    expect(workflows).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('returns empty warnings when all workflows pass validation', async () => {
    const projectSource = createProjectDirectorySource(path.join(os.tmpdir(), 'wr-test-valid'));
    const project = new InMemoryWorkflowStorage([def('valid-workflow')], projectSource);

    const base = new EnhancedMultiSourceWorkflowStorage({
      includeBundled: false,
      includeUser: false,
      includeProject: false,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (base as any).storageInstances = [project];

    const storage = new SchemaValidatingCompositeWorkflowStorage(base);
    const { workflows, warnings } = await storage.loadAllWorkflowsWithWarnings();

    expect(workflows).toHaveLength(1);
    expect(warnings).toHaveLength(0);
  });
});

describe('SchemaValidatingWorkflowStorage.loadAllWorkflowsWithWarnings()', () => {
  it('returns warning entry for non-bundled workflow that fails schema validation', async () => {
    const projectSource = createProjectDirectorySource(path.join(os.tmpdir(), 'wr-test-single-warnings'));
    const invalidDef = { id: 'invalid-single', name: 'Bad', description: 'desc', version: '1.0.0' } as unknown as WorkflowDefinition;
    const inner = new InMemoryWorkflowStorage([invalidDef], projectSource);

    const storage = new SchemaValidatingWorkflowStorage(inner);
    const { workflows, warnings } = await storage.loadAllWorkflowsWithWarnings();

    expect(workflows).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.workflowId).toBe('invalid-single');
    expect(warnings[0]!.sourceKind).toBe('project');
    expect(warnings[0]!.errors).toHaveLength(1);
  });

  it('does NOT include bundled workflow failures in warnings', async () => {
    const bundledSource = createBundledSource();
    const invalidDef = { id: 'wr.invalid-single', name: 'Bad', description: 'desc', version: '1.0.0' } as unknown as WorkflowDefinition;
    const inner = new InMemoryWorkflowStorage([invalidDef], bundledSource);

    const storage = new SchemaValidatingWorkflowStorage(inner);
    const { workflows, warnings } = await storage.loadAllWorkflowsWithWarnings();

    expect(workflows).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });
});
