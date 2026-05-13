/**
 * Lifecycle tests: pipeline workflow artifact emission contracts.
 *
 * These tests walk wr.discovery, wr.shaping, wr.coding-task, and wr.mr-review
 * through the lifecycle harness and assert:
 *   1. The workflow compiles without errors.
 *   2. All steps are reachable and the workflow reaches `success`.
 *   3. The final step has the expected ID (catches step renaming/reordering).
 *   4. The final step accepts the correct typed artifact (validates the fixture
 *      against the live schema, catching prompt changes that drop or rename
 *      the artifact instruction).
 *
 * WHY the harness (not MCP integration tests):
 * The harness exercises the real compiler + v1 interpreter with hermetic
 * fixtures -- no I/O, no sessions, no LLM. It runs in milliseconds and can be
 * run on every CI pass. MCP-level outputContract enforcement is separately
 * covered by the artifact-contract-*.test.ts unit tests.
 *
 * WHY these four workflows specifically:
 * They are the four pipeline-critical workflows whose final-step artifacts
 * feed directly into coordinator routing decisions. A prompt change that
 * silently removes or breaks the artifact emission instruction would pass
 * all other tests (smoke test only checks compilation) until a real pipeline
 * run catches it in production.
 *
 * Backlog item: "Lifecycle integration tests: assert each workflow emits
 * expected handoff artifact" (May 5, 2026).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeAll } from 'vitest';
import { executeWorkflowLifecycle, type WorkflowFixture, type LifecycleHarnessDeps } from './lifecycle-harness.js';
import { WorkflowCompiler } from '../../src/application/services/workflow-compiler.js';
import { WorkflowInterpreter } from '../../src/application/services/workflow-interpreter.js';
import type { WorkflowDefinition } from '../../src/types/workflow.js';
import { DiscoveryHandoffArtifactV1Schema } from '../../src/v2/durable-core/schemas/artifacts/discovery-handoff.js';
import { ShapingHandoffArtifactV1Schema, CodingHandoffArtifactV1Schema } from '../../src/v2/durable-core/schemas/artifacts/phase-handoff.js';
import { ReviewVerdictArtifactV1Schema } from '../../src/v2/durable-core/schemas/artifacts/review-verdict.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = path.resolve(__dirname, '../../workflows');

const deps: LifecycleHarnessDeps = {
  compiler: new WorkflowCompiler(),
  interpreter: new WorkflowInterpreter(),
};

function loadWorkflow(filename: string): WorkflowDefinition {
  return JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, filename), 'utf-8'));
}

// ---------------------------------------------------------------------------
// Typed artifact fixtures (minimal valid shapes for each pipeline contract)
//
// WHY validated below: hand-written fixtures silently become invalid when
// schemas evolve. The beforeAll block validates each fixture against its Zod
// schema so a schema change fails the test immediately, not in a real pipeline run.
// ---------------------------------------------------------------------------

const DISCOVERY_HANDOFF_ARTIFACT = {
  kind: 'wr.discovery_handoff',
  version: 1,
  selectedDirection: 'lifecycle-test direction',
  designDocPath: '',
  confidenceBand: 'high',
  keyInvariants: ['lifecycle-test invariant'],
};

const SHAPING_HANDOFF_ARTIFACT = {
  kind: 'wr.shaping_handoff',
  version: 1,
  pitchPath: '.workrail/current-pitch.md',
  selectedShape: 'lifecycle-test shape',
  appetite: 'M',
  keyConstraints: ['lifecycle-test constraint'],
  outOfScope: [],
  rabbitHoles: [],
  validationChecklist: ['lifecycle-test check'],
};

const CODING_HANDOFF_ARTIFACT = {
  kind: 'wr.coding_handoff',
  version: 1,
  keyDecisions: ['lifecycle-test decision'],
  knownLimitations: [],
  testsAdded: [],
  filesChanged: ['src/lifecycle-test.ts'],
};

const REVIEW_VERDICT_ARTIFACT = {
  kind: 'wr.review_verdict',
  verdict: 'clean',
  confidence: 'high',
  findings: [],
  summary: 'lifecycle-test: no findings',
};

// Validate all artifact fixtures against their live Zod schemas at test startup.
// This catches schema drift before any lifecycle test runs.
beforeAll(() => {
  const checks: Array<{ name: string; schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: unknown[] } } }; value: unknown }> = [
    { name: 'DISCOVERY_HANDOFF_ARTIFACT', schema: DiscoveryHandoffArtifactV1Schema, value: DISCOVERY_HANDOFF_ARTIFACT },
    { name: 'SHAPING_HANDOFF_ARTIFACT', schema: ShapingHandoffArtifactV1Schema, value: SHAPING_HANDOFF_ARTIFACT },
    { name: 'CODING_HANDOFF_ARTIFACT', schema: CodingHandoffArtifactV1Schema, value: CODING_HANDOFF_ARTIFACT },
    { name: 'REVIEW_VERDICT_ARTIFACT', schema: ReviewVerdictArtifactV1Schema, value: REVIEW_VERDICT_ARTIFACT },
  ];
  for (const { name, schema, value } of checks) {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new Error(`Lifecycle test fixture ${name} failed schema validation: ${JSON.stringify(result.error?.issues)}`);
    }
  }
});

// Loop control artifacts for workflows with while loops
const LOOP_CONTROL_STOP = {
  kind: 'wr.loop_control',
  decision: 'stop',
  metadata: { reason: 'lifecycle-test: exit after one iteration' },
};

const LOOP_CONTROL_CONTINUE = {
  kind: 'wr.loop_control',
  decision: 'continue',
  metadata: { reason: 'lifecycle-test: first iteration' },
};

// ---------------------------------------------------------------------------
// wr.discovery
// ---------------------------------------------------------------------------

describe('Lifecycle: wr.discovery artifact emission', () => {
  const definition = loadWorkflow('wr.discovery.json');

  it('reaches success with correct artifact on phase-7-handoff', () => {
    const fixture: WorkflowFixture = {
      workflowId: definition.id,
      definition,
      maxDriverIterations: 300,
      stepFixtures: (stepId, loopCtx) => {
        // Loop steps with loop_control conditionSource get continue/stop based on visit count
        const step = findStepInDefinition(definition, stepId);
        const loopContractRef = (step as any)?.loop?.conditionSource?.contractRef;

        if (loopContractRef === 'wr.contracts.loop_control') {
          const artifact = loopCtx.stepVisitCount === 0 ? LOOP_CONTROL_CONTINUE : LOOP_CONTROL_STOP;
          return { notesMarkdown: '', artifacts: [artifact] };
        }

        if (stepId === 'phase-7-handoff') {
          return { notesMarkdown: 'Lifecycle test final handoff notes.', artifacts: [DISCOVERY_HANDOFF_ARTIFACT] };
        }

        return { notesMarkdown: '', context: {} };
      },
    };

    const result = executeWorkflowLifecycle(fixture, deps, { checkPromptRendering: false });

    if (result.kind !== 'success') {
      const detail = result.kind === 'integrity_failure'
        ? `integrity_failure at step "${result.stepId}": ${JSON.stringify(result.error)}`
        : result.kind === 'missing_fixture'
          ? `missing_fixture for step "${result.stepId}" (visited: ${result.stepsVisited.join(' -> ')})`
          : result.kind === 'driver_exceeded_iterations'
            ? `exceeded ${result.iterations} iterations (last visited: ${result.stepsVisited.slice(-5).join(' -> ')})`
            : JSON.stringify(result);
      expect.unreachable(`wr.discovery lifecycle failed: ${detail}`);
    }
    expect(result.stepsVisited[result.stepsVisited.length - 1]).toBe('phase-7-handoff');
  });
});

// ---------------------------------------------------------------------------
// wr.shaping
// ---------------------------------------------------------------------------

describe('Lifecycle: wr.shaping artifact emission', () => {
  const definition = loadWorkflow('wr.shaping.json');

  it('reaches success with correct artifact on finalize step', () => {
    const fixture: WorkflowFixture = {
      workflowId: definition.id,
      definition,
      maxDriverIterations: 100,
      stepFixtures: (stepId) => {
        if (stepId === 'finalize') {
          return { notesMarkdown: 'Lifecycle test shaping notes.', artifacts: [SHAPING_HANDOFF_ARTIFACT] };
        }
        return { notesMarkdown: '', context: {} };
      },
    };

    const result = executeWorkflowLifecycle(fixture, deps, { checkPromptRendering: false });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.stepsVisited[result.stepsVisited.length - 1]).toBe('finalize');
  });
});

// ---------------------------------------------------------------------------
// wr.coding-task
// ---------------------------------------------------------------------------

describe('Lifecycle: wr.coding-task artifact emission', () => {
  const definition = loadWorkflow('coding-task-workflow-agentic.json');

  it('reaches success with correct artifact on phase-8-retrospective', () => {
    // wr.coding-task has a forEach loop over context['slices'].
    // Provide a minimal single-element array so the loop can enter.
    const slicesContext = { slices: [{ name: 'lifecycle-test-slice' }] };

    const fixture: WorkflowFixture = {
      workflowId: definition.id,
      definition,
      maxDriverIterations: 200,
      stepFixtures: (stepId, loopCtx) => {
        const step = findStepInDefinition(definition, stepId);
        const contractRef = (step as any)?.outputContract?.contractRef;

        if (contractRef === 'wr.contracts.loop_control') {
          const artifact = loopCtx.stepVisitCount === 0 ? LOOP_CONTROL_CONTINUE : LOOP_CONTROL_STOP;
          return { notesMarkdown: '', artifacts: [artifact], context: slicesContext };
        }

        if (stepId === 'phase-8-retrospective') {
          return { notesMarkdown: 'Lifecycle test coding notes.', artifacts: [CODING_HANDOFF_ARTIFACT] };
        }

        return { notesMarkdown: '', context: slicesContext };
      },
    };

    const result = executeWorkflowLifecycle(fixture, deps, { checkPromptRendering: false });

    if (result.kind !== 'success') {
      const detail = result.kind === 'integrity_failure'
        ? `integrity_failure at step "${result.stepId}": ${JSON.stringify(result.error)}`
        : result.kind === 'missing_fixture'
          ? `missing_fixture for step "${result.stepId}" (visited: ${result.stepsVisited.join(' -> ')})`
          : result.kind === 'driver_exceeded_iterations'
            ? `exceeded ${result.iterations} iterations (last: ${result.stepsVisited.slice(-5).join(' -> ')})`
            : JSON.stringify(result);
      expect.unreachable(`wr.coding-task lifecycle failed: ${detail}`);
    }
    expect(result.stepsVisited[result.stepsVisited.length - 1]).toBe('phase-8-retrospective');
  });
});

// ---------------------------------------------------------------------------
// wr.mr-review
// ---------------------------------------------------------------------------

describe('Lifecycle: wr.mr-review artifact emission', () => {
  const definition = loadWorkflow('mr-review-workflow.agentic.v2.json');

  it('reaches success with correct artifact on phase-6-final-handoff', () => {
    const fixture: WorkflowFixture = {
      workflowId: definition.id,
      definition,
      maxDriverIterations: 100,
      stepFixtures: (stepId, loopCtx) => {
        const step = findStepInDefinition(definition, stepId);
        const contractRef = (step as any)?.loop?.conditionSource?.contractRef
          ?? (step as any)?.outputContract?.contractRef;

        if (contractRef === 'wr.contracts.loop_control') {
          const artifact = loopCtx.stepVisitCount === 0 ? LOOP_CONTROL_CONTINUE : LOOP_CONTROL_STOP;
          return { notesMarkdown: '', artifacts: [artifact] };
        }

        if (stepId === 'phase-6-final-handoff') {
          return { notesMarkdown: 'Lifecycle test review notes.', artifacts: [REVIEW_VERDICT_ARTIFACT] };
        }

        return { notesMarkdown: '', context: {} };
      },
    };

    const result = executeWorkflowLifecycle(fixture, deps, { checkPromptRendering: false });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.stepsVisited[result.stepsVisited.length - 1]).toBe('phase-6-final-handoff');
  });
});

// ---------------------------------------------------------------------------
// Helper: find a step by ID anywhere in the definition (including loop bodies)
// ---------------------------------------------------------------------------

function findStepInDefinition(definition: WorkflowDefinition, stepId: string): unknown {
  for (const step of definition.steps) {
    if ((step as any).id === stepId) return step;
    const loopSteps = (step as any)?.loop?.steps ?? [];
    for (const ls of loopSteps) {
      if ((ls as any).id === stepId) return ls;
    }
  }
  return undefined;
}
