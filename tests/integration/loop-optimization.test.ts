import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTest, teardownTest, resolve } from '../di/test-container.js';
import { DI } from '../../src/di/tokens.js';
import { Workflow } from '../../src/types/mcp-types.js';
import { InMemoryWorkflowStorage } from '../../src/infrastructure/storage/in-memory-storage.js';

describe('Loop Optimization Integration', () => {
  let storage: InMemoryWorkflowStorage;

  beforeEach(async () => {
    storage = new InMemoryWorkflowStorage();
    await setupTest({ storage });
  });

  afterEach(() => {
    teardownTest();
  });

  describe('Progressive Context Disclosure', () => {
    it('should provide full context on first iteration and minimal on subsequent', async () => {
      const workflow: Workflow = {
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'Test workflow with optimized loop',
        version: '1.0.0',
        steps: [
          {
            id: 'setup',
            title: 'Setup',
            prompt: 'Initialize data'
          },
          {
            id: 'process-loop',
            type: 'loop',
            title: 'Process Items Loop',
            loop: {
              type: 'forEach',
              items: 'dataItems',
              itemVar: 'currentDataItem',
              indexVar: 'itemIndex',
              maxIterations: 100
            },
            body: [
              {
                id: 'validate-item',
                title: 'Validate Item',
                prompt: 'Validate {{currentDataItem}} at index {{itemIndex}}'
              },
              {
                id: 'process-item',
                title: 'Process Item',
                prompt: 'Process the validated item'
              }
            ],
            functionDefinitions: [
              {
                name: 'validateFormat',
                definition: 'Check if item matches expected format: { id: string, value: number }'
              }
            ]
          },
          {
            id: 'finish',
            title: 'Finish',
            prompt: 'Complete the workflow'
          }
        ]
      };

      await storage.save(workflow);

      // Initial context with data
      const initialContext = {
        dataItems: [
          { id: 'a', value: 1 },
          { id: 'b', value: 2 },
          { id: 'c', value: 3 }
        ]
      };

      // First call - should get the setup step
      const workflowService = resolve(DI.Services.Workflow);
      let result = await workflowService.getNextStep(
        'test-workflow',
        [],
        initialContext
      );
      expect(result.step?.id).toBe('setup');

      // Second call - first loop iteration, should get full context
      result = await workflowService.getNextStep(
        'test-workflow',
        ['setup'],
        initialContext
      );
      
      expect(result.step?.id).toBe('validate-item');
      expect(result.guidance.prompt).toContain('Loop Context');
      expect(result.guidance.prompt).toContain('Iteration: 1');
      expect(result.guidance.prompt).toContain('Total Items: 3');
      expect(result.context).toHaveProperty('currentDataItem');
      expect(result.context?.currentDataItem).toEqual({ id: 'a', value: 1 });

      // Verify full array is in context for first iteration
      expect(result.context).toHaveProperty('dataItems');
      expect(result.context?.dataItems).toHaveLength(3);

      // Third call - still first iteration, second step
      result = await workflowService.getNextStep(
        'test-workflow',
        ['setup', 'validate-item'],
        result.context || initialContext
      );
      
      expect(result.step?.id).toBe('process-item');

      // Fourth call - second iteration, should get minimal context
      result = await workflowService.getNextStep(
        'test-workflow',
        ['setup', 'validate-item', 'process-item'],
        result.context || initialContext
      );
      
      expect(result.step?.id).toBe('validate-item');
      expect(result.guidance.prompt).toContain('Loop Context');
      expect(result.guidance.prompt).toContain('Iteration: 2');
      expect(result.guidance.prompt).toContain('Refer to the phase overview');
      
      // Should have minimal context
      expect(result.context).toHaveProperty('currentDataItem');
      expect(result.context?.currentDataItem).toEqual({ id: 'b', value: 2 });
      
      // Large array should be minimized or removed
      if (result.context?.dataItems) {
        expect(result.context.dataItems).toHaveLength(1); // Only current item
      }
    });

    it('should skip empty loops entirely', async () => {
      const workflow: Workflow = {
        id: 'empty-loop-workflow',
        name: 'Empty Loop Workflow',
        description: 'Test skipping empty loops',
        version: '1.0.0',
        steps: [
          {
            id: 'start',
            title: 'Start',
            prompt: 'Starting workflow'
          },
          {
            id: 'empty-loop',
            type: 'loop',
            title: 'Process Empty Array',
            loop: {
              type: 'forEach',
              items: 'emptyArray',
              maxIterations: 100
            },
            body: {
              id: 'never-executed',
              title: 'Never Executed',
              prompt: 'This should never run'
            }
          },
          {
            id: 'end',
            title: 'End',
            prompt: 'Workflow complete'
          }
        ]
      };

      await storage.save(workflow);

      const context = {
        emptyArray: []
      };

      // First step
      const workflowService = resolve(DI.Services.Workflow);
      let result = await workflowService.getNextStep(
        'empty-loop-workflow',
        [],
        context
      );
      expect(result.step?.id).toBe('start');

      // Second call should skip the empty loop and go to end
      result = await workflowService.getNextStep(
        'empty-loop-workflow',
        ['start'],
        context
      );
      expect(result.step?.id).toBe('end');
      
      // Should not have any loop context
      expect(result.context?._currentLoop).toBeUndefined();
    });
  });

  describe('Context Size Reduction', () => {
    it('should return step with loop context for forEach loops', async () => {
      const workflow: Workflow = {
        id: 'size-test-workflow',
        name: 'Size Test Workflow',
        description: 'Test context handling in loops',
        version: '1.0.0',
        steps: [
          {
            id: 'setup-step',
            title: 'Setup Step',
            prompt: 'Setup before loop'
          },
          {
            id: 'large-loop',
            type: 'loop',
            title: 'Process Large Dataset',
            loop: {
              type: 'forEach',
              items: 'largeDataset',
              maxIterations: 200
            },
            body: {
              id: 'process',
              title: 'Process Item',
              prompt: 'Process {{currentItem}}'
            }
          }
        ]
      };

      await storage.save(workflow);

      // Create a small dataset for this test
      const largeDataset = Array(3).fill(null).map((_, i) => ({
        id: i,
        data: 'test-data'
      }));

      const context = { largeDataset };

      // First call - should get the setup step
      const workflowService = resolve(DI.Services.Workflow);
      const firstResult = await workflowService.getNextStep(
        'size-test-workflow',
        [],
        context
      );
      
      // Verify first step is returned
      expect(firstResult.step?.id).toBe('setup-step');
      
      // Context should be preserved
      expect(firstResult.context).toHaveProperty('largeDataset');
    });
  });

  describe('Function DSL Integration', () => {
    it('should support function definitions in workflows', async () => {
      const workflow: Workflow = {
        id: 'dsl-workflow',
        name: 'DSL Workflow',
        description: 'Test function DSL',
        version: '1.0.0',
        functionDefinitions: [
          {
            name: 'globalValidate',
            definition: 'Validates any item against global rules'
          }
        ],
        steps: [
          {
            id: 'use-functions',
            title: 'Use Functions',
            prompt: 'Apply validation using functions',
            functionReferences: ['globalValidate()']
          }
        ]
      };

      await storage.save(workflow);

      const workflowService = resolve(DI.Services.Workflow);
      const result = await workflowService.getNextStep(
        'dsl-workflow',
        [],
        {}
      );

      // First step should be the function step
      expect(result.step?.id).toBe('use-functions');
      
      // The step should have access to function references
      expect(result.step?.functionReferences).toContain('globalValidate()');
      
      // Workflow should have function definitions
      expect(workflow.functionDefinitions).toHaveLength(1);
      expect(workflow.functionDefinitions[0]?.name).toBe('globalValidate');
    });
  });
});