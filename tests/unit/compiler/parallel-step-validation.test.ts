/**
 * Tests for parallel step schema validation and registry cross-reference checking.
 */
import { describe, it, expect } from 'vitest';
import { createWorkflow } from '../../../src/types/workflow.js';
import { createBundledSource } from '../../../src/types/workflow-source.js';
import type { Workflow } from '../../../src/types/workflow.js';
import type { WorkflowDefinition } from '../../../src/types/workflow-definition.js';
import { validateWorkflowSchema } from '../../../src/application/validation.js';
import { validateRegistry } from '../../../src/application/use-cases/validate-workflow-registry.js';
import { ValidationEngine } from '../../../src/application/services/validation-engine.js';
import { EnhancedLoopValidator } from '../../../src/application/services/enhanced-loop-validator.js';
import { WorkflowCompiler } from '../../../src/application/services/workflow-compiler.js';
import { normalizeV1WorkflowToPinnedSnapshot } from '../../../src/v2/read-only/v1-to-v2-shim.js';
import type { RegistrySnapshot, RegistryValidatorDeps } from '../../../src/application/use-cases/validate-workflow-registry.js';
import type { SourceRef } from '../../../src/infrastructure/storage/workflow-resolution.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkflow(definition: WorkflowDefinition): Workflow {
  return createWorkflow(definition, createBundledSource());
}

function fakePipelineDeps(): RegistryValidatorDeps {
  const loopValidator = new EnhancedLoopValidator();
  const validationEngine = new ValidationEngine(loopValidator);
  const compiler = new WorkflowCompiler();

  return {
    schemaValidate: validateWorkflowSchema,
    structuralValidate: validationEngine.validateWorkflowStructureOnly.bind(validationEngine),
    compiler,
    normalizeToExecutable: normalizeV1WorkflowToPinnedSnapshot,
  };
}

function fakeSnapshot(resolved: Workflow[]): RegistrySnapshot {
  return {
    sources: [createBundledSource()],
    rawFiles: resolved.map(w => ({
      kind: 'parsed',
      filePath: '/mock/workflows/' + w.definition.id + '.json',
      relativeFilePath: w.definition.id + '.json',
      definition: w.definition,
      variantKind: 'standard',
    })),
    candidates: [{
      sourceRef: 0 as SourceRef,
      workflows: resolved,
      variantResolutions: new Map(),
    }],
    resolved: resolved.map(w => ({
      workflow: w,
      resolvedBy: { kind: 'unique', sourceRef: 0 as SourceRef },
    })),
    duplicates: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Parallel Step validation — JSON Schema & Structural Checks', () => {
  it('accepts a valid parallel step configuration', () => {
    const wfDef: WorkflowDefinition = {
      id: 'test-parallel-valid',
      name: 'Valid Parallel Step',
      description: 'Tests a valid parallel step definition',
      version: '1.0.0',
      steps: [
        {
          id: 'parallel-gate-1',
          title: 'Spawn Subagents',
          type: 'parallel',
          parallelDelegations: [
            {
              workflowId: 'wr.routine-context-gathering',
              contextMapping: {
                focusArea: 'focus',
              },
            },
            {
              workflowId: 'wr.routine-philosophy-alignment',
            },
          ],
        },
      ],
    };

    const wf = makeWorkflow(wfDef);
    const schemaResult = validateWorkflowSchema(wf);
    expect(schemaResult.isOk()).toBe(true);

    const deps = fakePipelineDeps();
    const structuralResult = deps.structuralValidate(wf);
    expect(structuralResult.isOk()).toBe(true);
  });

  it('rejects a parallel step with missing delegations', () => {
    const wfDef: WorkflowDefinition = {
      id: 'test-parallel-missing-delegations',
      name: 'Invalid Parallel Step',
      description: 'Tests missing parallelDelegations field',
      version: '1.0.0',
      steps: [
        {
          id: 'parallel-gate-1',
          title: 'Spawn Subagents',
          type: 'parallel',
        } as any,
      ],
    };

    const wf = makeWorkflow(wfDef);
    const schemaResult = validateWorkflowSchema(wf);
    expect(schemaResult.isErr()).toBe(true);
  });

  it('rejects mixing prompt or loop configs on a parallel step type', () => {
    const wfDef: WorkflowDefinition = {
      id: 'test-parallel-mixed-properties',
      name: 'Mixed Properties Parallel Step',
      description: 'Tests mixing prompt and loop properties on parallel step type',
      version: '1.0.0',
      steps: [
        {
          id: 'parallel-gate-1',
          title: 'Spawn Subagents',
          type: 'parallel',
          prompt: 'Do not mix prompts here.',
          parallelDelegations: [
            {
              workflowId: 'wr.routine-context-gathering',
            },
          ],
        } as any,
      ],
    };

    const wf = makeWorkflow(wfDef);
    const schemaResult = validateWorkflowSchema(wf);
    expect(schemaResult.isErr()).toBe(true);
  });
});

describe('Parallel Step validation — Registry Cross-Reference Checks', () => {
  it('passes registry validation when all referenced workflows exist', () => {
    const referencedWf = makeWorkflow({
      id: 'subagent-workflow',
      name: 'Subagent Workflow',
      description: 'Subagent target',
      version: '1.0.0',
      steps: [{ id: 'step-1', title: 'Step 1', prompt: 'Work.' }],
    });

    const parentWf = makeWorkflow({
      id: 'parent-workflow',
      name: 'Parent Workflow',
      description: 'Parent dispatcher',
      version: '1.0.0',
      steps: [
        {
          id: 'parallel-step',
          title: 'Run Subagent',
          type: 'parallel',
          parallelDelegations: [
            {
              workflowId: 'subagent-workflow',
            },
          ],
        },
      ],
    });

    const snapshot = fakeSnapshot([referencedWf, parentWf]);
    const deps = fakePipelineDeps();

    const report = validateRegistry(snapshot, deps);
    expect(report.isValid).toBe(true);
    expect(report.tier1FailedRawFiles).toBe(0);
  });

  it('fails registry validation when a subagent ID is unregistered', () => {
    const parentWf = makeWorkflow({
      id: 'parent-workflow',
      name: 'Parent Workflow',
      description: 'Parent dispatcher',
      version: '1.0.0',
      steps: [
        {
          id: 'parallel-step',
          title: 'Run Missing Subagent',
          type: 'parallel',
          parallelDelegations: [
            {
              workflowId: 'missing-subagent-workflow',
            },
          ],
        },
      ],
    });

    const snapshot = fakeSnapshot([parentWf]);
    const deps = fakePipelineDeps();

    const report = validateRegistry(snapshot, deps);
    expect(report.isValid).toBe(false);
    
    const failedEntry = report.resolvedResults.find(r => r.workflowId === 'parent-workflow');
    expect(failedEntry).toBeDefined();
    expect(failedEntry!.outcome.kind).toBe('structural_failed');
    
    const outcome = failedEntry!.outcome as { readonly issues: readonly string[] };
    expect(outcome.issues).toEqual(
      expect.arrayContaining([expect.stringContaining("delegates to unregistered workflow ID 'missing-subagent-workflow'")]),
    );
  });

  it('fails registry validation when a workflow delegates to itself (circular prevention)', () => {
    const selfSpawningWf = makeWorkflow({
      id: 'circular-workflow',
      name: 'Circular Workflow',
      description: 'Self-spawner',
      version: '1.0.0',
      steps: [
        {
          id: 'parallel-step',
          title: 'Circular Spawner',
          type: 'parallel',
          parallelDelegations: [
            {
              workflowId: 'circular-workflow',
            },
          ],
        },
      ],
    });

    const snapshot = fakeSnapshot([selfSpawningWf]);
    const deps = fakePipelineDeps();

    const report = validateRegistry(snapshot, deps);
    expect(report.isValid).toBe(false);

    const failedEntry = report.resolvedResults.find(r => r.workflowId === 'circular-workflow');
    expect(failedEntry).toBeDefined();
    expect(failedEntry!.outcome.kind).toBe('structural_failed');

    const outcome = failedEntry!.outcome as { readonly issues: readonly string[] };
    expect(outcome.issues).toEqual(
      expect.arrayContaining([expect.stringContaining("circular loop is prohibited")]),
    );
  });

  it('fails registry validation when a transitive cycle is detected (e.g. A -> B -> A)', () => {
    const wfA = makeWorkflow({
      id: 'workflow-a',
      name: 'Workflow A',
      description: 'Delegator A',
      version: '1.0.0',
      steps: [
        {
          id: 'parallel-step-a',
          title: 'Spawns B',
          type: 'parallel',
          parallelDelegations: [
            {
              workflowId: 'workflow-b',
            },
          ],
        },
      ],
    });

    const wfB = makeWorkflow({
      id: 'workflow-b',
      name: 'Workflow B',
      description: 'Delegator B',
      version: '1.0.0',
      steps: [
        {
          id: 'parallel-step-b',
          title: 'Spawns A',
          type: 'parallel',
          parallelDelegations: [
            {
              workflowId: 'workflow-a',
            },
          ],
        },
      ],
    });

    const snapshot = fakeSnapshot([wfA, wfB]);
    const deps = fakePipelineDeps();

    const report = validateRegistry(snapshot, deps);
    expect(report.isValid).toBe(false);

    const failedEntry = report.resolvedResults.find(r => r.workflowId === 'workflow-a');
    expect(failedEntry).toBeDefined();
    expect(failedEntry!.outcome.kind).toBe('structural_failed');

    const outcome = failedEntry!.outcome as { readonly issues: readonly string[] };
    expect(outcome.issues).toEqual(
      expect.arrayContaining([expect.stringContaining("Transitive circular spawning cycle detected: workflow-a -> workflow-b -> workflow-a")]),
    );
  });
});
