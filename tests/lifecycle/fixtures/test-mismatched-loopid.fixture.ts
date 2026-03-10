import type { WorkflowFixture, LoopContext, StepFixture } from '../lifecycle-harness.js';

/**
 * Regression fixture: agent produces artifact with wrong loopId.
 *
 * Reproduces the exact bug that caused infinite loops:
 * - conditionSource.loopId is 'plan_audit_loop'
 * - Agent copies the step ID 'phase-4-iterations' into the artifact instead
 * - Engine must still honor the stop decision (loopId-agnostic matching)
 *
 * Without the fix, findLoopControlArtifact returned null for the mismatched ID,
 * the engine defaulted to "continue", and the loop ran forever.
 */
export const testMismatchedLoopIdFixture: WorkflowFixture = {
  workflowId: 'test-mismatched-loopid',
  definition: {
    id: 'test-mismatched-loopid',
    name: 'Mismatched LoopId Regression',
    description: 'Regression: agent uses wrong loopId in artifact, engine still exits',
    version: '1.0.0',
    steps: [
      {
        id: 'init',
        title: 'Initialize',
        prompt: 'Provide initial loop control artifact.',
        requireConfirmation: false,
        outputContract: {
          contractRef: 'wr.contracts.loop_control',
        },
      },
      {
        id: 'phase-4-iterations',
        type: 'loop',
        title: 'Audit Loop',
        loop: {
          type: 'while',
          conditionSource: {
            kind: 'artifact_contract',
            contractRef: 'wr.contracts.loop_control',
            // This is the "real" loopId the engine expects
            loopId: 'plan_audit_loop',
          },
          maxIterations: 5,
        },
        body: [
          {
            id: 'do-work',
            title: 'Do Work',
            prompt: 'Do some work.',
            requireConfirmation: false,
          },
          {
            id: 'exit-decision',
            title: 'Exit Decision',
            prompt: 'Decide whether to stop.',
            requireConfirmation: false,
            outputContract: {
              contractRef: 'wr.contracts.loop_control',
            },
          },
        ],
      },
      {
        id: 'done',
        title: 'Done',
        prompt: 'Summarize.',
        requireConfirmation: false,
      },
    ],
  },
  stepFixtures: (stepId: string, _ctx: LoopContext): StepFixture | undefined => {
    switch (stepId) {
      case 'init':
        return {
          notesMarkdown: 'Initialized',
          artifacts: [{ kind: 'wr.loop_control', loopId: 'plan_audit_loop', decision: 'continue' }],
        };
      case 'do-work':
        return { notesMarkdown: 'Work done' };
      case 'exit-decision':
        // THE BUG: agent uses the step ID 'phase-4-iterations' instead of the
        // conditionSource loopId 'plan_audit_loop'. With the loopId-agnostic fix,
        // the engine still finds and honors this stop decision.
        return {
          notesMarkdown: 'Stopping — all work complete',
          artifacts: [{
            kind: 'wr.loop_control',
            loopId: 'phase-4-iterations',  // WRONG — but engine must still honor it
            decision: 'stop',
          }],
        };
      case 'done':
        return { notesMarkdown: 'Complete' };
      default:
        return undefined;
    }
  },
};
