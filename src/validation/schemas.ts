/**
 * Collection of per-method parameter schemas used for request validation.
 * Using raw schema objects to keep typings simple.
 */
export const methodParamSchemas: Record<string, any> = {
  workflow_list: {
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  workflow_get: {
    type: 'object',
    properties: {
      id: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' },
      mode: { 
        type: 'string', 
        enum: ['metadata', 'preview'],
        description: 'The level of detail to return: metadata (workflow info only) or preview (metadata + first step)',
        default: 'preview'
      }
    },
    required: ['id'],
    additionalProperties: false
  },
  workflow_next: {
    type: 'object',
    properties: {
      workflowId: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' },
      completedSteps: {
        type: 'array',
        items: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' },
        nullable: true,
        default: []
      },
      context: {
        type: 'object',
        description: 'Optional execution context for evaluating step conditions',
        additionalProperties: true
      }
    },
    required: ['workflowId'],
    additionalProperties: false
  },
  workflow_validate: {
    type: 'object',
    properties: {
      workflowId: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' },
      stepId: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' },
      output: { type: 'string', maxLength: 10000 }
    },
    required: ['workflowId', 'stepId', 'output'],
    additionalProperties: false
  }
}; 