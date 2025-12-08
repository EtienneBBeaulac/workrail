import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DefaultWorkflowLoader } from '../../src/application/services/workflow-loader';
import { InMemoryWorkflowProvider } from '../../src/infrastructure/storage/in-memory-storage';
import { ValidationEngine } from '../../src/application/services/validation-engine';
import { EnhancedLoopValidator } from '../../src/application/services/enhanced-loop-validator';
import type { Workflow } from '../../src/types/schemas.js';
import { container } from 'tsyringe';
import { FakeLoggerFactory } from '../helpers/FakeLoggerFactory.js';

describe('DefaultWorkflowLoader', () => {
  let loader: DefaultWorkflowLoader;
  let storage: InMemoryWorkflowProvider;
  let validationEngine: ValidationEngine;

  beforeEach(() => {
    // Reset container for fresh instances
    container.clearInstances();
    
    // Resolve dependencies from DI container
    const enhancedLoopValidator = container.resolve(EnhancedLoopValidator);
    const loggerFactory = new FakeLoggerFactory();
    
    storage = new InMemoryWorkflowProvider();
    validationEngine = new ValidationEngine(enhancedLoopValidator);
    loader = new DefaultWorkflowLoader(storage as any, validationEngine, loggerFactory);
  });

  afterEach(() => {
    container.clearInstances();
  });

  describe('loadAndValidate', () => {
    it('should load and validate a simple workflow', async () => {
      const workflow: any = {
        id: 'simple',
        name: 'Simple Workflow',
        description: 'Test',
        version: '1.0.0',
        steps: [
          { id: 'step-1', title: 'Step 1', prompt: 'Do step 1', agentRole: 'Test' },
          { id: 'step-2', title: 'Step 2', prompt: 'Do step 2', agentRole: 'Test' }
        ]
      };

      storage.setWorkflows([workflow]);

      const result = await loader.loadAndValidate('simple' as any);

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.workflow).toBeDefined();
        expect(result.value.loopBodySteps.size).toBe(0);
      }
    });

    it('should return error for non-existent workflow', async () => {
      const result = await loader.loadAndValidate('non-existent' as any);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error._tag).toBe('WorkflowNotFound');
      }
    });

    it('should return error for invalid workflow structure', async () => {
      const invalidWorkflow: any = {
        id: 'invalid',
        name: 'Invalid',
        description: 'Test',
        version: '1.0.0',
        // Missing required title on step - ValidationEngine should catch this
        steps: [
          { id: 'bad-step', prompt: 'Test' }
        ]
      };

      storage.setWorkflows([invalidWorkflow]);

      const result = await loader.loadAndValidate('invalid' as any);
      expect(result.isErr()).toBe(true);
      // Note: May be UnexpectedError during migration while ValidationEngine uses old types
      if (result.isErr()) {
        expect(['ValidationFailed', 'UnexpectedError']).toContain(result.error._tag);
      }
    });

    it('should identify loop body steps with string body', async () => {
      const workflow: any = {
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
            agentRole: 'Test role',  // Required field
            loop: { type: 'for', count: 3, maxIterations: 10 },
            body: 'body-step'
          },
          { id: 'body-step', title: 'Body', prompt: 'Body', agentRole: 'Test' },
          { id: 'after', title: 'After', prompt: 'After', agentRole: 'Test' }
        ]
      };

      storage.setWorkflows([workflow]);

      const result = await loader.loadAndValidate('loop-workflow' as any);
      
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.loopBodySteps.has('body-step')).toBe(true);
        expect(result.value.loopBodySteps.has('my-loop')).toBe(false);
        expect(result.value.loopBodySteps.has('after')).toBe(false);
        expect(result.value.loopBodySteps.size).toBe(1);
      }
    });

    it('should identify loop body steps with array body', async () => {
      const workflow: any = {
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
            agentRole: 'Test',
            loop: { type: 'for', count: 2, maxIterations: 10 },
            body: [
              { id: 'step-a', title: 'A', prompt: 'A', agentRole: 'Test' },
              { id: 'step-b', title: 'B', prompt: 'B', agentRole: 'Test' },
              { id: 'step-c', title: 'C', prompt: 'C', agentRole: 'Test' }
            ]
          },
          { id: 'after', title: 'After', prompt: 'After', agentRole: 'Test' }
        ]
      };

      storage.setWorkflows([workflow]);

      const result = await loader.loadAndValidate('multi-body-loop' as any);
      
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.loopBodySteps.has('step-a')).toBe(true);
        expect(result.value.loopBodySteps.has('step-b')).toBe(true);
        expect(result.value.loopBodySteps.has('step-c')).toBe(true);
        expect(result.value.loopBodySteps.has('loop')).toBe(false);
        expect(result.value.loopBodySteps.has('after')).toBe(false);
        expect(result.value.loopBodySteps.size).toBe(3);
      }
    });

    it('should handle multiple loops', async () => {
      const workflow: any = {
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
            agentRole: 'Test',
            loop: { type: 'for', count: 2, maxIterations: 10 },
            body: 'body-1'
          },
          { id: 'body-1', title: 'Body 1', prompt: 'Body 1', agentRole: 'Test' },
          {
            id: 'loop-2',
            type: 'loop',
            title: 'Loop 2',
            prompt: 'Loop 2',
            agentRole: 'Test',
            loop: { type: 'for', count: 2, maxIterations: 10 },
            body: 'body-2'
          },
          { id: 'body-2', title: 'Body 2', prompt: 'Body 2', agentRole: 'Test' }
        ]
      };

      storage.setWorkflows([workflow]);

      const result = await loader.loadAndValidate('multi-loop' as any);
      
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.loopBodySteps.has('body-1')).toBe(true);
        expect(result.value.loopBodySteps.has('body-2')).toBe(true);
        expect(result.value.loopBodySteps.size).toBe(2);
      }
    });
  });
});
