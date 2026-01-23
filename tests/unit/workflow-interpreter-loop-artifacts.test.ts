import { describe, it, expect } from 'vitest';
import { WorkflowInterpreter } from '../../src/application/services/workflow-interpreter';
import { WorkflowCompiler } from '../../src/application/services/workflow-compiler';
import { createWorkflow } from '../../src/types/workflow';
import { createBundledSource } from '../../src/types/workflow-source';
import type { WorkflowDefinition } from '../../src/types/workflow-definition';
import type { ExecutionState } from '../../src/domain/execution/state';

function buildLoopWorkflow(): WorkflowDefinition {
  return {
    id: 'loop-artifact-test',
    name: 'Loop Artifact Test',
    description: 'Test artifact-based loop control',
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
          {
            id: 'body-step',
            title: 'Body Step',
            prompt: 'Do work',
            requireConfirmation: false,
          },
        ],
      },
    ],
  };
}

describe('WorkflowInterpreter loop artifact evaluation', () => {
  const compiler = new WorkflowCompiler();
  const interpreter = new WorkflowInterpreter();

  const workflow = createWorkflow(buildLoopWorkflow(), createBundledSource());
  const compiled = compiler.compile(workflow);

  if (compiled.isErr()) {
    throw new Error(`Failed to compile test workflow: ${compiled.error.message}`);
  }

  const baseState: ExecutionState = { kind: 'init' };

  it('uses artifact decision to override context (continue)', () => {
    const context = { continuePlanning: false };
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'loop-step', decision: 'continue' },
    ];

    const nextRes = interpreter.next(compiled.value, baseState, context, artifacts);
    expect(nextRes.isOk()).toBe(true);
    if (nextRes.isOk()) {
      expect(nextRes.value.next?.stepInstanceId.stepId).toBe('body-step');
      expect(nextRes.value.isComplete).toBe(false);
    }
  });

  it('uses artifact decision to override context (stop)', () => {
    const context = { continuePlanning: true };
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'loop-step', decision: 'stop' },
    ];

    const nextRes = interpreter.next(compiled.value, baseState, context, artifacts);
    expect(nextRes.isOk()).toBe(true);
    if (nextRes.isOk()) {
      expect(nextRes.value.next).toBeNull();
      expect(nextRes.value.isComplete).toBe(true);
    }
  });

  it('falls back to context when no artifact', () => {
    const context = { continuePlanning: true };

    const nextRes = interpreter.next(compiled.value, baseState, context, []);
    expect(nextRes.isOk()).toBe(true);
    if (nextRes.isOk()) {
      expect(nextRes.value.next?.stepInstanceId.stepId).toBe('body-step');
    }
  });

  it('falls back to context when loopId does not match', () => {
    const context = { continuePlanning: true };
    const artifacts = [
      { kind: 'wr.loop_control', loopId: 'other-loop', decision: 'stop' },
    ];

    const nextRes = interpreter.next(compiled.value, baseState, context, artifacts);
    expect(nextRes.isOk()).toBe(true);
    if (nextRes.isOk()) {
      expect(nextRes.value.next?.stepInstanceId.stepId).toBe('body-step');
    }
  });
});