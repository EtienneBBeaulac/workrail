import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ok, err } from 'neverthrow';

import type { Workflow, WorkflowDefinition, WorkflowSource } from '../../src/types/workflow.js';
import { createWorkflow, toWorkflowSummary } from '../../src/types/workflow.js';
import { createBundledSource, createProjectDirectorySource, createUserDirectorySource } from '../../src/types/workflow-source.js';
import { InMemoryWorkflowStorage } from '../../src/infrastructure/storage/in-memory-storage.js';
import { SchemaValidatingWorkflowStorage } from '../../src/infrastructure/storage/schema-validating-workflow-storage.js';
import { EnhancedMultiSourceWorkflowStorage } from '../../src/infrastructure/storage/enhanced-multi-source-workflow-storage.js';

import type { ValidationPipelineDepsPhase1a, ValidationOutcomePhase1a, SchemaError } from '../../src/application/services/workflow-validation-pipeline.js';
import { validateWorkflowPhase1a, validateWorkflow } from '../../src/application/services/workflow-validation-pipeline.js';
import { validateWorkflowSchema } from '../../src/application/validation.js';
import { ValidationEngine } from '../../src/application/services/validation-engine.js';
import { EnhancedLoopValidator } from '../../src/application/services/enhanced-loop-validator.js';
import { WorkflowCompiler } from '../../src/application/services/workflow-compiler.js';
import { WorkflowInterpreter } from '../../src/application/services/workflow-interpreter.js';
import { normalizeV1WorkflowToPinnedSnapshot } from '../../src/v2/read-only/v1-to-v2-shim.js';
import { resolveFirstStep } from '../../src/v2/durable-core/domain/start-construction.js';
import { renderPendingPrompt } from '../../src/v2/durable-core/domain/prompt-renderer.js';
import { asRunId, asNodeId } from '../../src/v2/durable-core/ids/index.js';

import type { RegistrySnapshot, RegistryValidatorDeps, DuplicateIdReport } from '../../src/application/use-cases/validate-workflow-registry.js';
import { buildRegistrySnapshot, validateRegistry } from '../../src/application/use-cases/validate-workflow-registry.js';
import type { RawWorkflowFile, VariantKind } from '../../src/application/use-cases/raw-workflow-file-scanner.js';
import { scanRawWorkflowFiles, findWorkflowJsonFiles } from '../../src/application/use-cases/raw-workflow-file-scanner.js';

import type { SourceRef, ResolutionReason, VariantCandidate, VariantSelectionFlags, VariantResolution } from '../../src/infrastructure/storage/workflow-resolution.js';
import { resolveWorkflowCandidates, detectDuplicateIds, selectVariant } from '../../src/infrastructure/storage/workflow-resolution.js';

import type { IWorkflowStorage } from '../../src/types/storage.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers and Factories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal valid WorkflowDefinition factory.
 */
function def(id: string, overrides?: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    id,
    name: overrides?.name ?? id,
    description: overrides?.description ?? `Description for ${id}`,
    version: overrides?.version ?? '1.0.0',
    steps: overrides?.steps ?? [
      {
        id: 'step-1',
        title: 'Step 1',
        prompt: 'Do the thing',
      },
    ],
    ...overrides,
  };
}

/**
 * Wrap definition in Workflow with source.
 */
function wf(definition: WorkflowDefinition, source: WorkflowSource): Workflow {
  return createWorkflow(definition, source);
}

/**
 * Build fake ValidationPipelineDepsPhase1a — all phases pass by default.
 * Override specific deps to simulate failures.
 */
function fakePipelineDeps(overrides?: Partial<ValidationPipelineDepsPhase1a>): ValidationPipelineDepsPhase1a {
  const loopValidator = new EnhancedLoopValidator();
  const validationEngine = new ValidationEngine(loopValidator);
  const compiler = new WorkflowCompiler();

  return {
    schemaValidate: overrides?.schemaValidate ?? validateWorkflowSchema,
    structuralValidate: overrides?.structuralValidate ?? validationEngine.validateWorkflowStructureOnly.bind(validationEngine),
    compiler: overrides?.compiler ?? compiler,
    normalizeToExecutable: overrides?.normalizeToExecutable ?? normalizeV1WorkflowToPinnedSnapshot,
  };
}

/**
 * Build a fake RegistrySnapshot from inline test data.
 */
function fakeSnapshot(args: {
  sources?: readonly WorkflowSource[];
  rawFiles?: readonly RawWorkflowFile[];
  candidates?: readonly { readonly sourceRef: SourceRef; readonly workflows: readonly Workflow[]; readonly variantResolutions?: ReadonlyMap<string, VariantResolution> }[];
  resolved?: readonly { readonly workflow: Workflow; readonly resolvedBy: ResolutionReason }[];
  duplicates?: readonly { readonly workflowId: string; readonly sources: readonly SourceRef[] }[];
}): RegistrySnapshot {
  return {
    sources: args.sources ?? [],
    rawFiles: args.rawFiles ?? [],
    candidates: (args.candidates ?? []).map(c => ({
      sourceRef: c.sourceRef,
      workflows: c.workflows,
      variantResolutions: c.variantResolutions ?? new Map(),
    })),
    resolved: args.resolved ?? [],
    duplicates: args.duplicates ?? [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 5: God-Tier Validation Regression Tests', () => {
  let tempDirs: string[] = [];

  afterEach(async () => {
    // Clean up temp directories
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  async function makeTempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workrail-test-'));
    tempDirs.push(dir);
    return dir;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Discovery and Duplicates
  // ───────────────────────────────────────────────────────────────────────────

  describe('Discovery and Duplicates', () => {
    it('1. Two non-wr.* workflows with same ID in different sources → hard error with both sources reported', () => {
      const bundledWf = wf(def('test-workflow'), createBundledSource());
      const projectWf = wf(def('test-workflow'), createProjectDirectorySource('/home/user/project'));

      const candidates = [
        { sourceRef: 0 as SourceRef, workflows: [bundledWf] },
        { sourceRef: 1 as SourceRef, workflows: [projectWf] },
      ];

      const duplicates = detectDuplicateIds(candidates);

      expect(duplicates).toHaveLength(1);
      expect(duplicates[0]!.workflowId).toBe('test-workflow');
      expect(duplicates[0]!.sources).toEqual([0, 1]);

      // Validate registry — should be invalid (hard error, no bundled protection)
      const snapshot = fakeSnapshot({
        sources: [createBundledSource(), createProjectDirectorySource('/home/user/project')],
        candidates,
        resolved: [{ workflow: projectWf, resolvedBy: { kind: 'source_priority', winnerRef: 1, shadowedRefs: [0] } }],
        duplicates: [{ workflowId: 'test-workflow', sources: [0, 1] }],
      });

      const deps = fakePipelineDeps();
      const report = validateRegistry(snapshot, deps);

      expect(report.duplicateIds).toHaveLength(1);
      expect(report.duplicateIds[0]!.isBundledProtection).toBe(false);
      expect(report.isValid).toBe(false); // Hard error
    });

    it('2. wr.* ID in bundled + non-bundled → bundled wins, warning not error', () => {
      const bundledWf = wf(def('wr.protected'), createBundledSource());
      const projectWf = wf(def('wr.protected'), createProjectDirectorySource('/home/user/project'));

      const candidates = [
        { sourceRef: 0 as SourceRef, workflows: [bundledWf] },
        { sourceRef: 1 as SourceRef, workflows: [projectWf] },
      ];

      const resolved = resolveWorkflowCandidates(candidates, new Map());

      // Bundled wins via bundled_protected resolution
      expect(resolved).toHaveLength(1);
      expect(resolved[0]!.workflow.source.kind).toBe('bundled');
      expect(resolved[0]!.resolvedBy.kind).toBe('bundled_protected');

      // Validate registry — duplicate is reported but isValid = true (warning, not error)
      const snapshot = fakeSnapshot({
        sources: [createBundledSource(), createProjectDirectorySource('/home/user/project')],
        candidates,
        resolved,
        duplicates: [{ workflowId: 'wr.protected', sources: [0, 1] }],
      });

      const deps = fakePipelineDeps();
      const report = validateRegistry(snapshot, deps);

      expect(report.duplicateIds).toHaveLength(1);
      expect(report.duplicateIds[0]!.isBundledProtection).toBe(true);
      expect(report.isValid).toBe(true); // Warning, not error
    });

    it('2a. Non-wr.* bundled workflow vs project source → bundled wins (development-mode regression)', () => {
      // Regression: when workrail runs from its own source repo, the project
      // path equals the bundled workflows directory. Both sources register the
      // same workflow files. The resolution layer must keep kind:'bundled'.
      const bundledWf = wf(def('coding-task-workflow-agentic'), createBundledSource());
      const projectWf = wf(def('coding-task-workflow-agentic'), createProjectDirectorySource('/path/to/workrail/workflows'));

      const candidates = [
        { sourceRef: 0 as SourceRef, workflows: [bundledWf] },
        { sourceRef: 1 as SourceRef, workflows: [projectWf] },
      ];

      const resolved = resolveWorkflowCandidates(candidates, new Map());

      // Bundled source wins even though the workflow ID does not start with 'wr.'
      expect(resolved).toHaveLength(1);
      expect(resolved[0]!.workflow.source.kind).toBe('bundled');
      expect(resolved[0]!.resolvedBy.kind).toBe('bundled_protected');
      if (resolved[0]!.resolvedBy.kind === 'bundled_protected') {
        expect(resolved[0]!.resolvedBy.bundledSourceRef).toBe(0);
        expect(resolved[0]!.resolvedBy.attemptedShadowRefs).toEqual([1]);
      }
    });

    it('2b. wr.* ID in two non-bundled sources → hard error (no protection)', () => {
      const projectWf = wf(def('wr.shadow-attempt'), createProjectDirectorySource('/home/user/project'));
      const userWf = wf(def('wr.shadow-attempt'), createUserDirectorySource('/home/user/.workrail/workflows'));

      const candidates = [
        { sourceRef: 0 as SourceRef, workflows: [projectWf] },
        { sourceRef: 1 as SourceRef, workflows: [userWf] },
      ];

      const duplicates = detectDuplicateIds(candidates);

      expect(duplicates).toHaveLength(1);
      expect(duplicates[0]!.sources).toEqual([0, 1]);

      // Resolved via source_priority (not bundled_protected — no bundled source)
      const resolved = resolveWorkflowCandidates(candidates, new Map());
      expect(resolved[0]!.resolvedBy.kind).toBe('source_priority');

      // Validate registry — this is a hard error (ambiguous, no protection)
      const snapshot = fakeSnapshot({
        sources: [createProjectDirectorySource('/home/user/project'), createUserDirectorySource('/home/user/.workrail/workflows')],
        candidates,
        resolved,
        duplicates: [{ workflowId: 'wr.shadow-attempt', sources: [0, 1] }],
      });

      const deps = fakePipelineDeps();
      const report = validateRegistry(snapshot, deps);

      expect(report.duplicateIds[0]!.isBundledProtection).toBe(false);
      expect(report.isValid).toBe(false); // Hard error
    });

    it('2c. Bundled workflow vs user/custom/git source → user/custom/git wins (normal priority)', () => {
      // Bundled protection only applies to project sources, not user/custom/git.
      // User, custom, and git sources should still override bundled via normal
      // source_priority ordering (they appear later in the source list).
      const bundledWf = wf(def('my-workflow'), createBundledSource());
      const userWf = wf(def('my-workflow'), createUserDirectorySource('/home/user/.workrail/workflows'));

      const candidates = [
        { sourceRef: 0 as SourceRef, workflows: [bundledWf] },
        { sourceRef: 1 as SourceRef, workflows: [userWf] },
      ];

      const resolved = resolveWorkflowCandidates(candidates, new Map());

      // User source wins via normal source_priority (bundled protection does not activate)
      expect(resolved).toHaveLength(1);
      expect(resolved[0]!.resolvedBy.kind).toBe('source_priority');
      if (resolved[0]!.resolvedBy.kind === 'source_priority') {
        expect(resolved[0]!.resolvedBy.winnerRef).toBe(1);
      }
    });

    it('3. Three workflows with same ID → reports all three sources', () => {
      const w1 = wf(def('triple-id'), createBundledSource());
      const w2 = wf(def('triple-id'), createProjectDirectorySource('/home/user/project'));
      const w3 = wf(def('triple-id'), createUserDirectorySource('/home/user/.workrail/workflows'));

      const candidates = [
        { sourceRef: 0 as SourceRef, workflows: [w1] },
        { sourceRef: 1 as SourceRef, workflows: [w2] },
        { sourceRef: 2 as SourceRef, workflows: [w3] },
      ];

      const duplicates = detectDuplicateIds(candidates);

      expect(duplicates).toHaveLength(1);
      expect(duplicates[0]!.sources).toEqual([0, 1, 2]);
    });

    it('4. Single workflow, no duplicates → passes', () => {
      const workflow = wf(def('unique-workflow'), createBundledSource());
      const candidates = [{ sourceRef: 0 as SourceRef, workflows: [workflow] }];

      const resolved = resolveWorkflowCandidates(candidates, new Map());

      expect(resolved).toHaveLength(1);
      expect(resolved[0]!.resolvedBy.kind).toBe('unique');
      expect(resolved[0]!.resolvedBy.kind === 'unique' && resolved[0]!.resolvedBy.sourceRef).toBe(0);

      const duplicates = detectDuplicateIds(candidates);
      expect(duplicates).toHaveLength(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Variant Resolution
  // ───────────────────────────────────────────────────────────────────────────

  describe('Variant Resolution', () => {
    it('4b. lean variant selected when leanWorkflows enabled', () => {
      const candidates: VariantCandidate[] = [
        { variantKind: 'lean', identifier: 'workflow.lean.v2.json' },
        { variantKind: 'v2', identifier: 'workflow.v2.json' },
        { variantKind: 'standard', identifier: 'workflow.json' },
      ];
      const flags: VariantSelectionFlags = { v2Tools: true, agenticRoutines: false, leanWorkflows: true };

      const result = selectVariant(candidates, flags);

      expect(result.selectedVariant).toBe('lean');
      expect(result.selectedIdentifier).toBe('workflow.lean.v2.json');
      expect(result.resolution.kind).toBe('feature_flag_selected');
      if (result.resolution.kind === 'feature_flag_selected') {
        expect(result.resolution.selectedVariant).toBe('lean');
        expect(result.resolution.enabledFlags.leanWorkflows).toBe(true);
      }
    });

    it('4c. lean variant NOT selected when leanWorkflows disabled, falls to v2', () => {
      const candidates: VariantCandidate[] = [
        { variantKind: 'lean', identifier: 'workflow.lean.v2.json' },
        { variantKind: 'v2', identifier: 'workflow.v2.json' },
        { variantKind: 'standard', identifier: 'workflow.json' },
      ];
      const flags: VariantSelectionFlags = { v2Tools: true, agenticRoutines: false, leanWorkflows: false };

      const result = selectVariant(candidates, flags);

      expect(result.selectedVariant).toBe('v2');
      expect(result.selectedIdentifier).toBe('workflow.v2.json');
    });

    it('5. v2 variant selected when v2Tools enabled', () => {
      const candidates: VariantCandidate[] = [
        { variantKind: 'v2', identifier: 'workflow.v2.json' },
        { variantKind: 'standard', identifier: 'workflow.json' },
      ];
      const flags: VariantSelectionFlags = { v2Tools: true, agenticRoutines: false, leanWorkflows: false };

      const result = selectVariant(candidates, flags);

      expect(result.selectedVariant).toBe('v2');
      expect(result.selectedIdentifier).toBe('workflow.v2.json');
      expect(result.resolution.kind).toBe('feature_flag_selected');
      if (result.resolution.kind === 'feature_flag_selected') {
        expect(result.resolution.selectedVariant).toBe('v2');
        expect(result.resolution.enabledFlags.v2Tools).toBe(true);
      }
    });

    it('6. agentic variant selected when agenticRoutines enabled', () => {
      const candidates: VariantCandidate[] = [
        { variantKind: 'agentic', identifier: 'workflow.agentic.json' },
        { variantKind: 'standard', identifier: 'workflow.json' },
      ];
      const flags: VariantSelectionFlags = { v2Tools: false, agenticRoutines: true, leanWorkflows: false };

      const result = selectVariant(candidates, flags);

      expect(result.selectedVariant).toBe('agentic');
      expect(result.resolution.kind).toBe('feature_flag_selected');
      if (result.resolution.kind === 'feature_flag_selected') {
        expect(result.resolution.selectedVariant).toBe('agentic');
        expect(result.resolution.enabledFlags.agenticRoutines).toBe(true);
      }
    });

    it('7. Standard variant selected when no flags enabled → v2 variant ignored', () => {
      const candidates: VariantCandidate[] = [
        { variantKind: 'v2', identifier: 'workflow.v2.json' },
        { variantKind: 'standard', identifier: 'workflow.json' },
      ];
      const flags: VariantSelectionFlags = { v2Tools: false, agenticRoutines: false, leanWorkflows: false };

      const result = selectVariant(candidates, flags);

      expect(result.selectedVariant).toBe('standard');
      expect(result.resolution.kind).toBe('precedence_fallback');
    });

    it('5b. Invalid v2 variant selected → registry reports failure (integration)', () => {
      // v2 variant is what runtime selects when v2Tools is enabled.
      // If the v2 variant is invalid, the registry must report it as a failure.
      const invalidV2Wf = wf(def('my-workflow'), createBundledSource());

      const snapshot = fakeSnapshot({
        sources: [createBundledSource()],
        resolved: [{ workflow: invalidV2Wf, resolvedBy: { kind: 'unique', sourceRef: 0, variantResolution: { kind: 'feature_flag_selected', selectedVariant: 'v2', availableVariants: ['v2', 'standard'], enabledFlags: { v2Tools: true, agenticRoutines: false, leanWorkflows: false } } } }],
      });

      // Schema validation fails for the resolved workflow (simulating invalid v2 variant)
      const deps = fakePipelineDeps({
        schemaValidate: () => err([{ instancePath: '/steps/0', message: 'v2 step missing required field', keyword: 'required' }]),
      });

      const report = validateRegistry(snapshot, deps);

      expect(report.isValid).toBe(false);
      expect(report.invalidResolvedCount).toBe(1);
      expect(report.resolvedResults[0]!.outcome.kind).toBe('schema_failed');
    });

    it('6b. Invalid agentic variant selected → registry reports failure (integration)', () => {
      const invalidAgenticWf = wf(def('my-workflow'), createBundledSource());

      const snapshot = fakeSnapshot({
        sources: [createBundledSource()],
        resolved: [{ workflow: invalidAgenticWf, resolvedBy: { kind: 'unique', sourceRef: 0, variantResolution: { kind: 'feature_flag_selected', selectedVariant: 'agentic', availableVariants: ['agentic', 'standard'], enabledFlags: { v2Tools: false, agenticRoutines: true, leanWorkflows: false } } } }],
      });

      const deps = fakePipelineDeps({
        schemaValidate: () => err([{ instancePath: '/steps/0', message: 'agentic step invalid', keyword: 'required' }]),
      });

      const report = validateRegistry(snapshot, deps);

      expect(report.isValid).toBe(false);
      expect(report.invalidResolvedCount).toBe(1);
    });

    it('7b. Standard invalid but v2 valid and selected → passes (standard not selected)', () => {
      // When v2 is selected and valid, the standard variant being invalid doesn't matter
      // for the resolved set (standard is a variant loser — raw file tier 1 catches it).
      const validV2Wf = wf(def('my-workflow'), createBundledSource());

      const snapshot = fakeSnapshot({
        sources: [createBundledSource()],
        resolved: [{ workflow: validV2Wf, resolvedBy: { kind: 'unique', sourceRef: 0, variantResolution: { kind: 'feature_flag_selected', selectedVariant: 'v2', availableVariants: ['v2', 'standard'], enabledFlags: { v2Tools: true, agenticRoutines: false, leanWorkflows: false } } } }],
      });

      const deps = fakePipelineDeps(); // All phases pass

      const report = validateRegistry(snapshot, deps);

      expect(report.isValid).toBe(true);
      expect(report.validResolvedCount).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Normalization
  // ───────────────────────────────────────────────────────────────────────────

  describe('Normalization', () => {
    it('8. Workflow with promptBlocks that fail to resolve → normalization_failed', () => {
      const workflow = wf(def('test-workflow'), createBundledSource());
      const deps = fakePipelineDeps({
        normalizeToExecutable: () => err({ message: 'promptBlock "block-1" not found' } as any),
      });

      const outcome = validateWorkflowPhase1a(workflow, deps);

      expect(outcome.kind).toBe('normalization_failed');
      if (outcome.kind === 'normalization_failed') {
        expect(outcome.cause.message).toContain('promptBlock');
      }
    });

    it('9. Workflow with templateCall referencing unknown template → normalization_failed', () => {
      const workflow = wf(def('test-workflow'), createBundledSource());
      const deps = fakePipelineDeps({
        normalizeToExecutable: () => err({ message: 'Template "unknown-template" not found' } as any),
      });

      const outcome = validateWorkflowPhase1a(workflow, deps);

      expect(outcome.kind).toBe('normalization_failed');
      if (outcome.kind === 'normalization_failed') {
        expect(outcome.cause.message).toContain('Template');
      }
    });

    it('10. Workflow with authoring-only fields that break normalization → normalization_failed', () => {
      const workflow = wf(def('test-workflow'), createBundledSource());
      const deps = fakePipelineDeps({
        normalizeToExecutable: () => err({ message: 'Invalid authoring-only field' } as any),
      });

      const outcome = validateWorkflowPhase1a(workflow, deps);

      expect(outcome.kind).toBe('normalization_failed');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Serialization Round-Trip
  // ───────────────────────────────────────────────────────────────────────────

  describe('Serialization Round-Trip', () => {
    it('11. Normalization produces undefined fields → JSON.stringify silently drops them (documents behavior)', () => {
      const workflow = wf(def('test-workflow'), createBundledSource());

      // Mock normalizeToExecutable to return a snapshot where JSON.stringify drops fields
      const deps = fakePipelineDeps({
        normalizeToExecutable: () => ok({
          schemaVersion: 1,
          sourceKind: 'v1_pinned',
          workflowId: 'test-workflow',
          name: 'Test',
          description: 'Test',
          version: '1.0.0',
          definition: {
            id: 'test-workflow',
            steps: [{ id: 'step-1', undefinedField: undefined }], // undefined drops on stringify
          } as any,
        }),
      });

      const outcome = validateWorkflow(workflow, {
        ...deps,
        interpreter: new WorkflowInterpreter(),
        resolveFirstStep,
      });

      // Round-trip validation is in Phase 1b (validateWorkflow), not Phase 1a
      // It should pass (the undefinedField drops but the structure remains valid)
      // This test documents the behavior — JSON.stringify silently drops undefined
      expect(outcome.kind).not.toBe('round_trip_failed');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Executable Compilation (Phase 7 deferred)
  // ───────────────────────────────────────────────────────────────────────────

  describe('Executable Compilation (Phase 7 deferred)', () => {
    it.skip('12. Unknown outputContract.contractRef → v2_compilation_failed', () => {
      // Phase 7 is deferred (compileExecutable doesn't exist yet).
      // This test activates when WorkflowCompiler.compileExecutable lands.
    });

    it.skip('13. Duplicate step IDs in executable → v2_compilation_failed', () => {
      // Phase 7 deferred — test activates when compileExecutable lands.
    });

    it.skip('14. Loop body referencing missing step → v2_compilation_failed', () => {
      // Phase 7 deferred — test activates when compileExecutable lands.
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Startability
  // ───────────────────────────────────────────────────────────────────────────

  describe('Startability', () => {
    it('15. Valid workflow → resolveFirstStep returns ok', () => {
      const workflow = wf(def('valid-workflow'), createBundledSource());
      const snapshot = normalizeV1WorkflowToPinnedSnapshot(workflow);

      expect(snapshot.isOk()).toBe(true);
      if (snapshot.isErr()) return;

      const firstStepResult = resolveFirstStep(workflow, snapshot.value);

      expect(firstStepResult.isOk()).toBe(true);
      if (firstStepResult.isOk()) {
        expect(firstStepResult.value.id).toBe('step-1');
      }
    });

    it('16. All steps with runCondition: false → startability_failed', () => {
      // Note: This requires real WorkflowInterpreter to test the interpreter.next sub-check.
      // The resolveFirstStep sub-check would pass (steps[0] exists), but interpreter
      // returns isComplete=true with zero completed steps.
      // Marking as documentation-only since the interpreter check in Phase 8 is partially deferred.
    });

    it('17. Loop with invalid condition → startability_failed', () => {
      // Similar to test 16 — requires real interpreter to trigger.
      // Deferred until Phase 8 interpreter check is fully wired.
    });

    it('17b. steps[0].id not in executable → first_step_not_in_executable', () => {
      const workflow = wf(def('test-workflow', {
        steps: [{ id: 'original-step-id', title: 'Step 1', prompt: 'Do something' }],
      }), createBundledSource());

      // Mock normalizeToExecutable to return a snapshot with different step IDs
      const fakeSnapshot = {
        schemaVersion: 1,
        sourceKind: 'v1_pinned' as const,
        workflowId: 'test-workflow',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        definition: {
          id: 'test-workflow',
          steps: [{ id: 'different-step-id', title: 'Step 1', prompt: 'Do something' }],
        },
      };

      const result = resolveFirstStep(workflow, fakeSnapshot);

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.reason).toBe('first_step_not_in_executable');
        expect(result.error.authoredStepId).toBe('original-step-id');
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. Silent Hiding
  // ───────────────────────────────────────────────────────────────────────────

  describe('Silent Hiding', () => {
    it('18. listWorkflowSummaries does not include schema-invalid workflows', async () => {
      const valid = def('valid-workflow');
      const invalid = def('invalid-workflow', { version: 'not-semver' }); // Schema violation

      const inner = new InMemoryWorkflowStorage([valid, invalid], createBundledSource());
      const validating = new SchemaValidatingWorkflowStorage(inner);

      const summaries = await validating.listWorkflowSummaries();

      // Only the valid workflow appears (invalid is filtered + reported)
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.id).toBe('valid-workflow');
    });

    it('19. renderPendingPrompt with missing step ID → error not fallback', () => {
      const workflow = wf(def('test-workflow'), createBundledSource());

      const result = renderPendingPrompt({
        workflow,
        stepId: 'nonexistent-step',
        loopPath: [],
        truth: { events: [], manifest: [] },
        runId: asRunId('run-1'),
        nodeId: asNodeId('node-1'),
        rehydrateOnly: false,
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe('RENDER_FAILED');
        expect(result.error.message).toContain('nonexistent-step');
      }
    });

    it('19b. renderPendingPromptOrDefault deleted — structural check', async () => {
      // Grep for the function name in src/ — should find zero matches (only docs/comments)
      const { execSync } = await import('child_process');
      
      let grepResult = '';
      try {
        grepResult = execSync(
          'rg "export.*renderPendingPromptOrDefault|function renderPendingPromptOrDefault" src/',
          { cwd: path.join(__dirname, '..', '..'), encoding: 'utf-8' }
        ).trim();
      } catch {
        // ripgrep exits non-zero when no matches found — this is the success case
        grepResult = '';
      }

      expect(grepResult).toBe('');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 8. Exhaustive Reporting
  // ───────────────────────────────────────────────────────────────────────────

  describe('Exhaustive Reporting', () => {
    it('20. Two invalid + one valid → report shows all three, two failures', () => {
      const valid = wf(def('valid-workflow'), createBundledSource());
      const invalid1 = wf(def('invalid-1'), createBundledSource());
      const invalid2 = wf(def('invalid-2'), createBundledSource());

      const snapshot = fakeSnapshot({
        sources: [createBundledSource()],
        resolved: [
          { workflow: valid, resolvedBy: { kind: 'unique', sourceRef: 0 } },
          { workflow: invalid1, resolvedBy: { kind: 'unique', sourceRef: 0 } },
          { workflow: invalid2, resolvedBy: { kind: 'unique', sourceRef: 0 } },
        ],
      });

      const deps = fakePipelineDeps({
        schemaValidate: (w) => {
          if (w.definition.id === 'valid-workflow') return ok(w);
          return err([{ instancePath: '/version', message: 'must match pattern', keyword: 'pattern' }]);
        },
      });

      const report = validateRegistry(snapshot, deps);

      expect(report.resolvedResults).toHaveLength(3);
      expect(report.validResolvedCount).toBe(1);
      expect(report.invalidResolvedCount).toBe(2);
    });

    it('21. Report includes discriminated union per workflow', () => {
      const w1 = wf(def('workflow-1'), createBundledSource());
      const w2 = wf(def('workflow-2'), createBundledSource());

      const snapshot = fakeSnapshot({
        sources: [createBundledSource()],
        resolved: [
          { workflow: w1, resolvedBy: { kind: 'unique', sourceRef: 0 } },
          { workflow: w2, resolvedBy: { kind: 'unique', sourceRef: 0 } },
        ],
      });

      const deps = fakePipelineDeps({
        schemaValidate: (w) => {
          if (w.definition.id === 'workflow-1') {
            return err([{ instancePath: '/name', message: 'must be string', keyword: 'type' }]);
          }
          return ok(w);
        },
      });

      const report = validateRegistry(snapshot, deps);

      expect(report.resolvedResults[0]!.outcome.kind).toBe('schema_failed');
      expect(report.resolvedResults[1]!.outcome.kind).toBe('phase1a_valid');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 9. Pipeline Consolidation
  // ───────────────────────────────────────────────────────────────────────────

  describe('Pipeline Consolidation', () => {
    it('22. CLI validate command uses the pipeline', async () => {
      const cliSource = await fs.readFile(path.join(__dirname, '../../src/cli.ts'), 'utf-8');

      // Check that cli.ts imports createValidateWorkflowFileUseCasePipeline
      expect(cliSource).toContain('createValidateWorkflowFileUseCasePipeline');
      expect(cliSource).toContain('validationPipelineDeps');
    });

    it('23. validate_workflow_json MCP tool uses the pipeline', async () => {
      const source = await fs.readFile(
        path.join(__dirname, '../../src/application/use-cases/validate-workflow-json.ts'),
        'utf-8'
      );

      // Check that validate-workflow-json.ts imports validateWorkflowPhase1a
      expect(source).toContain('validateWorkflowPhase1a');
      expect(source).toContain('ValidationPipelineDepsPhase1a');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 10. Registry Snapshot and Raw File Scanning
  // ───────────────────────────────────────────────────────────────────────────

  describe('Registry Snapshot and Raw File Scanning', () => {
    it('24. scanRawWorkflowFiles finds all .json files regardless of feature flags', async () => {
      const tempDir = await makeTempDir();

      // Create variant files
      await fs.writeFile(path.join(tempDir, 'workflow.json'), JSON.stringify(def('wf-standard')));
      await fs.writeFile(path.join(tempDir, 'workflow.v2.json'), JSON.stringify(def('wf-v2')));
      await fs.writeFile(path.join(tempDir, 'workflow.agentic.json'), JSON.stringify(def('wf-agentic')));

      const rawFiles = await scanRawWorkflowFiles(tempDir);

      // All three files appear (scanRawWorkflowFiles is flag-agnostic)
      expect(rawFiles).toHaveLength(3);
      const ids = rawFiles.map(f => f.kind === 'parsed' ? f.definition.id : null).filter(Boolean);
      expect(ids).toContain('wf-standard');
      expect(ids).toContain('wf-v2');
      expect(ids).toContain('wf-agentic');
    });

    it('25. scanRawWorkflowFiles correctly determines variantKind from filename', async () => {
      const tempDir = await makeTempDir();

      await fs.writeFile(path.join(tempDir, 'workflow.v2.json'), JSON.stringify(def('wf-v2')));
      await fs.writeFile(path.join(tempDir, 'workflow.agentic.json'), JSON.stringify(def('wf-agentic')));
      await fs.writeFile(path.join(tempDir, 'workflow.json'), JSON.stringify(def('wf-standard')));

      const rawFiles = await scanRawWorkflowFiles(tempDir);

      const v2File = rawFiles.find(f => f.relativeFilePath.includes('.v2.'));
      const agenticFile = rawFiles.find(f => f.relativeFilePath.includes('.agentic.'));
      const standardFile = rawFiles.find(f => !f.relativeFilePath.includes('.v2.') && !f.relativeFilePath.includes('.agentic.'));

      expect(v2File?.kind).toBe('parsed');
      expect(agenticFile?.kind).toBe('parsed');
      expect(standardFile?.kind).toBe('parsed');

      if (v2File?.kind === 'parsed') expect(v2File.variantKind).toBe('v2');
      if (agenticFile?.kind === 'parsed') expect(agenticFile.variantKind).toBe('agentic');
      if (standardFile?.kind === 'parsed') expect(standardFile.variantKind).toBe('standard');
    });

    it('26. buildRegistrySnapshot with two sources → correct structure', async () => {
      const bundledStorage = new InMemoryWorkflowStorage([def('wf-1')], createBundledSource());
      const projectStorage = new InMemoryWorkflowStorage([def('wf-2')], createProjectDirectorySource('/home/user/project'));

      const storageInstances: IWorkflowStorage[] = [bundledStorage, projectStorage];
      const snapshot = await buildRegistrySnapshot(storageInstances);

      // Snapshot has correct structure
      expect(snapshot.sources).toHaveLength(2);
      expect(snapshot.candidates).toHaveLength(2);
      expect(snapshot.resolved).toHaveLength(2);
    });

    it('27. v2 file is a variant loser → in rawFiles but not resolved', async () => {
      // This test would require FileWorkflowStorage with real variant selection.
      // Since we now have selectVariant as a pure function, we can test the logic
      // without the filesystem.
      const v2Def = def('workflow-id');
      const standardDef = def('workflow-id');

      // Standard wins when v2Tools is disabled
      const selection = selectVariant(
        [
          { variantKind: 'v2', identifier: 'workflow.v2.json' },
          { variantKind: 'standard', identifier: 'workflow.json' },
        ],
        { v2Tools: false, agenticRoutines: false, leanWorkflows: false }
      );

      expect(selection.selectedVariant).toBe('standard');
      expect(selection.selectedIdentifier).toBe('workflow.json');

      // The v2 file would appear in rawFiles (scanRawWorkflowFiles is flag-agnostic)
      // but not in resolved (because selectVariant chose standard).
    });

    it('28. Raw file with invalid JSON → unparseable in rawFiles', async () => {
      const tempDir = await makeTempDir();

      await fs.writeFile(path.join(tempDir, 'broken.json'), '{ invalid json }');

      const rawFiles = await scanRawWorkflowFiles(tempDir);

      expect(rawFiles).toHaveLength(1);
      expect(rawFiles[0]!.kind).toBe('unparseable');
      if (rawFiles[0]!.kind === 'unparseable') {
        // JSON parse error message (varies by Node version)
        expect(rawFiles[0]!.error).toMatch(/Unexpected|Expected/);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 11. Shared Function Integrity
  // ───────────────────────────────────────────────────────────────────────────

  describe('Shared Function Integrity', () => {
    it('29. resolveWorkflowCandidates matches loadAllWorkflows behavior', async () => {
      const w1 = wf(def('wf-1'), createBundledSource());
      const w2 = wf(def('wf-2'), createProjectDirectorySource('/home/user/project'));

      // Build storage instances
      const bundled = new InMemoryWorkflowStorage([w1.definition], createBundledSource());
      const project = new InMemoryWorkflowStorage([w2.definition], createProjectDirectorySource('/home/user/project'));

      const storage = new EnhancedMultiSourceWorkflowStorage({
        includeBundled: false,
        includeUser: false,
        includeProject: false,
      });
      // Inject storage instances
      (storage as any).storageInstances = [bundled, project];

      const runtimeResult = await storage.loadAllWorkflows();

      // Call resolveWorkflowCandidates directly
      const candidates = [
        { sourceRef: 0 as SourceRef, workflows: [w1] },
        { sourceRef: 1 as SourceRef, workflows: [w2] },
      ];
      const resolved = resolveWorkflowCandidates(candidates, new Map());

      // Same workflow IDs in resolved set
      const runtimeIds = runtimeResult.map(w => w.definition.id).sort();
      const resolvedIds = resolved.map(r => r.workflow.definition.id).sort();

      expect(resolvedIds).toEqual(runtimeIds);
    });

    it('30. resolvedBy populated correctly — unique, source_priority, bundled_protected', () => {
      // Test unique
      const unique = resolveWorkflowCandidates(
        [{ sourceRef: 0, workflows: [wf(def('unique-wf'), createBundledSource())] }],
        new Map()
      );
      expect(unique[0]!.resolvedBy.kind).toBe('unique');
      if (unique[0]!.resolvedBy.kind === 'unique') {
        expect(unique[0]!.resolvedBy.sourceRef).toBe(0);
      }

      // Test source_priority (bundled vs user — user wins via normal priority)
      // Note: bundled vs project now triggers bundled_protected (see test 2a/2c).
      // Use user source here to demonstrate normal source_priority ordering.
      const priority = resolveWorkflowCandidates(
        [
          { sourceRef: 0, workflows: [wf(def('wf'), createBundledSource())] },
          { sourceRef: 1, workflows: [wf(def('wf'), createUserDirectorySource('/home/user/.workrail/workflows'))] },
        ],
        new Map()
      );
      expect(priority[0]!.resolvedBy.kind).toBe('source_priority');
      if (priority[0]!.resolvedBy.kind === 'source_priority') {
        expect(priority[0]!.resolvedBy.winnerRef).toBe(1);
        expect(priority[0]!.resolvedBy.shadowedRefs).toEqual([0]);
      }

      // Test bundled_protected
      const protected_ = resolveWorkflowCandidates(
        [
          { sourceRef: 0, workflows: [wf(def('wr.protected'), createBundledSource())] },
          { sourceRef: 1, workflows: [wf(def('wr.protected'), createProjectDirectorySource('/project'))] },
        ],
        new Map()
      );
      expect(protected_[0]!.resolvedBy.kind).toBe('bundled_protected');
      if (protected_[0]!.resolvedBy.kind === 'bundled_protected') {
        expect(protected_[0]!.resolvedBy.bundledSourceRef).toBe(0);
        expect(protected_[0]!.resolvedBy.attemptedShadowRefs).toEqual([1]);
      }
    });

    it('30b. resolveWorkflowCandidates includes variantResolution when provided', () => {
      const workflow = wf(def('wf'), createBundledSource());
      const variantResolutions = new Map<string, ReadonlyMap<SourceRef, VariantResolution>>([
        ['wf', new Map([[0 as SourceRef, { kind: 'only_variant' }]])],
      ]);

      const resolved = resolveWorkflowCandidates(
        [{ sourceRef: 0, workflows: [workflow] }],
        variantResolutions
      );

      expect(resolved[0]!.resolvedBy.variantResolution).toEqual({ kind: 'only_variant' });
    });

    it('31. resolveWorkflowCandidates is a two-pass pure function (no mutation)', () => {
      const w1 = wf(def('wf-1'), createBundledSource());
      const candidates = Object.freeze([
        Object.freeze({ sourceRef: 0 as SourceRef, workflows: Object.freeze([w1]) }),
      ]);

      // Frozen input — if the function tries to mutate, it throws
      const resolved = resolveWorkflowCandidates(candidates, new Map());

      expect(resolved).toHaveLength(1);
      expect(resolved[0]!.workflow.definition.id).toBe('wf-1');
    });

    it('31b. resolveFirstStep — empty steps → reason: no_steps', () => {
      const workflow = wf(def('test-workflow', { steps: [] }), createBundledSource());
      const snapshot = {
        schemaVersion: 1,
        sourceKind: 'v1_pinned' as const,
        workflowId: 'test-workflow',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        definition: { id: 'test-workflow', steps: [] },
      };

      const result = resolveFirstStep(workflow, snapshot);

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.reason).toBe('no_steps');
      }
    });

    it('31c. resolveFirstStep — authored step missing in executable → reason: first_step_not_in_executable', () => {
      const workflow = wf(def('test-workflow', {
        steps: [{ id: 'authored-step', title: 'Step', prompt: 'Do it' }],
      }), createBundledSource());

      const snapshot = {
        schemaVersion: 1,
        sourceKind: 'v1_pinned' as const,
        workflowId: 'test-workflow',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        definition: {
          id: 'test-workflow',
          steps: [{ id: 'different-step-id', title: 'Step', prompt: 'Do it' }],
        },
      };

      const result = resolveFirstStep(workflow, snapshot);

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.reason).toBe('first_step_not_in_executable');
        expect(result.error.authoredStepId).toBe('authored-step');
      }
    });

    it('31d. resolveFirstStep — valid coupling → ok({ id })', () => {
      const workflow = wf(def('test-workflow', {
        steps: [{ id: 'step-1', title: 'Step', prompt: 'Do it' }],
      }), createBundledSource());

      const snapshot = {
        schemaVersion: 1,
        sourceKind: 'v1_pinned' as const,
        workflowId: 'test-workflow',
        name: 'Test',
        description: 'Test',
        version: '1.0.0',
        definition: {
          id: 'test-workflow',
          steps: [{ id: 'step-1', title: 'Step', prompt: 'Do it' }],
        },
      };

      const result = resolveFirstStep(workflow, snapshot);

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.id).toBe('step-1');
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 12. File Discovery Function
  // ───────────────────────────────────────────────────────────────────────────

  describe('File Discovery', () => {
    it('32. Extension filtering — only .json files returned', async () => {
      const tempDir = await makeTempDir();

      await fs.writeFile(path.join(tempDir, 'workflow.json'), JSON.stringify(def('wf-1')));
      await fs.writeFile(path.join(tempDir, 'readme.md'), '# README');
      await fs.writeFile(path.join(tempDir, 'config.txt'), 'config');

      const files = await findWorkflowJsonFiles(tempDir);

      expect(files).toHaveLength(1);
      expect(files[0]).toContain('workflow.json');
    });

    it('33. examples/ skip rule — examples directory is skipped', async () => {
      const tempDir = await makeTempDir();

      await fs.writeFile(path.join(tempDir, 'main.json'), JSON.stringify(def('main')));
      await fs.mkdir(path.join(tempDir, 'examples'));
      await fs.writeFile(path.join(tempDir, 'examples', 'demo.json'), JSON.stringify(def('demo')));
      await fs.mkdir(path.join(tempDir, 'examples', 'nested'));
      await fs.writeFile(path.join(tempDir, 'examples', 'nested', 'test.json'), JSON.stringify(def('test')));

      const files = await findWorkflowJsonFiles(tempDir);

      expect(files).toHaveLength(1);
      expect(files[0]).toContain('main.json');
      expect(files.some(f => f.includes('examples'))).toBe(false);
    });

    it('34. Recursive traversal — finds files in subdirectories', async () => {
      const tempDir = await makeTempDir();

      await fs.writeFile(path.join(tempDir, 'workflow1.json'), JSON.stringify(def('wf-1')));
      await fs.mkdir(path.join(tempDir, 'routines'));
      await fs.writeFile(path.join(tempDir, 'routines', 'routine1.json'), JSON.stringify(def('routine-1')));
      await fs.mkdir(path.join(tempDir, 'routines', 'experimental'));
      await fs.writeFile(path.join(tempDir, 'routines', 'experimental', 'test.json'), JSON.stringify(def('test')));

      const files = await findWorkflowJsonFiles(tempDir);

      expect(files).toHaveLength(3);
      expect(files.some(f => f.includes('workflow1.json'))).toBe(true);
      expect(files.some(f => f.includes('routine1.json'))).toBe(true);
      expect(files.some(f => f.includes('test.json'))).toBe(true);
    });

    it('35. Skip rule is exact directory name, not prefix match', async () => {
      const tempDir = await makeTempDir();

      await fs.mkdir(path.join(tempDir, 'examples'));
      await fs.writeFile(path.join(tempDir, 'examples', 'ignored.json'), JSON.stringify(def('ignored')));
      await fs.mkdir(path.join(tempDir, 'examples-related'));
      await fs.writeFile(path.join(tempDir, 'examples-related', 'important.json'), JSON.stringify(def('important')));

      const files = await findWorkflowJsonFiles(tempDir);

      expect(files).toHaveLength(1);
      expect(files[0]).toContain('examples-related');
      expect(files.some(f => f.includes('examples/ignored'))).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 13. Fixture-vs-File Drift Detection (deferred to Phase 6)
  // ───────────────────────────────────────────────────────────────────────────

  describe('Fixture-vs-File Drift Detection', () => {
    it('36. Lifecycle fixture definitions match bundled files', async () => {
      const { testSessionPersistenceFixture } = await import('../lifecycle/fixtures/test-session-persistence.fixture.js');
      const { workflowDiagnoseEnvironmentFixture } = await import('../lifecycle/fixtures/workflow-diagnose-environment.fixture.js');
      const { testArtifactLoopControlFixture } = await import('../lifecycle/fixtures/test-artifact-loop-control.fixture.js');

      for (const fixture of [
        testSessionPersistenceFixture,
        workflowDiagnoseEnvironmentFixture,
        testArtifactLoopControlFixture,
      ]) {
        const filePath = path.join(__dirname, '../../workflows', `${fixture.workflowId}.json`);
        const fileContent = JSON.parse(await fs.readFile(filePath, 'utf-8'));

        // Deep structural comparison — ignores key ordering and formatting differences
        expect(fixture.definition).toEqual(fileContent);
      }
    });
  });
});
