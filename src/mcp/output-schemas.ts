import { z } from 'zod';
import { ExecutionStateSchema } from '../domain/execution/state.js';

// -----------------------------------------------------------------------------
// JSON-safe value schema (prevents undefined / functions leaking across boundary)
// -----------------------------------------------------------------------------

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

const JsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonPrimitiveSchema, z.array(JsonValueSchema), z.record(JsonValueSchema)])
);

// -----------------------------------------------------------------------------
// Workflow tool outputs
// -----------------------------------------------------------------------------

export const WorkflowSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  version: z.string(),
});

export const WorkflowListOutputSchema = z.object({
  workflows: z.array(WorkflowSummarySchema),
});

export const WorkflowGetOutputSchema = z.object({
  workflow: JsonValueSchema,
});

export const WorkflowNextOutputSchema = z.object({
  state: ExecutionStateSchema,
  next: JsonValueSchema.nullable(),
  isComplete: z.boolean(),
});

export const WorkflowValidateJsonOutputSchema = z.object({
  valid: z.boolean(),
  errors: z
    .array(
      z.object({
        message: z.string(),
        path: z.string().optional(),
      })
    )
    .optional(),
  suggestions: z.array(z.string()).optional(),
});

export const WorkflowGetSchemaOutputSchema = z.object({
  schema: JsonValueSchema,
  metadata: z.object({
    version: z.string(),
    description: z.string(),
    usage: z.string(),
    schemaPath: z.string(),
  }),
  commonPatterns: z.object({
    basicWorkflow: z.record(z.string()),
    stepStructure: z.record(z.string()),
  }),
});

// -----------------------------------------------------------------------------
// v2 tool outputs (Slice 1)
// -----------------------------------------------------------------------------

export const V2WorkflowListItemSchema = z.object({
  workflowId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().min(1),
  kind: z.literal('workflow'),
  workflowHash: z.string().nullable(),
});

export const V2WorkflowListOutputSchema = z.object({
  workflows: z.array(V2WorkflowListItemSchema),
});

export const V2WorkflowInspectOutputSchema = z.object({
  workflowId: z.string().min(1),
  workflowHash: z.string().min(1),
  mode: z.enum(['metadata', 'preview']),
  compiled: JsonValueSchema,
});

// -----------------------------------------------------------------------------
// Session tool outputs
// -----------------------------------------------------------------------------

export const CreateSessionOutputSchema = z.object({
  sessionId: z.string().min(1),
  workflowId: z.string().min(1),
  path: z.string(),
  dashboardUrl: z.string().nullable(),
  createdAt: z.string(),
});

export const UpdateSessionOutputSchema = z.object({
  updatedAt: z.string(),
});

export const ReadSessionOutputSchema = z.object({
  query: z.string(),
  data: JsonValueSchema,
});

export const ReadSessionSchemaOutputSchema = z.object({
  query: z.literal('$schema'),
  schema: z.object({
    description: z.string(),
    mainSections: z.record(z.string()),
    commonQueries: z.record(z.string()),
    updatePatterns: z.record(z.string()),
    fullSchemaDoc: z.string(),
  }),
});

export const OpenDashboardOutputSchema = z.object({
  url: z.string(),
});
