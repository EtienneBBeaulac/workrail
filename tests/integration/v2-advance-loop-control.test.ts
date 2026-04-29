/**
 * V2 advance path integration test: artifact_contract loop control.
 *
 * Tests that interpreter.next() correctly evaluates artifact_contract while loops
 * when given only the current step's submitted artifacts (inputArtifacts).
 *
 * The production path in outcome-success.ts passes inputOutput.artifacts directly
 * to interpreter.next(). Historical session artifacts (truthEvents) are NOT passed --
 * doing so caused sequential loops to contaminate each other via stale stop decisions.
 *
 * These tests verify the correct contract: only current-step artifacts reach the
 * interpreter for loop control evaluation.
 */
import { describe, it, expect } from 'vitest';
import { WorkflowCompiler } from '../../src/application/services/workflow-compiler.js';
import { WorkflowInterpreter } from '../../src/application/services/workflow-interpreter.js';
import { LOOP_CONTROL_CONTRACT_REF } from '../../src/v2/durable-core/schemas/artifacts/index.js';
import { createWorkflow } from '../../src/types/workflow.js';
import { createBundledSource } from '../../src/types/workflow-source.js';
import type { WorkflowDefinition } from '../../src/types/workflow-definition.js';

function buildArtifactLoopWorkflow(): WorkflowDefinition {
  return {
    id: 'v2-advance-loop-test',
    name: 'V2 Advance Loop Test',
    description: 'Integration test for artifact-based loop through v2 advance path',
    version: '1.0.0',
    steps: [
      {
        id: 'audit-loop',
        type: 'loop',
        title: 'Audit Loop',
        prompt: 'Audit loop',
        loop: {
          type: 'while',
          maxIterations: 5,
          conditionSource: {
            kind: 'artifact_contract',
            contractRef: LOOP_CONTROL_CONTRACT_REF,
            loopId: 'plan_audit_loop',
          },
        },
        body: [
          { id: 'do-work', title: 'Do Work', prompt: 'Work', requireConfirmation: false },
          {
            id: 'exit-decision',
            title: 'Exit Decision',
            prompt: 'Stop?',
            requireConfirmation: false,
            outputContract: { contractRef: LOOP_CONTROL_CONTRACT_REF },
          },
        ],
      },
    ],
  } as any;
}

const compiler = new WorkflowCompiler();
const interpreter = new WorkflowInterpreter();

function compileWorkflow(def: WorkflowDefinition) {
  const workflow = createWorkflow(def, createBundledSource());
  const result = compiler.compile(workflow);
  if (result.isErr()) throw new Error(`Compilation failed: ${result.error.message}`);
  return result.value;
}

// State: inside the loop, about to evaluate the exit-decision step result
const baseState = { kind: 'running' as const, completed: [], loopStack: [{ loopId: 'audit-loop', iteration: 0, bodyIndex: 0 }], pendingStep: undefined };

describe('V2 advance path: artifact_contract loop control (current-step artifacts only)', () => {
  const compiled = compileWorkflow(buildArtifactLoopWorkflow());

  it('stop artifact from current step exits loop', () => {
    // Production: inputOutput.artifacts = [stopArtifact] from the current continue_workflow call
    const stopArtifact = { kind: 'wr.loop_control', loopId: 'plan_audit_loop', decision: 'stop' };
    const result = interpreter.next(compiled, baseState, {}, [stopArtifact]);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isComplete).toBe(true);
    }
  });

  it('stop artifact with MISMATCHED loopId still exits loop (regression: loopId-agnostic)', () => {
    // Agent wrote step ID instead of loop ID. loopId-agnostic matching still honors the stop.
    const stopArtifact = { kind: 'wr.loop_control', loopId: 'phase-4-plan-iterations', decision: 'stop' };
    const result = interpreter.next(compiled, baseState, {}, [stopArtifact]);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isComplete).toBe(true);
    }
  });

  it('no artifacts at all defaults to continue (first iteration)', () => {
    // No artifact yet -- loop-body exit-decision step hasn't run. Default: enter loop.
    const result = interpreter.next(compiled, baseState, {}, []);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.next?.stepInstanceId.stepId).toBe('do-work');
    }
  });

  it('invalid artifact (kind matches, schema fails) defaults to continue with trace', () => {
    // Agent produced wr.loop_control with uppercase loopId -- invalid schema
    const invalidArtifact = { kind: 'wr.loop_control', loopId: 'INVALID-CAPS', decision: 'stop' };
    const result = interpreter.next(compiled, baseState, {}, [invalidArtifact]);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.next?.stepInstanceId.stepId).toBe('do-work');
      const invalidTrace = result.value.trace.find(t => t.summary.includes('artifact match=invalid'));
      expect(invalidTrace).toBeDefined();
    }
  });

  it('mismatched loopId stop artifact produces correct trace', () => {
    const stopArtifact = { kind: 'wr.loop_control', loopId: 'totally-wrong-id', decision: 'stop' };
    const result = interpreter.next(compiled, baseState, {}, [stopArtifact]);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isComplete).toBe(true);
      const matchTrace = result.value.trace.find(t => t.summary.includes('artifact match=found'));
      expect(matchTrace).toBeDefined();
      expect(matchTrace!.summary).toContain('decision="stop"');
    }
  });
});
