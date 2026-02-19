/**
 * Reproduction test for INTERNAL_ERROR at phase-planning-complete-gate.
 *
 * Root cause: When a step before a forEach loop completes, interpreter.next()
 * tries to enter the forEach loop. If the required context variable (items array)
 * is missing, it returns LOOP_MISSING_CONTEXT → DomainError.MissingContext.
 * This gets mapped through 3 layers to an opaque INTERNAL_ERROR.
 *
 * This test reproduces the exact scenario from the coding-task-workflow-agentic
 * workflow where `phase-planning-complete-gate` completes but `slices` (the
 * forEach items variable) was never set as a context variable.
 */
import { describe, it, expect } from 'vitest';
import { WorkflowInterpreter } from '../../src/application/services/workflow-interpreter';
import { WorkflowCompiler } from '../../src/application/services/workflow-compiler';
import { createWorkflow } from '../../src/types/workflow';
import { createBundledSource } from '../../src/types/workflow-source';
import type { WorkflowDefinition } from '../../src/types/workflow-definition';
import type { ExecutionState } from '../../src/domain/execution/state';
import { mapContinueWorkflowErrorToToolError, type ContinueWorkflowError } from '../../src/mcp/handlers/v2-execution-helpers';
import { mapInternalErrorToToolError, type InternalError } from '../../src/mcp/handlers/v2-error-mapping';

const baseState: ExecutionState = { kind: 'init' };

function compileWorkflow(def: WorkflowDefinition) {
  const compiler = new WorkflowCompiler();
  const workflow = createWorkflow(def, createBundledSource());
  const compiled = compiler.compile(workflow);
  if (compiled.isErr()) throw new Error(`Compile failed: ${compiled.error.message}`);
  return compiled.value;
}

/**
 * Minimal workflow that reproduces the bug:
 * - A gate step (simulating phase-planning-complete-gate)
 * - Followed immediately by a forEach loop on `slices`
 */
function buildGateThenForEachWorkflow(): WorkflowDefinition {
  return {
    id: 'gate-foreach-test',
    name: 'Gate Then ForEach Test',
    description: 'Reproduces INTERNAL_ERROR when forEach items missing',
    version: '1.0.0',
    steps: [
      {
        id: 'gate-step',
        title: 'Planning Gate',
        prompt: 'Confirm planning is complete. Set: planningComplete = true',
        requireConfirmation: true,
      },
      {
        id: 'impl-loop',
        type: 'loop',
        title: 'Implementation Loop',
        loop: {
          type: 'forEach',
          items: 'slices',
          itemVar: 'currentSlice',
          indexVar: 'sliceIndex',
          maxIterations: 20,
        },
        body: [
          {
            id: 'impl-step',
            title: 'Implement Slice',
            prompt: 'Implement {{currentSlice.name}}',
            requireConfirmation: false,
          },
        ],
      },
    ],
  };
}

describe('forEach loop with missing context variable (bug reproduction)', () => {
  const interpreter = new WorkflowInterpreter();
  const compiled = compileWorkflow(buildGateThenForEachWorkflow());

  it('returns MissingContext error when forEach items variable is not set', () => {
    // Step 1: Advance to gate step
    const first = interpreter.next(compiled, baseState, {}, []);
    expect(first.isOk()).toBe(true);
    expect(first._unsafeUnwrap().next?.stepInstanceId.stepId).toBe('gate-step');

    // Step 2: Complete the gate step
    const afterGate = interpreter.applyEvent(first._unsafeUnwrap().state, {
      kind: 'step_completed',
      stepInstanceId: { stepId: 'gate-step', loopPath: [] },
    });
    expect(afterGate.isOk()).toBe(true);

    // Step 3: Try to get next step — this should try to enter the forEach loop
    // but `slices` is NOT in the context → LOOP_MISSING_CONTEXT
    const next = interpreter.next(compiled, afterGate._unsafeUnwrap(), {}, []);

    // BUG: This returns an error instead of gracefully handling missing items.
    // The error is DomainError.MissingContext which gets mapped to INTERNAL_ERROR.
    expect(next.isErr()).toBe(true);
    if (next.isErr()) {
      expect(next.error._tag).toBe('MissingContext');
      expect(next.error.message).toContain("forEach loop 'impl-loop' requires array context['slices']");
    }
  });

  it('succeeds when forEach items variable is set as array', () => {
    // Step 1: Advance to gate step
    const first = interpreter.next(compiled, baseState, {}, []);
    expect(first.isOk()).toBe(true);

    // Step 2: Complete the gate step
    const afterGate = interpreter.applyEvent(first._unsafeUnwrap().state, {
      kind: 'step_completed',
      stepInstanceId: { stepId: 'gate-step', loopPath: [] },
    });
    expect(afterGate.isOk()).toBe(true);

    // Step 3: With slices set, should enter the loop successfully
    const context = {
      slices: [{ name: 'Slice 1' }, { name: 'Slice 2' }],
    };
    const next = interpreter.next(compiled, afterGate._unsafeUnwrap(), context, []);
    expect(next.isOk()).toBe(true);
    if (next.isOk()) {
      expect(next.value.next?.stepInstanceId.stepId).toBe('impl-step');
    }
  });

  it('treats empty array as valid (skips loop)', () => {
    // Step 1: Advance to gate step
    const first = interpreter.next(compiled, baseState, {}, []);
    expect(first.isOk()).toBe(true);

    // Step 2: Complete the gate step
    const afterGate = interpreter.applyEvent(first._unsafeUnwrap().state, {
      kind: 'step_completed',
      stepInstanceId: { stepId: 'gate-step', loopPath: [] },
    });
    expect(afterGate.isOk()).toBe(true);

    // Step 3: Empty array means 0 items → loop exits immediately → workflow complete
    const context = { slices: [] };
    const next = interpreter.next(compiled, afterGate._unsafeUnwrap(), context, []);
    expect(next.isOk()).toBe(true);
    if (next.isOk()) {
      expect(next.value.isComplete).toBe(true);
    }
  });
});

describe('[H2] Error mapping chain: MissingContext → INTERNAL_ERROR (before fix)', () => {
  it('advance_next_failed (non-context errors) still maps to opaque INTERNAL_ERROR', () => {
    // Non-context errors (e.g. invalid state) should remain internal errors
    const internalError: InternalError = {
      kind: 'advance_next_failed',
      message: "Unsupported state kind 'invalid'",
    };
    const toolError = mapInternalErrorToToolError(internalError);
    expect(toolError.code).toBe('INTERNAL_ERROR');
    expect(toolError.message).toContain('could not compute the next workflow step');
  });
});

describe('[FIX] Missing context now surfaces as actionable MISSING_CONTEXT error', () => {
  it('advance_next_missing_context maps to MISSING_CONTEXT with original message preserved', () => {
    const originalMessage = "forEach loop 'phase-7-implement-slices' requires array context['slices']";
    const internalError: InternalError = {
      kind: 'advance_next_missing_context',
      message: originalMessage,
    };
    const toolError = mapInternalErrorToToolError(internalError);

    // FIX: The original message IS preserved
    expect(toolError.code).toBe('PRECONDITION_FAILED');
    expect(toolError.message).toContain('slices');
    expect(toolError.message).toContain('forEach');
    // FIX: Actionable suggestion included
    expect((toolError as any).details?.suggestion).toContain('context');
  });

  it('precondition_failed (from continue-advance routing) surfaces clear message to agent', () => {
    const continueError: ContinueWorkflowError = {
      kind: 'precondition_failed',
      message: "forEach loop 'phase-7-implement-slices' requires array context['slices']",
      suggestion: 'Set the required context variable in the `context` field of your continue_workflow output.',
    };
    const toolError = mapContinueWorkflowErrorToToolError(continueError);

    // FIX: Clear, actionable error
    expect(toolError.code).toBe('PRECONDITION_FAILED');
    expect(toolError.message).toContain('slices');
    expect(toolError.message).toContain('forEach');
  });
});
