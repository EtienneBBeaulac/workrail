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
// v2 execution tool outputs (Slice 3)
// -----------------------------------------------------------------------------

export const V2PendingStepSchema = z.object({
  stepId: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().min(1),
});

export const V2PreferencesSchema = z.object({
  autonomy: z.enum(['guided', 'full_auto_stop_on_user_deps', 'full_auto_never_stop']),
  riskPolicy: z.enum(['conservative', 'balanced', 'aggressive']),
});

export const V2NextIntentSchema = z.enum([
  'perform_pending_then_continue',
  'await_user_confirmation',
  'rehydrate_only',
  'complete',
]);

// Pre-built continuation template: tells the agent exactly what to call when done.
// null when workflow is complete or blocked non-retryable (nothing to call).
// Discriminated union: advance always has ackToken, rehydrate never does.
const V2NextCallAdvanceParams = z.object({
  intent: z.literal('advance'),
  stateToken: z.string().min(1),
  ackToken: z.string().min(1),
});
const V2NextCallRehydrateParams = z.object({
  intent: z.literal('rehydrate'),
  stateToken: z.string().min(1),
});
export const V2NextCallSchema = z.object({
  tool: z.literal('continue_workflow'),
  params: z.discriminatedUnion('intent', [V2NextCallAdvanceParams, V2NextCallRehydrateParams]),
}).nullable();

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

const MAX_BLOCKER_MESSAGE_BYTES = 512;
const MAX_BLOCKER_SUGGESTED_FIX_BYTES = 1024;
const MAX_BLOCKERS = 10;

const DELIMITER_SAFE_ID_PATTERN = /^[a-z0-9_-]+$/;

const V2BlockerPointerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('context_key'),
    key: z.string().min(1).regex(DELIMITER_SAFE_ID_PATTERN, 'context_key must be delimiter-safe: [a-z0-9_-]+'),
  }),
  z.object({ kind: z.literal('context_budget') }),
  z.object({ kind: z.literal('output_contract'), contractRef: z.string().min(1) }),
  z.object({ kind: z.literal('capability'), capability: z.enum(['delegation', 'web_browsing']) }),
  z.object({
    kind: z.literal('workflow_step'),
    stepId: z.string().min(1).regex(DELIMITER_SAFE_ID_PATTERN, 'stepId must be delimiter-safe: [a-z0-9_-]+'),
  }),
]);

const V2BlockerSchema = z.object({
  code: z.enum([
    'USER_ONLY_DEPENDENCY',
    'MISSING_REQUIRED_OUTPUT',
    'INVALID_REQUIRED_OUTPUT',
    'MISSING_REQUIRED_NOTES',
    'MISSING_CONTEXT_KEY',
    'CONTEXT_BUDGET_EXCEEDED',
    'REQUIRED_CAPABILITY_UNKNOWN',
    'REQUIRED_CAPABILITY_UNAVAILABLE',
    'INVARIANT_VIOLATION',
    'STORAGE_CORRUPTION_DETECTED',
  ]),
  pointer: V2BlockerPointerSchema,
  message: z
    .string()
    .min(1)
    .refine((s) => utf8ByteLength(s) <= MAX_BLOCKER_MESSAGE_BYTES, {
      message: `Blocker message exceeds ${MAX_BLOCKER_MESSAGE_BYTES} bytes (UTF-8)`,
    }),
  suggestedFix: z
    .string()
    .min(1)
    .refine((s) => utf8ByteLength(s) <= MAX_BLOCKER_SUGGESTED_FIX_BYTES, {
      message: `Blocker suggestedFix exceeds ${MAX_BLOCKER_SUGGESTED_FIX_BYTES} bytes (UTF-8)`,
    })
    .optional(),
});

export const V2BlockerReportSchema = z
  .object({
    blockers: z.array(V2BlockerSchema).min(1).max(MAX_BLOCKERS).readonly(),
  })
  .superRefine((v, ctx) => {
    const keyFor = (b: z.infer<typeof V2BlockerSchema>): string => {
      const p = b.pointer;
      let ptrStable: string;
      switch (p.kind) {
        case 'context_key':
          ptrStable = p.key;
          break;
        case 'output_contract':
          ptrStable = p.contractRef;
          break;
        case 'capability':
          ptrStable = p.capability;
          break;
        case 'workflow_step':
          ptrStable = p.stepId;
          break;
        case 'context_budget':
          ptrStable = '';
          break;
        default: {
          const _exhaustive: never = p;
          ptrStable = _exhaustive;
        }
      }
      return `${b.code}|${p.kind}|${String(ptrStable)}`;
    };

    for (let i = 1; i < v.blockers.length; i++) {
      if (keyFor(v.blockers[i - 1]!) > keyFor(v.blockers[i]!)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'blockers must be deterministically sorted', path: ['blockers'] });
        break;
      }
    }
  });

// Checkpoint token format: chk1<bech32m chars>
const checkpointTokenSchema = z.string().regex(/^chk1[023456789acdefghjklmnpqrstuvwxyz]+$/, 'Invalid checkpointToken format').optional();

const V2ContinueWorkflowOkSchema = z.object({
  kind: z.literal('ok'),
  stateToken: z.string().regex(/^st1[023456789acdefghjklmnpqrstuvwxyz]+$/, 'Invalid stateToken format'),
  ackToken: z.string().regex(/^ack1[023456789acdefghjklmnpqrstuvwxyz]+$/, 'Invalid ackToken format').optional(),
  checkpointToken: checkpointTokenSchema,
  isComplete: z.boolean(),
  pending: V2PendingStepSchema.nullable(),
  preferences: V2PreferencesSchema,
  nextIntent: V2NextIntentSchema,
  nextCall: V2NextCallSchema,
});

const V2ContinueWorkflowBlockedSchema = z.object({
  kind: z.literal('blocked'),
  stateToken: z.string().regex(/^st1[023456789acdefghjklmnpqrstuvwxyz]+$/, 'Invalid stateToken format'),
  ackToken: z.string().regex(/^ack1[023456789acdefghjklmnpqrstuvwxyz]+$/, 'Invalid ackToken format').optional(),
  checkpointToken: checkpointTokenSchema,
  isComplete: z.boolean(),
  pending: V2PendingStepSchema.nullable(),
  preferences: V2PreferencesSchema,
  nextIntent: V2NextIntentSchema,
  nextCall: V2NextCallSchema,
  blockers: V2BlockerReportSchema,
  // Additive (backward compatible): enables one-call retry for retryable blocks
  retryable: z.boolean().optional(),
  retryAckToken: z.string().optional(),
  validation: z
    .object({
      issues: z.array(z.string()),
      suggestions: z.array(z.string()),
    })
    .optional(),
});

export const V2ContinueWorkflowOutputSchema = z.discriminatedUnion('kind', [
  V2ContinueWorkflowOkSchema,
  V2ContinueWorkflowBlockedSchema,
]).refine(
  (data) => (data.pending ? data.ackToken != null : true),
  { message: 'ackToken is required when a pending step exists' }
);

export const V2ResumeSessionOutputSchema = z.object({
  candidates: z.array(z.object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    stateToken: z.string().regex(/^st1[023456789acdefghjklmnpqrstuvwxyz]+$/, 'Invalid stateToken format'),
    snippet: z.string().max(1024),
    whyMatched: z.array(z.enum([
      'matched_head_sha',
      'matched_branch',
      'matched_notes',
      'matched_workflow_id',
      'recency_fallback',
    ])),
  })).max(5),
  totalEligible: z.number().int().min(0),
});

export const V2CheckpointWorkflowOutputSchema = z.object({
  checkpointNodeId: z.string().min(1),
  stateToken: z.string().regex(/^st1[023456789acdefghjklmnpqrstuvwxyz]+$/, 'Invalid stateToken format'),
  nextCall: V2NextCallSchema.describe(
    'Pre-built template for your next continue_workflow call. ' +
    'After checkpoint, use this to rehydrate and continue working on the current step.'
  ),
});

export const V2StartWorkflowOutputSchema = z.object({
  stateToken: z.string().regex(/^st1[023456789acdefghjklmnpqrstuvwxyz]+$/, 'Invalid stateToken format'),
  ackToken: z.string().regex(/^ack1[023456789acdefghjklmnpqrstuvwxyz]+$/, 'Invalid ackToken format').optional(),
  checkpointToken: checkpointTokenSchema,
  isComplete: z.boolean(),
  pending: V2PendingStepSchema.nullable(),
  preferences: V2PreferencesSchema,
  nextIntent: V2NextIntentSchema,
  nextCall: V2NextCallSchema,
}).refine(
  (data) => (data.pending ? data.ackToken != null : true),
  { message: 'ackToken is required when a pending step exists' }
);

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
