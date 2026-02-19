/**
 * Loop condition source tests.
 * 
 * Verifies the exhaustive branching on LoopConditionSource:
 * - artifact_contract: ONLY uses artifacts (missing = enter loop by default; only 'stop' exits)
 * - context_variable: ONLY uses context (no artifact awareness)
 * - undefined (legacy): falls back to raw condition field
 * 
 * Lock: §9 "while loop continuation MUST NOT be controlled by mutable ad-hoc
 * context keys" — new workflows use artifact_contract; legacy get context_variable.
 */
import { describe, it, expect } from 'vitest';
import { WorkflowInterpreter } from '../../src/application/services/workflow-interpreter';
import { WorkflowCompiler } from '../../src/application/services/workflow-compiler';
import { createWorkflow } from '../../src/types/workflow';
import { createBundledSource } from '../../src/types/workflow-source';
import type { WorkflowDefinition } from '../../src/types/workflow-definition';
import type { ExecutionState } from '../../src/domain/execution/state';
import { LOOP_CONTROL_CONTRACT_REF, findLoopControlArtifact } from '../../src/v2/durable-core/schemas/artifacts/index';

const baseState: ExecutionState = { kind: 'init' };

function compileWorkflow(def: WorkflowDefinition) {
  const compiler = new WorkflowCompiler();
  const workflow = createWorkflow(def, createBundledSource());
  const compiled = compiler.compile(workflow);
  if (compiled.isErr()) throw new Error(`Compile failed: ${compiled.error.message}`);
  return compiled.value;
}

// --- Workflow definitions ---

/** Legacy workflow: while loop with context-based condition, no outputContract */
function buildContextVariableWorkflow(): WorkflowDefinition {
  return {
    id: 'context-loop-test',
    name: 'Context Loop Test',
    description: 'Legacy context-based loop',
    version: '1.0.0',
    steps: [
      {
        id: 'loop-step',
        type: 'loop',
        title: 'Loop Step',
        loop: {
          type: 'while',
          condition: { var: 'continuePlanning', equals: true },
          maxIterations: 3,
        },
        body: [
          { id: 'body-step', title: 'Body Step', prompt: 'Do work', requireConfirmation: false },
        ],
      },
    ],
  };
}

/** New workflow: while loop with artifact-based condition via outputContract */
function buildArtifactContractWorkflow(): WorkflowDefinition {
  return {
    id: 'artifact-loop-test',
    name: 'Artifact Loop Test',
    description: 'Artifact-based loop control',
    version: '1.0.0',
    steps: [
      {
        id: 'loop-step',
        type: 'loop',
        title: 'Loop Step',
        loop: {
          type: 'while',
          condition: { var: 'unused', equals: true }, // present for schema compat but ignored
          maxIterations: 3,
        },
        body: [
          {
            id: 'body-step',
            title: 'Body Step',
            prompt: 'Provide loop control artifact',
            requireConfirmation: false,
            outputContract: { contractRef: LOOP_CONTROL_CONTRACT_REF },
          },
        ],
      },
    ],
  };
}

/** Workflow with explicit conditionSource: artifact_contract */
function buildExplicitArtifactSourceWorkflow(): WorkflowDefinition {
  return {
    id: 'explicit-artifact-test',
    name: 'Explicit Artifact Test',
    description: 'Explicit conditionSource',
    version: '1.0.0',
    steps: [
      {
        id: 'loop-step',
        type: 'loop',
        title: 'Loop Step',
        loop: {
          type: 'while',
          maxIterations: 3,
          conditionSource: {
            kind: 'artifact_contract',
            contractRef: LOOP_CONTROL_CONTRACT_REF,
            loopId: 'loop-step',
          },
        },
        body: [
          { id: 'body-step', title: 'Body Step', prompt: 'Do work', requireConfirmation: false },
        ],
      },
    ],
  };
}

describe('Compiler: conditionSource derivation', () => {
  it('derives context_variable for legacy while loop', () => {
    const compiled = compileWorkflow(buildContextVariableWorkflow());
    const loop = compiled.compiledLoops.get('loop-step');
    expect(loop).toBeDefined();
    expect(loop!.conditionSource).toBeDefined();
    expect(loop!.conditionSource!.kind).toBe('context_variable');
  });

  it('derives artifact_contract when body step has outputContract', () => {
    const compiled = compileWorkflow(buildArtifactContractWorkflow());
    const loop = compiled.compiledLoops.get('loop-step');
    expect(loop).toBeDefined();
    expect(loop!.conditionSource).toBeDefined();
    expect(loop!.conditionSource!.kind).toBe('artifact_contract');
    if (loop!.conditionSource!.kind === 'artifact_contract') {
      expect(loop!.conditionSource!.contractRef).toBe(LOOP_CONTROL_CONTRACT_REF);
      expect(loop!.conditionSource!.loopId).toBe('loop-step');
    }
  });

  it('uses explicit conditionSource when provided', () => {
    const compiled = compileWorkflow(buildExplicitArtifactSourceWorkflow());
    const loop = compiled.compiledLoops.get('loop-step');
    expect(loop).toBeDefined();
    expect(loop!.conditionSource).toBeDefined();
    expect(loop!.conditionSource!.kind).toBe('artifact_contract');
  });

  it('returns undefined conditionSource for for/forEach loops', () => {
    const def: WorkflowDefinition = {
      id: 'for-loop-test',
      name: 'For Loop Test',
      description: 'For loop',
      version: '1.0.0',
      steps: [
        {
          id: 'loop-step',
          type: 'loop',
          title: 'Loop Step',
          loop: { type: 'for', count: 3, maxIterations: 5 },
          body: [
            { id: 'body-step', title: 'Body Step', prompt: 'Do', requireConfirmation: false },
          ],
        },
      ],
    };
    const compiled = compileWorkflow(def);
    const loop = compiled.compiledLoops.get('loop-step');
    expect(loop!.conditionSource).toBeUndefined();
  });
});

describe('Interpreter: context_variable loops (legacy)', () => {
  const interpreter = new WorkflowInterpreter();
  const compiled = compileWorkflow(buildContextVariableWorkflow());

  it('enters loop when context condition is true', () => {
    const result = interpreter.next(compiled, baseState, { continuePlanning: true }, []);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.next?.stepInstanceId.stepId).toBe('body-step');
    }
  });

  it('does NOT enter loop when context condition is false', () => {
    const result = interpreter.next(compiled, baseState, { continuePlanning: false }, []);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isComplete).toBe(true);
    }
  });

  it('ignores artifacts entirely (no override)', () => {
    // Artifact says continue, but context says stop → loop should NOT enter
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'loop-step', decision: 'continue' },
    ];
    const result = interpreter.next(compiled, baseState, { continuePlanning: false }, artifacts);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isComplete).toBe(true);
    }
  });
});

describe('Interpreter: artifact_contract loops', () => {
  const interpreter = new WorkflowInterpreter();
  const compiled = compileWorkflow(buildArtifactContractWorkflow());

  it('enters loop when artifact says continue', () => {
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'loop-step', decision: 'continue' },
    ];
    const result = interpreter.next(compiled, baseState, {}, artifacts);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.next?.stepInstanceId.stepId).toBe('body-step');
    }
  });

  it('exits loop when artifact says stop', () => {
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'loop-step', decision: 'stop' },
    ];
    const result = interpreter.next(compiled, baseState, {}, artifacts);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isComplete).toBe(true);
    }
  });

  it('enters loop when no artifact exists (first-iteration default)', () => {
    // No artifact yet at iteration 0 — loop must still be entered.
    // The exit-decision body step hasn't run yet, so no artifact can exist.
    const result = interpreter.next(compiled, baseState, {}, []);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.next?.stepInstanceId.stepId).toBe('body-step');
    }
  });

  it('enters loop when artifact loopId does not match (no decision for this loop yet)', () => {
    // Artifact for a different loop doesn't count — treat as no artifact for this loop.
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'other-loop', decision: 'continue' },
    ];
    const result = interpreter.next(compiled, baseState, {}, artifacts);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.next?.stepInstanceId.stepId).toBe('body-step');
    }
  });

  it('enters loop when context present but no artifact (context is ignored for artifact_contract loops)', () => {
    // artifact_contract loops ignore context variables entirely.
    const result = interpreter.next(compiled, baseState, { continuePlanning: true }, []);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.next?.stepInstanceId.stepId).toBe('body-step');
    }
  });
});

describe('Interpreter: decision trace output', () => {
  const interpreter = new WorkflowInterpreter();

  it('produces trace entries for artifact-based loop entry and step selection', () => {
    const compiled = compileWorkflow(buildArtifactContractWorkflow());
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'loop-step', decision: 'continue' },
    ];
    const result = interpreter.next(compiled, baseState, {}, artifacts);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const { trace } = result.value;
      expect(trace.length).toBeGreaterThan(0);
      // Should have: evaluated_condition, entered_loop, selected_next_step
      const kinds = trace.map((t) => t.kind);
      expect(kinds).toContain('evaluated_condition');
      expect(kinds).toContain('entered_loop');
      expect(kinds).toContain('selected_next_step');
    }
  });

  it('produces trace for loop exit (stop artifact)', () => {
    const compiled = compileWorkflow(buildArtifactContractWorkflow());
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'loop-step', decision: 'stop' },
    ];
    const result = interpreter.next(compiled, baseState, {}, artifacts);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const { trace } = result.value;
      const kinds = trace.map((t) => t.kind);
      expect(kinds).toContain('evaluated_condition');
      expect(kinds).toContain('exited_loop');
    }
  });

  it('produces trace with artifact source for artifact_contract loops', () => {
    const compiled = compileWorkflow(buildArtifactContractWorkflow());
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'loop-step', decision: 'continue' },
    ];
    const result = interpreter.next(compiled, baseState, {}, artifacts);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const condEntry = result.value.trace.find((t) => t.kind === 'evaluated_condition');
      expect(condEntry).toBeDefined();
      expect(condEntry!.summary).toContain('artifact');
    }
  });

  it('produces trace with context source for context_variable loops', () => {
    const compiled = compileWorkflow(buildContextVariableWorkflow());
    const result = interpreter.next(compiled, baseState, { continuePlanning: true }, []);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const condEntry = result.value.trace.find((t) => t.kind === 'evaluated_condition');
      expect(condEntry).toBeDefined();
      expect(condEntry!.summary).toContain('context');
    }
  });

  it('returns empty trace for non-loop workflows', () => {
    const simpleDef: WorkflowDefinition = {
      id: 'no-loop-test',
      name: 'No Loop',
      description: 'Simple linear flow',
      version: '1.0.0',
      steps: [
        { id: 'step-1', title: 'Step 1', prompt: 'Do thing', requireConfirmation: false },
      ],
    };
    const compiled = compileWorkflow(simpleDef);
    const result = interpreter.next(compiled, baseState, {}, []);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // selected_next_step is the only trace entry for a simple selection
      const nonSelectTrace = result.value.trace.filter((t) => t.kind !== 'selected_next_step');
      expect(nonSelectTrace).toHaveLength(0);
    }
  });

  it('complete workflow returns empty trace', () => {
    const result = interpreter.next(
      compileWorkflow(buildContextVariableWorkflow()),
      { kind: 'complete' },
      {},
      []
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.trace).toEqual([]);
    }
  });
});

describe('findLoopControlArtifact: latest artifact wins', () => {
  it('uses the most recent artifact when multiple artifacts exist for the same loopId', () => {
    // Simulates: iteration 0 produced 'continue', iteration 1 produced 'stop'.
    // The newest artifact (stop) must win over the oldest (continue).
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'loop-step', decision: 'continue' },
      { kind: 'wr.loop_control', loopId: 'loop-step', decision: 'stop' },
    ];
    const found = findLoopControlArtifact(artifacts, 'loop-step');
    expect(found).not.toBeNull();
    expect(found?.decision).toBe('stop');
  });

  it('uses the most recent continue artifact when stop is older', () => {
    // Iteration 0 said stop, iteration 1 said continue — newest (continue) wins.
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'loop-step', decision: 'stop' },
      { kind: 'wr.loop_control', loopId: 'loop-step', decision: 'continue' },
    ];
    const found = findLoopControlArtifact(artifacts, 'loop-step');
    expect(found).not.toBeNull();
    expect(found?.decision).toBe('continue');
  });
});

describe('Interpreter: explicit conditionSource', () => {
  const interpreter = new WorkflowInterpreter();
  const compiled = compileWorkflow(buildExplicitArtifactSourceWorkflow());

  it('uses artifact when explicit conditionSource is artifact_contract', () => {
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'loop-step', decision: 'continue' },
    ];
    const result = interpreter.next(compiled, baseState, {}, artifacts);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.next?.stepInstanceId.stepId).toBe('body-step');
    }
  });

  it('enters loop when artifact missing with explicit artifact_contract source (first-iteration default)', () => {
    const result = interpreter.next(compiled, baseState, {}, []);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.next?.stepInstanceId.stepId).toBe('body-step');
    }
  });
});
