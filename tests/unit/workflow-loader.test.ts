import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DefaultWorkflowLoader } from '../../src/application/services/workflow-loader';
import { InMemoryWorkflowStorage } from '../../src/infrastructure/storage/in-memory-storage';
import { ValidationEngine } from '../../src/application/services/validation-engine';
import { EnhancedLoopValidator } from '../../src/application/services/enhanced-loop-validator';
import { Workflow } from '../../src/types/mcp-types';
import { WorkflowNotFoundError } from '../../src/core/error-handler';
import { container } from 'tsyringe';
import { FakeLoggerFactory } from '../helpers/FakeLoggerFactory.js';

describe('DefaultWorkflowLoader', () => {
  let loader: DefaultWorkflowLoader;
  let storage: InMemoryWorkflowStorage;
  let validationEngine: ValidationEngine;

  beforeEach(() => {
    // Reset container for fresh instances
    container.clearInstances();
    
    // Resolve dependencies from DI container
    const enhancedLoopValidator = container.resolve(EnhancedLoopValidator);
    const loggerFactory = new FakeLoggerFactory();
    
    storage = new InMemoryWorkflowStorage();
    validationEngine = new ValidationEngine(enhancedLoopValidator);
    loader = new DefaultWorkflowLoader(storage, validationEngine, loggerFactory);
  });

  afterEach(() => {
    container.clearInstances();
  });

  describe('loadAndValidate', () => {
    it('should load and validate a simple workflow', async () => {
      const workflow: Workflow = {
        id: 'simple',
        name: 'Simple Workflow',
        description: 'Test',
        version: '1.0.0',
        steps: [
          { id: 'step-1', title: 'Step 1', prompt: 'Do step 1' },
          { id: 'step-2', title: 'Step 2', prompt: 'Do step 2' }
        ]
      };

      storage.setWorkflows([workflow]);

      const result = await loader.loadAndValidate('simple');

      expect(result.workflow).toEqual(workflow);
      expect(result.loopBodySteps.size).toBe(0);
    });

    it('should throw WorkflowNotFoundError for non-existent workflow', async () => {
      await expect(loader.loadAndValidate('non-existent')).rejects.toThrow(WorkflowNotFoundError);
    });

    it('should throw error for invalid workflow structure', async () => {
      const invalidWorkflow: any = {
        id: 'invalid',
        name: 'Invalid',
        description: 'Test',
        version: '1.0.0',
        // Missing required title on step
        steps: [
          { id: 'bad-step', prompt: 'Test' }
        ]
      };

      storage.setWorkflows([invalidWorkflow]);

      await expect(loader.loadAndValidate('invalid')).rejects.toThrow('Invalid workflow structure');
    });

    it('should identify loop body steps with string body', async () => {
      const workflow: Workflow = {
        id: 'loop-workflow',
        name: 'Loop',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'my-loop',
            type: 'loop',
            title: 'Loop',
            prompt: 'Loop',
            loop: { type: 'for', count: 3, maxIterations: 10 },
            body: 'body-step'
          },
          { id: 'body-step', title: 'Body', prompt: 'Body' },
          { id: 'after', title: 'After', prompt: 'After' }
        ]
      };

      storage.setWorkflows([workflow]);

      const result = await loader.loadAndValidate('loop-workflow');

      expect(result.loopBodySteps.has('body-step')).toBe(true);
      expect(result.loopBodySteps.has('my-loop')).toBe(false);
      expect(result.loopBodySteps.has('after')).toBe(false);
      expect(result.loopBodySteps.size).toBe(1);
    });

    it('should identify loop body steps with array body', async () => {
      const workflow: Workflow = {
        id: 'multi-body-loop',
        name: 'Multi Body',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'loop',
            type: 'loop',
            title: 'Loop',
            prompt: 'Loop',
            loop: { type: 'for', count: 2, maxIterations: 10 },
            body: [
              { id: 'step-a', title: 'A', prompt: 'A' },
              { id: 'step-b', title: 'B', prompt: 'B' },
              { id: 'step-c', title: 'C', prompt: 'C' }
            ]
          },
          { id: 'after', title: 'After', prompt: 'After' }
        ]
      };

      storage.setWorkflows([workflow]);

      const result = await loader.loadAndValidate('multi-body-loop');

      expect(result.loopBodySteps.has('step-a')).toBe(true);
      expect(result.loopBodySteps.has('step-b')).toBe(true);
      expect(result.loopBodySteps.has('step-c')).toBe(true);
      expect(result.loopBodySteps.has('loop')).toBe(false);
      expect(result.loopBodySteps.has('after')).toBe(false);
      expect(result.loopBodySteps.size).toBe(3);
    });

    it('should handle multiple loops', async () => {
      const workflow: Workflow = {
        id: 'multi-loop',
        name: 'Multi Loop',
        description: 'Test',
        version: '1.0.0',
        steps: [
          {
            id: 'loop-1',
            type: 'loop',
            title: 'Loop 1',
            prompt: 'Loop 1',
            loop: { type: 'for', count: 2, maxIterations: 10 },
            body: 'body-1'
          },
          { id: 'body-1', title: 'Body 1', prompt: 'Body 1' },
          {
            id: 'loop-2',
            type: 'loop',
            title: 'Loop 2',
            prompt: 'Loop 2',
            loop: { type: 'for', count: 2, maxIterations: 10 },
            body: 'body-2'
          },
          { id: 'body-2', title: 'Body 2', prompt: 'Body 2' }
        ]
      };

      storage.setWorkflows([workflow]);

      const result = await loader.loadAndValidate('multi-loop');

      expect(result.loopBodySteps.has('body-1')).toBe(true);
      expect(result.loopBodySteps.has('body-2')).toBe(true);
      expect(result.loopBodySteps.size).toBe(2);
    });
  });
});
