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

  it('enters loop when artifact with different loopId says continue (loopId-agnostic matching)', () => {
    // loopId-agnostic: any valid wr.loop_control artifact is matched regardless of loopId.
    // This artifact says 'continue' so the loop enters.
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

  it('exits loop when artifact with WRONG loopId says stop (regression: infinite loop fix)', () => {
    // THE BUG: agent copied step ID instead of loop ID into the artifact.
    // conditionSource.loopId is 'loop-step', but agent wrote 'wrong-loop-id'.
    // With loopId-agnostic matching, the engine still finds and honors the stop.
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'wrong-loop-id', decision: 'stop' },
    ];
    const result = interpreter.next(compiled, baseState, {}, artifacts);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isComplete).toBe(true);
    }
  });

  it('exits loop when artifact has no loopId at all and says stop', () => {
    // Agent omitted loopId entirely (following the "do NOT include loopId" guidance).
    const artifacts = [
      { kind: 'wr.loop_control', decision: 'stop' },
    ];
    const result = interpreter.next(compiled, baseState, {}, artifacts);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isComplete).toBe(true);
    }
  });

  it('last artifact wins when multiple wr.loop_control artifacts present', () => {
    // Agent produced two artifacts in one step — the most recent (last) one wins.
    const artifacts = [
      { kind: 'wr.loop_control', decision: 'continue' },
      { kind: 'wr.loop_control', decision: 'stop' },
    ];
    const result = interpreter.next(compiled, baseState, {}, artifacts);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Last artifact says 'stop', loop should exit
      expect(result.value.isComplete).toBe(true);
    }
  });

  it('earlier stop is overridden by later continue', () => {
    // Inverse case: earlier artifact said stop, later one says continue.
    const artifacts = [
      { kind: 'wr.loop_control', decision: 'stop' },
      { kind: 'wr.loop_control', decision: 'continue' },
    ];
    const result = interpreter.next(compiled, baseState, {}, artifacts);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Last artifact says 'continue', loop should enter
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

  it('trace includes artifact match=found for mismatched loopId stop (regression observability)', () => {
    const compiled = compileWorkflow(buildArtifactContractWorkflow());
    // Agent wrote wrong loopId — engine still finds it (loopId-agnostic)
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'completely-wrong-id', decision: 'stop' },
    ];
    const result = interpreter.next(compiled, baseState, {}, artifacts);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const { trace } = result.value;
      // Should have artifact match trace entry showing 'found' even with wrong loopId
      const matchEntry = trace.find(t => t.summary.includes('artifact match=found'));
      expect(matchEntry).toBeDefined();
      expect(matchEntry!.summary).toContain('decision="stop"');
      // And should have exited the loop
      const kinds = trace.map(t => t.kind);
      expect(kinds).toContain('exited_loop');
    }
  });

  it('trace includes artifact match=not_found when no artifact provided', () => {
    const compiled = compileWorkflow(buildArtifactContractWorkflow());
    const result = interpreter.next(compiled, baseState, {}, []);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const { trace } = result.value;
      const matchEntry = trace.find(t => t.summary.includes('artifact match=not_found'));
      expect(matchEntry).toBeDefined();
    }
  });

  it('trace includes artifact match=invalid when schema-invalid artifact provided, loop defaults to continue', () => {
    const compiled = compileWorkflow(buildArtifactContractWorkflow());
    // Agent produced an artifact with kind=wr.loop_control but invalid schema (uppercase loopId)
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'INVALID-CAPS', decision: 'stop' },
    ];
    const result = interpreter.next(compiled, baseState, {}, artifacts);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const { trace } = result.value;
      const matchEntry = trace.find(t => t.summary.includes('artifact match=invalid'));
      expect(matchEntry).toBeDefined();
      expect(matchEntry!.summary).toContain('schema validation');
      // Loop defaults to continue (enters body) because the artifact is invalid
      expect(result.value.next?.stepInstanceId.stepId).toBe('body-step');
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

// ---------------------------------------------------------------------------
// BUG REGRESSION: sequential artifact_contract while loops
//
// Two artifact_contract while loops running sequentially in the same session.
// Loop-1 exits with { decision: stop }. That stop artifact sits in the session
// history (truthEvents). When loop-2 starts, collectArtifactsForEvaluation
// passes ALL session history artifacts to interpreter.next(). findLoopControlArtifact
// finds loop-1's stale stop and exits loop-2 immediately on iteration 0.
//
// This is the root cause of Phase 7 being silently skipped in wr.coding-task
// when taskComplexity=Large (Phase 2 and Phase 4 are sequential while loops;
// Phase 7 is the third sequential while loop).
//
// The fix must scope artifacts to the current loop instance.
// ---------------------------------------------------------------------------

function buildSequentialTwoLoopWorkflow(): WorkflowDefinition {
  return {
    id: 'sequential-loops-test',
    name: 'Sequential Loops Test',
    description: 'Two sequential artifact_contract while loops',
    version: '1.0.0',
    steps: [
      {
        id: 'loop-1',
        type: 'loop',
        title: 'Loop 1',
        loop: { type: 'while', maxIterations: 3, conditionSource: { kind: 'artifact_contract', contractRef: LOOP_CONTROL_CONTRACT_REF, loopId: 'loop-1' } },
        body: [
          {
            id: 'loop-1-body',
            title: 'Loop 1 Body',
            prompt: 'Do loop 1 work',
            requireConfirmation: false,
            outputContract: { contractRef: LOOP_CONTROL_CONTRACT_REF },
          },
        ],
      },
      {
        id: 'loop-2',
        type: 'loop',
        title: 'Loop 2',
        loop: { type: 'while', maxIterations: 3, conditionSource: { kind: 'artifact_contract', contractRef: LOOP_CONTROL_CONTRACT_REF, loopId: 'loop-2' } },
        body: [
          {
            id: 'loop-2-body',
            title: 'Loop 2 Body',
            prompt: 'Do loop 2 work',
            requireConfirmation: false,
            outputContract: { contractRef: LOOP_CONTROL_CONTRACT_REF },
          },
        ],
      },
    ],
  };
}

describe('BUG: sequential artifact_contract while loops -- stale stop from loop-1 must not affect loop-2', () => {
  const interpreter = new WorkflowInterpreter();
  const compiled = compileWorkflow(buildSequentialTwoLoopWorkflow());

  // Directly construct the state after loop-1 has exited.
  // When loop-1 exits (condition no longer met), the interpreter marks 'loop-1'
  // as completed in the state.completed array and pops the loop frame.
  // This is the state shape from workflow-interpreter.ts:355: completed: [...state.completed, frame.loopId]
  const stateAfterLoop1Exited: ExecutionState = {
    kind: 'running',
    completed: ['loop-1'],
    loopStack: [],
    pendingStep: undefined,
  };

  it('interpreter.next() with only current-step artifacts correctly enters loop-2 (the fix)', () => {
    // The fix: outcome-success.ts passes only inputOutput.artifacts (the current step's
    // submitted artifacts) to interpreter.next() -- NOT the full session history.
    // With the correct contract honored, no stale artifacts reach the interpreter.
    // At the loop-2 entry point, no artifacts are present (loop-2-body hasn't run yet).
    const result = interpreter.next(compiled, stateAfterLoop1Exited, {}, []);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isComplete).toBe(false);
      expect(result.value.next?.stepInstanceId.stepId).toBe('loop-2-body');
    }
  });

  it('interpreter.next() with stale stop artifacts causes contamination (documents the broken contract)', () => {
    // WHY this test exists: documents that the interpreter IS sensitive to stale artifacts
    // and WILL contaminate if given them. The fix is in the caller (outcome-success.ts),
    // not in the interpreter. This test proves why the caller must not pass history.
    const staleArtifacts = [{ kind: 'wr.loop_control', loopId: 'loop-1', decision: 'stop' }];
    const result = interpreter.next(compiled, stateAfterLoop1Exited, {}, staleArtifacts);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // With stale artifacts, the interpreter incorrectly exits loop-2 immediately.
      // This is expected behavior given the broken input -- the interpreter is pure and
      // honors whatever artifacts it receives. The caller must not pass stale artifacts.
      expect(result.value.isComplete).toBe(true);
    }
  });

  it('loop-2 enters correctly when no stale artifacts (baseline sanity check)', () => {
    // Without stale artifacts, loop-2 correctly enters on first iteration.
    const result = interpreter.next(compiled, stateAfterLoop1Exited, {}, []);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isComplete).toBe(false);
      expect(result.value.next?.stepInstanceId.stepId).toBe('loop-2-body');
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
    const found = findLoopControlArtifact(artifacts);
    expect(found).not.toBeNull();
    expect(found?.decision).toBe('stop');
  });

  it('uses the most recent continue artifact when stop is older', () => {
    // Iteration 0 said stop, iteration 1 said continue — newest (continue) wins.
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'loop-step', decision: 'stop' },
      { kind: 'wr.loop_control', loopId: 'loop-step', decision: 'continue' },
    ];
    const found = findLoopControlArtifact(artifacts);
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
