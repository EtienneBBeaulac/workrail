/**
 * V2 advance path integration test: artifact collection → interpreter loop control.
 *
 * Tests the composed path that mirrors production:
 *   collectArtifactsForEvaluation(events, inputArtifacts) → interpreter.next(... artifacts)
 *
 * This closes the last coverage gap: verifying that artifacts flowing through durable
 * events and the collection function actually reach the interpreter and produce correct
 * loop control decisions — including the mismatched-loopId regression scenario.
 */
import { describe, it, expect } from 'vitest';
import { WorkflowCompiler } from '../../src/application/services/workflow-compiler.js';
import { WorkflowInterpreter } from '../../src/application/services/workflow-interpreter.js';
import { collectArtifactsForEvaluation } from '../../src/mcp/handlers/v2-context-budget.js';
import { LOOP_CONTROL_CONTRACT_REF } from '../../src/v2/durable-core/schemas/artifacts/index.js';
import type { WorkflowDefinition } from '../../src/types/workflow-definition.js';
import type { DomainEventV1 } from '../../src/v2/durable-core/schemas/session/index.js';

// ── Helpers ──────────────────────────────────────────────────────────────

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

/** Build a node_output_appended event carrying an artifact through the durable event log. */
function buildDurableArtifactEvent(eventIndex: number, artifact: unknown): DomainEventV1 {
  return {
    v: 1,
    eventId: `e${eventIndex}`,
    eventIndex,
    sessionId: 's1',
    kind: 'node_output_appended',
    dedupeKey: `node_output_appended:s1:out_${eventIndex}`,
    scope: { runId: 'run_1', nodeId: 'node_1' },
    data: {
      outputId: `out_${eventIndex}`,
      outputChannel: 'artifact',
      payload: {
        payloadKind: 'artifact_ref',
        content: artifact,
      },
    },
  } as unknown as DomainEventV1;
}

const compiler = new WorkflowCompiler();
const interpreter = new WorkflowInterpreter();

function compileWorkflow(def: WorkflowDefinition) {
  const workflow = { definition: def, source: { kind: 'bundled' as const, ref: '(test)' } };
  const result = compiler.compile(workflow);
  if (result.isErr()) throw new Error(`Compilation failed: ${result.error.message}`);
  return result.value;
}

const baseState = { kind: 'running' as const, completed: [], loopStack: [{ loopId: 'audit-loop', iteration: 0, bodyIndex: 0 }], pendingStep: undefined };

// ── Tests ────────────────────────────────────────────────────────────────

describe('V2 advance path: collectArtifacts → interpreter.next (composed)', () => {
  const compiled = compileWorkflow(buildArtifactLoopWorkflow());

  it('stop artifact from durable events exits loop', () => {
    const stopArtifact = { kind: 'wr.loop_control', loopId: 'plan_audit_loop', decision: 'stop' };
    const events = [buildDurableArtifactEvent(0, stopArtifact)];

    // Production path: collect from events, pass to interpreter
    const artifacts = collectArtifactsForEvaluation({ truthEvents: events, inputArtifacts: [] });
    const result = interpreter.next(compiled, baseState, {}, artifacts);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isComplete).toBe(true);
    }
  });

  it('stop artifact with MISMATCHED loopId from durable events still exits loop (regression)', () => {
    // THE BUG: agent wrote step ID instead of loop ID. The artifact flows through
    // durable events → collectArtifactsForEvaluation → interpreter → evaluator.
    // With loopId-agnostic matching, the stop is honored.
    const stopArtifact = { kind: 'wr.loop_control', loopId: 'phase-4-plan-iterations', decision: 'stop' };
    const events = [buildDurableArtifactEvent(0, stopArtifact)];

    const artifacts = collectArtifactsForEvaluation({ truthEvents: events, inputArtifacts: [] });
    const result = interpreter.next(compiled, baseState, {}, artifacts);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isComplete).toBe(true);
    }
  });

  it('stop artifact from input (current attempt) exits loop', () => {
    // Artifact from current advance attempt, not yet in durable events
    const stopArtifact = { kind: 'wr.loop_control', decision: 'stop' };

    const artifacts = collectArtifactsForEvaluation({ truthEvents: [], inputArtifacts: [stopArtifact] });
    const result = interpreter.next(compiled, baseState, {}, artifacts);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isComplete).toBe(true);
    }
  });

  it('input artifact overrides earlier durable event artifact (last wins)', () => {
    // Durable event says continue, but current attempt says stop → stop wins
    const continueArtifact = { kind: 'wr.loop_control', decision: 'continue' };
    const stopArtifact = { kind: 'wr.loop_control', decision: 'stop' };
    const events = [buildDurableArtifactEvent(0, continueArtifact)];

    const artifacts = collectArtifactsForEvaluation({ truthEvents: events, inputArtifacts: [stopArtifact] });
    const result = interpreter.next(compiled, baseState, {}, artifacts);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isComplete).toBe(true);
    }
  });

  it('no artifacts at all defaults to continue (first iteration)', () => {
    const artifacts = collectArtifactsForEvaluation({ truthEvents: [], inputArtifacts: [] });
    const result = interpreter.next(compiled, baseState, {}, artifacts);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.next?.stepInstanceId.stepId).toBe('do-work');
    }
  });

  it('invalid artifact (kind matches, schema fails) defaults to continue with trace', () => {
    // Agent produced wr.loop_control with uppercase loopId — invalid schema
    const invalidArtifact = { kind: 'wr.loop_control', loopId: 'INVALID-CAPS', decision: 'stop' };
    const events = [buildDurableArtifactEvent(0, invalidArtifact)];

    const artifacts = collectArtifactsForEvaluation({ truthEvents: events, inputArtifacts: [] });
    const result = interpreter.next(compiled, baseState, {}, artifacts);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Invalid artifact → defaults to continue
      expect(result.value.next?.stepInstanceId.stepId).toBe('do-work');
      // Trace should record the invalid match
      const invalidTrace = result.value.trace.find(t => t.summary.includes('artifact match=invalid'));
      expect(invalidTrace).toBeDefined();
    }
  });

  it('mismatched loopId stop artifact from durable events produces correct trace', () => {
    const stopArtifact = { kind: 'wr.loop_control', loopId: 'totally-wrong-id', decision: 'stop' };
    const events = [buildDurableArtifactEvent(0, stopArtifact)];

    const artifacts = collectArtifactsForEvaluation({ truthEvents: events, inputArtifacts: [] });
    const result = interpreter.next(compiled, baseState, {}, artifacts);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Should exit
      expect(result.value.isComplete).toBe(true);
      // Trace should show found + stop
      const matchTrace = result.value.trace.find(t => t.summary.includes('artifact match=found'));
      expect(matchTrace).toBeDefined();
      expect(matchTrace!.summary).toContain('decision="stop"');
    }
  });
});
