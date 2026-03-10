import type { WorkflowFixture, LoopContext, StepFixture } from '../lifecycle-harness.js';

/**
 * Fixture for test-artifact-loop-control workflow.
 *
 * Tests artifact-based loop control with dynamic per-iteration fixtures.
 * Loop executes 2 iterations then exits.
 */
export const testArtifactLoopControlFixture: WorkflowFixture = {
  workflowId: 'test-artifact-loop-control',
  definition: {
    id: 'test-artifact-loop-control',
    name: 'Test Artifact Loop Control',
    description: 'Test workflow demonstrating typed artifact loop control (Phase 3 migration pattern)',
    version: '1.0.0',
    metaGuidance: [
      'This workflow demonstrates the new artifact-based loop control pattern.',
      "Instead of prose validation (checking for 'continuePlanning = true' in text),",
      'agents provide structured artifacts with typed decisions.',
      'VARIABLE TYPES: Booleans: loopShouldContinue (derived from artifact, not prose).',
    ],
    steps: [
      {
        id: 'init-loop',
        title: 'Initialize Loop',
        prompt:
          'Initialize the bounded iteration loop.\n\n**Provide a loop control artifact:**\n```json\n{\n  "artifacts": [{\n    "kind": "wr.loop_control",\n    "decision": "continue",\n    "metadata": {\n      "reason": "Starting iteration loop"\n    }\n  }]\n}\n```\n\nThe artifact must have:\n- kind: \'wr.loop_control\'\n- decision: \'continue\' or \'stop\'',
        requireConfirmation: false,
        outputContract: {
          contractRef: 'wr.contracts.loop_control',
        },
      },
      {
        id: 'iteration-loop',
        type: 'loop',
        title: 'Iteration Loop',
        loop: {
          type: 'while',
          conditionSource: {
            kind: 'artifact_contract',
            contractRef: 'wr.contracts.loop_control',
            loopId: 'test-iteration',
          },
          maxIterations: 3,
        },
        body: [
          {
            id: 'do-work',
            title: 'Do Iteration Work',
            prompt: 'Perform work for this iteration.\n\nDescribe what you\'re doing this iteration.',
            requireConfirmation: false,
          },
          {
            id: 'decide-continue',
            title: 'Loop Decision',
            prompt:
              'Decide whether to continue or stop the loop.\n\n**Provide a loop control artifact:**\n```json\n{\n  "artifacts": [{\n    "kind": "wr.loop_control",\n    "decision": "continue",\n    "metadata": {\n      "reason": "More work needed",\n      "iterationIndex": 1\n    }\n  }]\n}\n```\n\n**Decision logic:**\n- If more work is needed: decision = \'continue\'\n- If work is complete: decision = \'stop\'\n\nThe artifact must have:\n- kind: \'wr.loop_control\'\n- decision: \'continue\' or \'stop\'',
            requireConfirmation: true,
            outputContract: {
              contractRef: 'wr.contracts.loop_control',
            },
          },
        ],
      },
      {
        id: 'complete',
        title: 'Complete',
        prompt: 'The iteration loop has completed. Summarize what was accomplished.',
        requireConfirmation: false,
      },
    ],
  },
  stepFixtures: (stepId: string, ctx: LoopContext): StepFixture | undefined => {
    switch (stepId) {
      case 'init-loop':
        // Provides the initial loop control artifact.
        // The artifact_contract evaluator finds this when evaluating loop entry for iteration 0.
        return {
          notesMarkdown: 'Loop initialized',
          artifacts: [{ kind: 'wr.loop_control', loopId: 'test-iteration', decision: 'continue' }],
        };
      case 'do-work':
        return { notesMarkdown: `Iteration ${ctx.stepVisitCount} work done` };
      case 'decide-continue':
        // First visit (stepVisitCount=0): continue (drives iteration 1).
        // Second visit (stepVisitCount=1): stop (exits loop).
        return {
          notesMarkdown: ctx.stepVisitCount === 0 ? 'Continuing to next iteration' : 'Stopping loop',
          artifacts: [
            {
              kind: 'wr.loop_control',
              loopId: 'test-iteration',
              decision: ctx.stepVisitCount === 0 ? 'continue' : 'stop',
            },
          ],
        };
      case 'complete':
        return { notesMarkdown: 'Loop execution completed' };
      default:
        return undefined;
    }
  },
};
