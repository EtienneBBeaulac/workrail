/**
 * Tests for top-level step runCondition tracing in WorkflowInterpreter.
 *
 * Verifies that nextTopLevel() emits:
 * - SKIP entries for steps whose runCondition evaluated false
 * - PASS entries for the step whose runCondition passed
 * - "Selected (no condition)" label for unconditional steps
 *
 * These trace entries populate the CONDITIONS EVALUATED section in the console,
 * answering the user's question: "Why was THIS step selected?"
 */
import { describe, it, expect } from 'vitest';
import { WorkflowInterpreter } from '../../src/application/services/workflow-interpreter';
import { WorkflowCompiler } from '../../src/application/services/workflow-compiler';
import { createWorkflow } from '../../src/types/workflow';
import { createBundledSource } from '../../src/types/workflow-source';
import type { WorkflowDefinition } from '../../src/types/workflow-definition';
import type { ExecutionState } from '../../src/domain/execution/state';

const baseState: ExecutionState = { kind: 'init' };

function compileWorkflow(def: WorkflowDefinition) {
  const compiler = new WorkflowCompiler();
  const workflow = createWorkflow(def, createBundledSource());
  const compiled = compiler.compile(workflow);
  if (compiled.isErr()) throw new Error(`Compile failed: ${compiled.error.message}`);
  return compiled.value;
}

/**
 * Workflow with 3 steps:
 * - step-unconditional: no runCondition (always runs)
 * - step-small: runCondition = {var: taskComplexity, equals: Small} (small tasks only)
 * - step-non-small: runCondition = {var: taskComplexity, not_equals: Small} (non-small tasks)
 */
function buildConditionalWorkflow(): WorkflowDefinition {
  return {
    id: 'conditional-trace-test',
    name: 'Conditional Trace Test',
    description: 'Tests runCondition tracing',
    version: '1.0.0',
    steps: [
      {
        id: 'step-unconditional',
        title: 'Unconditional Step',
        prompt: 'Always runs',
      },
      {
        id: 'step-small',
        title: 'Small Task Path',
        prompt: 'For small tasks',
        runCondition: { var: 'taskComplexity', equals: 'Small' },
      },
      {
        id: 'step-non-small',
        title: 'Non-Small Task Path',
        prompt: 'For non-small tasks',
        runCondition: { var: 'taskComplexity', not_equals: 'Small' },
      },
    ],
  };
}

describe('top-level runCondition tracing', () => {
  const interpreter = new WorkflowInterpreter();
  const compiled = compileWorkflow(buildConditionalWorkflow());

  it('unconditional first step: selected_next_step summary contains "no condition"', () => {
    const result = interpreter.next(compiled, baseState, { taskComplexity: 'Medium' }, []);
    expect(result.isOk()).toBe(true);
    const { next, trace } = result._unsafeUnwrap();

    expect(next?.stepInstanceId.stepId).toBe('step-unconditional');

    // Should have exactly one trace entry: selected_next_step with "no condition" label
    const selectedEntry = trace.find((e) => e.kind === 'selected_next_step');
    expect(selectedEntry).toBeDefined();
    expect(selectedEntry?.summary).toContain('no condition');

    // No SKIP or PASS entries for step-unconditional (it has no condition)
    const conditionEntries = trace.filter((e) => e.kind === 'evaluated_condition');
    expect(conditionEntries).toHaveLength(0);
  });

  it('after unconditional step completes, with taskComplexity=Medium: step-small skipped, step-non-small selected', () => {
    // Step 1: get unconditional step
    const first = interpreter.next(compiled, baseState, { taskComplexity: 'Medium' }, []);
    expect(first.isOk()).toBe(true);

    // Complete unconditional step
    const afterFirst = interpreter.applyEvent(first._unsafeUnwrap().state, {
      kind: 'step_completed',
      stepInstanceId: { stepId: 'step-unconditional', loopPath: [] },
    });
    expect(afterFirst.isOk()).toBe(true);

    // Step 2: get next with Medium context -- should skip step-small, select step-non-small
    const second = interpreter.next(
      compiled,
      afterFirst._unsafeUnwrap(),
      { taskComplexity: 'Medium' },
      [],
    );
    expect(second.isOk()).toBe(true);
    const { next, trace } = second._unsafeUnwrap();

    expect(next?.stepInstanceId.stepId).toBe('step-non-small');

    // SKIP entry for step-small
    const skipEntry = trace.find(
      (e) => e.kind === 'evaluated_condition' && e.refs?.some((r) => r.kind === 'step_id' && 'stepId' in r && (r as any).stepId === 'step-small'),
    );
    expect(skipEntry).toBeDefined();
    expect(skipEntry?.summary).toMatch(/^SKIP:/);
    // SKIP must not match isConditionPassed regex
    expect(skipEntry?.summary).not.toMatch(/\btrue\b|\bpass/i);

    // PASS entry for step-non-small
    const passEntry = trace.find(
      (e) => e.kind === 'evaluated_condition' && e.refs?.some((r) => r.kind === 'step_id' && 'stepId' in r && (r as any).stepId === 'step-non-small'),
    );
    expect(passEntry).toBeDefined();
    expect(passEntry?.summary).toMatch(/^PASS:/);
    expect(passEntry?.summary).toContain('Medium'); // context value shown in PASS

    // selected_next_step entry (NOT "no condition" because it has a condition)
    const selectedEntry = trace.find((e) => e.kind === 'selected_next_step');
    expect(selectedEntry).toBeDefined();
    expect(selectedEntry?.summary).not.toContain('no condition');
  });

  it('SKIP entry has step_id ref pointing to skipped step', () => {
    const first = interpreter.next(compiled, baseState, { taskComplexity: 'Medium' }, []);
    const afterFirst = interpreter.applyEvent(first._unsafeUnwrap().state, {
      kind: 'step_completed',
      stepInstanceId: { stepId: 'step-unconditional', loopPath: [] },
    });
    const second = interpreter.next(
      compiled,
      afterFirst._unsafeUnwrap(),
      { taskComplexity: 'Medium' },
      [],
    );
    const { trace } = second._unsafeUnwrap();

    const skipEntry = trace.find((e) => e.kind === 'evaluated_condition' && e.summary.startsWith('SKIP:'));
    expect(skipEntry).toBeDefined();
    expect(skipEntry?.refs).toBeDefined();
    expect(skipEntry?.refs?.some((r) => r.kind === 'step_id')).toBe(true);
    // The step_id ref should point to the skipped step
    const stepIdRef = skipEntry?.refs?.find((r) => r.kind === 'step_id') as any;
    expect(stepIdRef?.stepId).toBe('step-small');
  });

  it('with taskComplexity=Small: step-non-small skipped, step-small selected', () => {
    const first = interpreter.next(compiled, baseState, { taskComplexity: 'Small' }, []);
    const afterFirst = interpreter.applyEvent(first._unsafeUnwrap().state, {
      kind: 'step_completed',
      stepInstanceId: { stepId: 'step-unconditional', loopPath: [] },
    });
    const second = interpreter.next(
      compiled,
      afterFirst._unsafeUnwrap(),
      { taskComplexity: 'Small' },
      [],
    );
    expect(second.isOk()).toBe(true);
    const { next, trace } = second._unsafeUnwrap();

    expect(next?.stepInstanceId.stepId).toBe('step-small');

    // step-small should have a PASS entry
    const passEntry = trace.find(
      (e) => e.kind === 'evaluated_condition' && e.summary.startsWith('PASS:'),
    );
    expect(passEntry).toBeDefined();
    expect(passEntry?.summary).toContain('Small');

    // step-non-small is not reached (step-small was selected first) -- no SKIP for step-non-small
    // (The interpreter returns as soon as it finds the first eligible step)
    const nonSmallSkipEntry = trace.find(
      (e) => e.kind === 'evaluated_condition' && e.refs?.some((r) => r.kind === 'step_id' && 'stepId' in r && (r as any).stepId === 'step-non-small'),
    );
    expect(nonSmallSkipEntry).toBeUndefined();
  });
});
