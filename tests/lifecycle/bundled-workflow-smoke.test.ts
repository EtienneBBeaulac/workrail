import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import type { WorkflowDefinition, StepDefinition } from '../../src/types/workflow.js';
import { executeWorkflowLifecycle, type WorkflowFixture, type StepFixture, type LoopContext, type LifecycleHarnessDeps } from './lifecycle-harness.js';
import { WorkflowCompiler } from '../../src/application/services/workflow-compiler.js';
import { WorkflowInterpreter } from '../../src/application/services/workflow-interpreter.js';

// ─────────────────────────────────────────────────────────────────────────────
// Discovery: find all bundled workflow JSON files at test time
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = path.resolve(__dirname, '../../workflows');

function discoverWorkflowFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // Skip examples directory (illustrative, not production)
      if (entry.name === 'examples') continue;
      results.push(...discoverWorkflowFiles(path.join(dir, entry.name)));
    } else if (entry.name.endsWith('.json')) {
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-fixture: derive fixtures from the workflow definition itself
// ─────────────────────────────────────────────────────────────────────────────

const LOOP_CONTROL_CONTINUE_ARTIFACT = {
  kind: 'wr.loop_control' as const,
  decision: 'continue' as const,
  metadata: { reason: 'auto-fixture: first iteration' },
};

const LOOP_CONTROL_STOP_ARTIFACT = {
  kind: 'wr.loop_control' as const,
  decision: 'stop' as const,
  metadata: { reason: 'auto-fixture: exit after one iteration' },
};

interface StepInfo {
  readonly hasLoopControlOutput: boolean;
}

interface WorkflowAnalysis {
  readonly stepInfo: Map<string, StepInfo>;
  /** Context variable names that forEach loops read via `items` */
  readonly forEachContextVars: Set<string>;
}

/**
 * Walk the step tree to extract auto-fixture-relevant metadata:
 * - Which steps produce loop control artifacts (need continue/stop fixtures)
 * - Which context variables forEach loops consume (need dummy arrays)
 */
function analyzeWorkflow(steps: readonly StepDefinition[]): WorkflowAnalysis {
  const stepInfo = new Map<string, StepInfo>();
  const forEachContextVars = new Set<string>();

  function walk(stepsToWalk: readonly StepDefinition[]): void {
    for (const step of stepsToWalk) {
      const outputContract = (step as any).outputContract ?? (step as any).output;
      const hasLoopControlOutput =
        outputContract?.contractRef === 'wr.contracts.loop_control';
      stepInfo.set(step.id, { hasLoopControlOutput });

      const loopDef = (step as any).loop;
      if (loopDef) {
        // forEach loops need their `items` context variable to be an array
        if (loopDef.type === 'forEach' && typeof loopDef.items === 'string') {
          forEachContextVars.add(loopDef.items);
        }
        if (loopDef.steps) {
          walk(loopDef.steps);
        }
      }
    }
  }

  walk(steps);
  return { stepInfo, forEachContextVars };
}

/**
 * Detect if a workflow uses templateCall steps. Template expansion produces
 * dotted step IDs (e.g. "parent.child") that the prompt renderer cannot
 * resolve from the original definition. For these workflows we skip prompt
 * rendering validation -- the compilation + stepping still exercises all
 * other code paths.
 */
function usesTemplateCalls(steps: readonly StepDefinition[]): boolean {
  for (const step of steps) {
    if ((step as any).templateCall) return true;
    const loopDef = (step as any).loop;
    if (loopDef?.steps && usesTemplateCalls(loopDef.steps)) return true;
  }
  return false;
}

/**
 * Build a dynamic fixture resolver that auto-generates minimal fixtures
 * for any step. Loop control steps get "continue" on first visit,
 * "stop" on second -- proving both iteration and exit.
 */
function buildAutoFixtureResolver(
  definition: WorkflowDefinition,
): (stepId: string, loopContext: LoopContext) => StepFixture | undefined {
  const { stepInfo, forEachContextVars } = analyzeWorkflow(definition.steps);

  // Build a base context that satisfies all forEach loops with a single-element array.
  // The interpreter checks Array.isArray(context[items]) before entering forEach.
  const baseContext: Record<string, unknown> = {};
  for (const varName of forEachContextVars) {
    baseContext[varName] = ['smoke-test-item'];
  }

  return (stepId: string, loopContext: LoopContext): StepFixture => {
    const info = stepInfo.get(stepId);
    const hasLoopControlOutput = info?.hasLoopControlOutput ?? false;

    if (hasLoopControlOutput) {
      // First visit: continue. All subsequent visits: stop.
      const artifact =
        loopContext.stepVisitCount === 0
          ? LOOP_CONTROL_CONTINUE_ARTIFACT
          : LOOP_CONTROL_STOP_ARTIFACT;
      return { notesMarkdown: '', artifacts: [artifact], context: baseContext };
    }

    // Regular step: provide forEach context so subsequent forEach steps can enter
    return { notesMarkdown: '', context: baseContext };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

const workflowFiles = discoverWorkflowFiles(WORKFLOWS_DIR);

describe('Bundled workflow smoke walk', () => {
  const deps: LifecycleHarnessDeps = {
    compiler: new WorkflowCompiler(),
    interpreter: new WorkflowInterpreter(),
  };

  it('discovers at least one bundled workflow', () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
  });

  for (const filePath of workflowFiles) {
    const relativePath = path.relative(WORKFLOWS_DIR, filePath);

    describe(relativePath, () => {
      let definition: WorkflowDefinition;

      // Parse once per workflow
      try {
        definition = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch {
        it('parses as valid JSON', () => {
          // Force failure with context
          expect.unreachable(`Failed to parse ${relativePath} as JSON`);
        });
        return;
      }

      it('compiles, steps, and renders prompts without domain errors', () => {
        const fixture: WorkflowFixture = {
          workflowId: definition.id,
          definition,
          stepFixtures: buildAutoFixtureResolver(definition),
          maxDriverIterations: 200,
        };

        const skipPromptRendering = usesTemplateCalls(definition.steps);
        const result = executeWorkflowLifecycle(fixture, deps, {
          checkPromptRendering: !skipPromptRendering,
        });

        if (result.kind !== 'success') {
          // Provide rich failure context
          const detail =
            result.kind === 'compilation_failed'
              ? `Compilation error: ${JSON.stringify(result.error)}`
              : result.kind === 'prompt_render_failed'
                ? `Prompt render error at step "${result.stepId}": ${JSON.stringify(result.error)}`
                : result.kind === 'integrity_failure'
                  ? `Integrity failure at step "${result.stepId}": ${JSON.stringify(result.error)}`
                  : result.kind === 'missing_fixture'
                    ? `Missing fixture for step "${result.stepId}" (visited: ${result.stepsVisited.join(' -> ')})`
                    : result.kind === 'driver_exceeded_iterations'
                      ? `Exceeded ${result.iterations} iterations (visited: ${result.stepsVisited.join(' -> ')})`
                      : JSON.stringify(result);
          expect.unreachable(`${relativePath}: ${detail}`);
        }

        expect(result.stepsVisited.length).toBeGreaterThan(0);
      });
    });
  }
});
