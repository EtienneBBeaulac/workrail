import { Workflow } from '../../src/types/mcp-types.js';

/**
 * Test fixtures for workflows.
 */
export const FIXTURES = {
  simpleWorkflow: {
    id: 'simple',
    name: 'Simple Workflow',
    description: 'Test workflow with basic steps',
    version: '1.0.0',
    steps: [
      {
        id: 'step1',
        title: 'Step 1',
        prompt: 'Do step 1',
        agentRole: 'assistant',
      },
      {
        id: 'step2',
        title: 'Step 2',
        prompt: 'Do step 2',
        agentRole: 'assistant',
      },
    ],
  } as Workflow,

  loopWorkflow: {
    id: 'loop',
    name: 'Loop Workflow',
    description: 'Workflow with loop',
    version: '1.0.0',
    steps: [
      {
        id: 'start',
        title: 'Start',
        prompt: 'Start the process',
        agentRole: 'assistant',
      },
      {
        id: 'loop_step',
        type: 'loop',
        title: 'Loop',
        prompt: 'Loop prompt',
        agentRole: 'assistant',
        loop: { type: 'for', count: 3, maxIterations: 10 },
        body: 'loop_body',
      },
      {
        id: 'loop_body',
        title: 'Loop Body',
        prompt: 'Loop body step',
        agentRole: 'assistant',
      },
      {
        id: 'end',
        title: 'End',
        prompt: 'End the process',
        agentRole: 'assistant',
      },
    ],
  } as Workflow,

  conditionalWorkflow: {
    id: 'conditional',
    name: 'Conditional Workflow',
    description: 'Workflow with conditions',
    version: '1.0.0',
    steps: [
      {
        id: 'start',
        title: 'Start',
        prompt: 'Start',
        agentRole: 'assistant',
      },
      {
        id: 'decision',
        title: 'Make Decision',
        prompt: 'What do you choose?',
        agentRole: 'assistant',
        conditions: [
          {
            when: 'choice === "a"',
            next: 'path_a',
          },
          {
            when: 'choice === "b"',
            next: 'path_b',
          },
        ],
        default: 'end',
      },
      {
        id: 'path_a',
        title: 'Path A',
        prompt: 'You chose A',
        agentRole: 'assistant',
      },
      {
        id: 'path_b',
        title: 'Path B',
        prompt: 'You chose B',
        agentRole: 'assistant',
      },
      {
        id: 'end',
        title: 'End',
        prompt: 'Done',
        agentRole: 'assistant',
      },
    ],
  } as Workflow,
};
