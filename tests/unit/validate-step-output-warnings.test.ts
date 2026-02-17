import { describe, expect, it } from 'vitest';

import { DefaultWorkflowService } from '../../src/application/services/workflow-service.js';
import { ValidationEngine } from '../../src/application/services/validation-engine.js';
import { EnhancedLoopValidator } from '../../src/application/services/enhanced-loop-validator.js';
import { createWorkflow } from '../../src/types/workflow.js';
import { createProjectDirectorySource } from '../../src/types/workflow-source.js';
import * as os from 'os';
import * as path from 'path';

describe('WorkflowService.validateStepOutput warnings plumbing', () => {
  it('surfaces schema coercion warnings from ValidationEngine to the service consumer', async () => {
    const workflowId = 'wf-1';
    const stepId = 'step-1';

    const wf = createWorkflow(
      {
        id: workflowId,
        name: 'Test WF',
        description: 'Test',
        version: '0.1.0',
        steps: [
          {
            id: stepId,
            title: 'Step',
            prompt: 'Prompt',
            // NOTE: schema allows array-of-rules; internal type is narrower, so cast for test.
            validationCriteria: [
              {
                type: 'schema',
                schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
                message: 'Must be object',
              },
            ] as any,
          },
        ],
      } as any,
      createProjectDirectorySource(path.join(os.tmpdir(), 'workrail-project'))
    );

    const storage = {
      listWorkflowSummaries: async () => [],
      getWorkflowById: async (id: string) => (id === workflowId ? wf : null),
    } as any;

    const validationEngine = new ValidationEngine(new EnhancedLoopValidator());

    // Compiler/interpreter are unused by validateStepOutput; stub them.
    const service = new DefaultWorkflowService(storage, validationEngine, {} as any, {} as any);

    const doubleEncoded = '"{\\"name\\": \\"John\\"}"';
    const result = await service.validateStepOutput(workflowId, stepId, doubleEncoded);

    expect(result.valid).toBe(true);
    expect(result.warnings?.some((w) => w.includes('Coerced double-encoded JSON'))).toBe(true);
  });
});
