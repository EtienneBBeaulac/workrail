import { describe, it, expect } from '@jest/globals';
import { DefaultWorkflowService } from '../../src/application/services/workflow-service';
import { InMemoryWorkflowStorage } from '../../src/infrastructure/storage/in-memory-storage';
import { Workflow } from '../../src/types/mcp-types';
import { LoopStep } from '../../src/types/workflow-types';

describe('Loop Performance Validation', () => {
  let service: DefaultWorkflowService;
  let storage: InMemoryWorkflowStorage;

  beforeEach(() => {
    storage = new InMemoryWorkflowStorage();
    service = new DefaultWorkflowService(storage);
  });

  it('should have minimal overhead for loop iterations', async () => {
    const loopWorkflow: Workflow = {
      id: 'perf-test-workflow',
      name: 'Performance Test',
      description: 'Testing loop performance',
      version: '0.1.0',
      steps: [
        {
          id: 'test-loop',
          type: 'loop',
          title: 'Performance Loop',
          prompt: 'Testing performance',
          loop: {
            type: 'for',
            count: 10,
            maxIterations: 10
          },
          body: 'loop-body'
        } as LoopStep,
        { id: 'loop-body', title: 'Loop Body', prompt: 'Execute in loop' },
        { id: 'done', title: 'Done', prompt: 'Complete' }
      ]
    };

    storage.setWorkflows([loopWorkflow]);

    // Measure time for 10 iterations
    const startTime = Date.now();
    let context: any = {};
    let completedSteps: string[] = [];
    let iterations = 0;

    while (iterations < 10) {
      const result = await service.getNextStep('perf-test-workflow', completedSteps, context);
      if (result.step?.id === 'loop-body') {
        iterations++;
        context = result.context || context;
        completedSteps = ['loop-body'];
      } else {
        break;
      }
    }

    const endTime = Date.now();
    const totalTime = endTime - startTime;
    const avgTimePerIteration = totalTime / iterations;

    console.log(`Total time for ${iterations} iterations: ${totalTime}ms`);
    console.log(`Average time per iteration: ${avgTimePerIteration.toFixed(2)}ms`);

    // Should be less than 10ms per iteration
    expect(avgTimePerIteration).toBeLessThan(10);
  });

  it('should handle large context efficiently', async () => {
    const contextWorkflow: Workflow = {
      id: 'context-test-workflow',
      name: 'Context Test',
      description: 'Testing context handling',
      version: '0.1.0',
      steps: [
        {
          id: 'context-loop',
          type: 'loop',
          title: 'Context Loop',
          prompt: 'Testing context',
          loop: {
            type: 'while',
            condition: { var: 'count', lessThan: 5 },
            maxIterations: 10
          },
          body: 'increment'
        } as LoopStep,
        { id: 'increment', title: 'Increment', prompt: 'Increment counter' },
        { id: 'finish', title: 'Finish', prompt: 'Done' }
      ]
    };

    storage.setWorkflows([contextWorkflow]);

    // Create a large context (50KB)
    const largeData = 'x'.repeat(50 * 1024);
    let context: any = { count: 0, data: largeData };
    let completedSteps: string[] = [];

    const startTime = Date.now();
    let iterations = 0;

    while (iterations < 5) {
      const result = await service.getNextStep('context-test-workflow', completedSteps, context);
      if (result.step?.id === 'increment') {
        iterations++;
        context = result.context || context;
        context.count++;
        completedSteps = ['increment'];
      } else if (result.step?.id === 'finish') {
        break;
      }
    }

    const endTime = Date.now();
    const totalTime = endTime - startTime;

    console.log(`Time with 50KB context: ${totalTime}ms for ${iterations} iterations`);
    console.log(`Average: ${(totalTime / iterations).toFixed(2)}ms per iteration`);

    // Should handle large context without significant slowdown
    expect(totalTime).toBeLessThan(100); // 100ms for 5 iterations with large context
  });
}); 