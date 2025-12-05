import { z, ZodTypeAny } from 'zod';
import { ValidationError } from '../core/error-handler';

const idRegex = /^[A-Za-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Reusable fragments
// ---------------------------------------------------------------------------
const workflowSummarySchema = z.object({
  id: z.string().regex(idRegex),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  version: z.string()
});

const functionParameterSchema = z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'array', 'object']),
  required: z.boolean().optional(),
  description: z.string().optional(),
  enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  default: z.any().optional()
});

const functionDefinitionSchema = z.object({
  name: z.string(),
  definition: z.string(),
  parameters: z.array(functionParameterSchema).optional(),
  scope: z.enum(['workflow', 'loop', 'step']).optional()
});

const functionCallSchema = z.object({
  name: z.string(),
  args: z.record(z.any())
});

const workflowStepSchema = z.object({
  id: z.string().regex(idRegex),
  title: z.string(),
  prompt: z.string(),
  agentRole: z.string().optional(),
  guidance: z.array(z.string()).optional(),
  askForFiles: z.boolean().optional(),
  requireConfirmation: z.boolean().optional(),
  runCondition: z.object({}).optional(),
  functionDefinitions: z.array(functionDefinitionSchema).optional(),
  functionCalls: z.array(functionCallSchema).optional(),
  functionReferences: z.array(z.string()).optional()
});

const workflowSchema = z.object({
  id: z.string().regex(idRegex),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  preconditions: z.array(z.string()).optional(),
  clarificationPrompts: z.array(z.string()).optional(),
  steps: z.array(workflowStepSchema),
  metaGuidance: z.array(z.string()).optional(),
  functionDefinitions: z.array(functionDefinitionSchema).optional()
});

// Mode parameter response schemas
const workflowMetadataSchema = z.object({
  id: z.string().regex(idRegex),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  preconditions: z.array(z.string()).optional(),
  clarificationPrompts: z.array(z.string()).optional(),
  metaGuidance: z.array(z.string()).optional(),
  totalSteps: z.number()
});

const workflowPreviewSchema = workflowMetadataSchema.extend({
  firstStep: workflowStepSchema.nullable()
});

// Union schema for workflow_get that handles all three response types
const workflowGetResponseSchema = z.union([
  workflowSchema,        // Full workflow (for undefined mode or backward compatibility)
  workflowMetadataSchema, // Metadata mode response
  workflowPreviewSchema   // Preview mode response
]);

// ---------------------------------------------------------------------------
// Method result schemas
// ---------------------------------------------------------------------------
export const methodResultSchemas: Record<string, ZodTypeAny> = {
  // workflow_list → { workflows: WorkflowSummary[] }
  workflow_list: z.object({
    workflows: z.array(workflowSummarySchema)
  }),

  // workflow_get → Workflow | WorkflowMetadata | WorkflowPreview (union based on mode parameter)
  workflow_get: workflowGetResponseSchema,

  // workflow_next → { step, guidance, isComplete }
  workflow_next: z.object({
    step: workflowStepSchema.nullable(),
    guidance: z.object({
      prompt: z.string(),
      modelHint: z.string().optional(),
      requiresConfirmation: z.boolean().optional(),
      validationCriteria: z.array(z.string()).optional()
    }),
    isComplete: z.boolean()
  }),

  // workflow_validate → { valid, issues?, suggestions? }
  workflow_validate: z.object({
    valid: z.boolean(),
    issues: z.array(z.string()).optional(),
    suggestions: z.array(z.string()).optional()
  })
};

// ---------------------------------------------------------------------------
// Validator class
// ---------------------------------------------------------------------------
export class ResponseValidator {
  private readonly compiled: Record<string, ZodTypeAny>;

  constructor(schemas: Record<string, ZodTypeAny>) {
    this.compiled = schemas;
  }

  validate(method: string, result: unknown): void {
    const schema = this.compiled[method];
    if (!schema) return; // no schema means unchecked output

    const parsed = schema.safeParse(result);
    if (!parsed.success) {
      throw new ValidationError('Invalid response', undefined, parsed.error.format());
    }
  }
}

export const responseValidator = new ResponseValidator(methodResultSchemas); 