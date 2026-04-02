import { z } from 'zod';
import { ExecutionStateSchema } from '../domain/execution/state.js';
import {
  STATE_TOKEN_PATTERN,
  CHECKPOINT_TOKEN_PATTERN,
  CONTINUE_TOKEN_PATTERN,
} from '../v2/durable-core/tokens/token-patterns.js';
import { MAX_RESUME_PREVIEW_BYTES } from '../v2/durable-core/constants.js';

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

export const StalenessSummarySchema = z.object({
  level: z.enum(['none', 'possible', 'likely']),
  reason: z.string().min(1),
  specVersionAtLastReview: z.number().int().positive().optional(),
});
export type StalenessSummary = z.infer<typeof StalenessSummarySchema>;

export const V2WorkflowListItemSchema = z.object({
  workflowId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().min(1),
  kind: z.literal('workflow'),
  workflowHash: z.string().nullable(),
  visibility: z.object({
    category: z.enum(['built_in', 'personal', 'legacy_project', 'rooted_sharing', 'external']),
    source: z.object({
      kind: z.enum(['bundled', 'user', 'project', 'custom', 'git', 'remote', 'plugin']),
      displayName: z.string().min(1),
    }),
    rootedSharing: z.object({
      kind: z.literal('remembered_root'),
      rootPath: z.string().min(1),
      groupLabel: z.string().min(1),
    }).optional(),
    migration: z.object({
      preferredSource: z.literal('rooted_sharing'),
      currentSource: z.literal('legacy_project'),
      reason: z.literal('legacy_project_precedence'),
      summary: z.string().min(1),
    }).optional(),
  }).optional(),
  staleness: StalenessSummarySchema.optional(),
});

export const V2WorkflowSourceCatalogEntrySchema = z.object({
  sourceKey: z.string().min(1).describe(
    'Stable identifier for this source. Format: "{kind}:{absolutePath}" for filesystem sources (e.g. "project:/path/to/workflows", "custom:/path/to/.workrail/workflows"), or "built_in" for bundled sources.'
  ),
  category: z.enum(['built_in', 'personal', 'legacy_project', 'rooted_sharing', 'external']),
  source: z.object({
    kind: z.enum(['bundled', 'user', 'project', 'custom', 'git', 'remote', 'plugin']),
    displayName: z.string().min(1),
  }),
  sourceMode: z.enum(['built_in', 'personal', 'legacy_project', 'rooted_sharing', 'live_directory']),
  effectiveWorkflowCount: z.number().int().min(0),
  totalWorkflowCount: z.number().int().min(0),
  shadowedWorkflowCount: z.number().int().min(0),
  rootedSharing: z.object({
    kind: z.literal('remembered_root'),
    rootPath: z.string().min(1),
    groupLabel: z.string().min(1),
  }).optional(),
  migration: z.object({
    preferredSource: z.literal('rooted_sharing'),
    currentSource: z.literal('legacy_project'),
    reason: z.literal('legacy_project_precedence'),
    summary: z.string().min(1),
  }).optional(),
});

export const V2WorkflowListOutputSchema = z.object({
  workflows: z.array(V2WorkflowListItemSchema),
  staleRoots: z.array(z.string()).optional().describe(
    'Remembered workspace roots that were inaccessible during workflow discovery. ' +
    'Workflows from these roots were not included in this response. ' +
    'These roots will be retried on the next call.'
  ),
  sources: z.array(V2WorkflowSourceCatalogEntrySchema).optional().describe(
    'Source catalog for this workspace. Only present when includeSources was true in the request. ' +
    'Shows where workflows come from with effective and shadowed counts per source.'
  ),
});

export const V2WorkflowInspectOutputSchema = z.object({
  workflowId: z.string().min(1),
  workflowHash: z.string().min(1),
  mode: z.enum(['metadata', 'preview']),
  compiled: JsonValueSchema,
  visibility: V2WorkflowListItemSchema.shape.visibility.optional(),
  staleRoots: z.array(z.string()).optional().describe(
    'Remembered workspace roots that were inaccessible during workflow discovery. ' +
    'Workflows from these roots were not included in this response. ' +
    'These roots will be retried on the next call.'
  ),
  references: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    source: z.string().min(1),
    purpose: z.string().min(1),
    authoritative: z.boolean(),
    resolveFrom: z.enum(['workspace', 'package']).optional(),
  })).optional(),
  staleness: StalenessSummarySchema.optional(),
});

// -----------------------------------------------------------------------------
// v2 execution tool outputs (Slice 3)
// -----------------------------------------------------------------------------

export const V2PendingStepSchema = z.object({
  stepId: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().min(1),
  agentRole: z.string().min(1).optional(),
});

export type V2PendingStep = z.infer<typeof V2PendingStepSchema>;

/**
 * Single construction point for pending step payloads.
 * Prevents field-list drift across the 5+ call sites that build pending steps.
 */
export function toPendingStep(meta: {
  readonly stepId: string;
  readonly title: string;
  readonly prompt: string;
  readonly agentRole?: string;
} | null): V2PendingStep | null {
  if (!meta) return null;
  return {
    stepId: meta.stepId,
    title: meta.title,
    prompt: meta.prompt,
    ...(meta.agentRole ? { agentRole: meta.agentRole } : {}),
  };
}

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
export const V2NextCallSchema = z.object({
  tool: z.literal('continue_workflow'),
  params: z.object({ continueToken: z.string().min(1) }),
}).nullable();

// Resume-specific nextCall: always non-null and carries a locked intent: 'rehydrate'
// since resumeTokens from resume_session have no advance authority.
export const V2ResumeNextCallSchema = z.object({
  tool: z.literal('continue_workflow'),
  params: z.object({
    continueToken: z.string().min(1),
    intent: z.literal('rehydrate'),
  }),
});

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
    kind: z.literal('assessment_dimension'),
    assessmentId: z.string().min(1),
    dimensionId: z.string().min(1).regex(DELIMITER_SAFE_ID_PATTERN, 'dimensionId must be delimiter-safe: [a-z0-9_-]+'),
  }),
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
    'ASSESSMENT_FOLLOWUP_REQUIRED',
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
        case 'assessment_dimension':
          ptrStable = `${p.assessmentId}|${p.dimensionId}`;
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

// Checkpoint token format: chk1<bech32m> or ck_<base64url-24>
const checkpointTokenSchema = z.string().regex(CHECKPOINT_TOKEN_PATTERN, 'Invalid checkpointToken format').optional();

// continueToken format: ct_<base64url-24> only (v2-only concept)
const continueTokenSchema = z.string().regex(CONTINUE_TOKEN_PATTERN, 'Invalid continueToken format').optional();

// Re-export domain type so consumers can import from one place.
// Defined in the domain layer to avoid a layering violation.
export type { BindingDriftWarning as V2BindingDriftWarning } from '../v2/durable-core/domain/binding-drift.js';

/**
 * Binding drift warning emitted when project bindings differ from what was
 * frozen into the session at start time. Informational only — execution continues.
 *
 * Schema mirrors BindingDriftWarning from the domain layer.
 */
export const V2BindingDriftWarningSchema = z.object({
  code: z.literal('BINDING_DRIFT'),
  slotId: z.string().min(1),
  pinnedValue: z.string().min(1),
  currentValue: z.string().min(1),
  // `message` is intentionally absent — derivable via formatDriftWarning().
  // Presentation is the formatter's responsibility, not the domain type's.
});

/**
 * Step-scoped execution facts recorded during the completed step.
 * Backward-looking: describes what happened during the step that just advanced.
 * Distinct from top-level fields, which are forward-looking (next pending step, tokens, intent).
 *
 * assessments: the assessment submitted and accepted for this step, if the step declared an
 * assessmentRef. Absent when no assessment was involved. Dimensions carry the normalized level
 * and optional rationale the agent recorded.
 */
export const V2StepContextSchema = z.object({
  assessments: z
    .object({
      assessmentId: z.string().min(1),
      dimensions: z.array(
        z.object({
          dimensionId: z.string().min(1),
          level: z.string().min(1),
          rationale: z.string().optional(),
        })
      ),
      /**
       * Non-empty when WorkRail normalized the agent's submitted levels (e.g. "HIGH" -> "high").
       * Each entry explains one normalization applied. Empty array means all levels matched exactly.
       * Agents can use this to correct their submissions in future steps.
       */
      normalizationNotes: z.array(z.string()).readonly(),
    })
    .optional(),
});

const V2ContinueWorkflowOkSchema = z.object({
  kind: z.literal('ok'),
  continueToken: continueTokenSchema,
  checkpointToken: checkpointTokenSchema,
  isComplete: z.boolean(),
  pending: V2PendingStepSchema.nullable(),
  preferences: V2PreferencesSchema,
  nextIntent: V2NextIntentSchema,
  nextCall: V2NextCallSchema,
  /**
   * Binding drift warnings: emitted when .workrail/bindings.json has changed
   * since this session was started. The session continues with the original
   * compiled values — start a new session to pick up new bindings.
   */
  warnings: z.array(V2BindingDriftWarningSchema).optional(),
  /**
   * Step-scoped execution facts for the step that just completed.
   * Present when the completed step recorded structured data (e.g. an accepted assessment).
   * Absent when no step-level facts were recorded.
   */
  stepContext: V2StepContextSchema.optional(),
});

const V2ContinueWorkflowBlockedSchema = z.object({
  kind: z.literal('blocked'),
  continueToken: continueTokenSchema,
  checkpointToken: checkpointTokenSchema,
  isComplete: z.boolean(),
  pending: V2PendingStepSchema.nullable(),
  preferences: V2PreferencesSchema,
  nextIntent: V2NextIntentSchema,
  nextCall: V2NextCallSchema,
  blockers: V2BlockerReportSchema,
  retryable: z.boolean().optional(),
  retryContinueToken: z.string().optional(),
  validation: z
    .object({
      issues: z.array(z.string()),
      suggestions: z.array(z.string()),
    })
    .optional(),
  assessmentFollowup: z
    .object({
      title: z.string().min(1),
      guidance: z.string().min(1),
    })
    .optional(),
});

export const V2ContinueWorkflowOutputSchema = z.discriminatedUnion('kind', [
  V2ContinueWorkflowOkSchema,
  V2ContinueWorkflowBlockedSchema,
]).refine(
  (data) => (data.pending ? data.continueToken != null : true),
  { message: 'continueToken is required when a pending step exists' }
);

export const V2ResumeSessionOutputSchema = z.object({
  candidates: z.array(z.object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    workflowId: z.string().min(1),
    sessionTitle: z.string().nullable().describe(
      'Human-readable task/session title derived from persisted workflow context or early recap text.'
    ),
    gitBranch: z.string().nullable().describe(
      'Git branch associated with the session, if available.'
    ),
    /**
     * The durable state token for this candidate session.
     * Note: unlike checkpoint_workflow (where resumeToken and nextCall.params.continueToken
     * are different token kinds), here resumeToken === nextCall.params.continueToken.
     * Both are the same st_ token — resumeToken is exposed for display/identity purposes;
     * nextCall is the action interface. Use nextCall, not resumeToken, to resume.
     */
    resumeToken: z.string().regex(STATE_TOKEN_PATTERN, 'Invalid resumeToken format'),
    snippet: z.string().max(MAX_RESUME_PREVIEW_BYTES),
    confidence: z.enum(['strong', 'medium', 'weak']).describe(
      'Coarse confidence band for how likely this candidate is the intended session.'
    ),
    matchExplanation: z.string().min(1).describe(
      'Short natural-language explanation of why this candidate ranked here.'
    ),
    pendingStepId: z.string().nullable().describe(
      'The current pending step ID (e.g. "phase-3-implement") if the workflow is in progress. ' +
      'Null if the workflow is complete or the step could not be determined.'
    ),
    isComplete: z.boolean().describe(
      'Whether the workflow run has completed. Completed sessions are deprioritized in ranking.'
    ),
    lastModifiedMs: z.number().nullable().describe(
      'Filesystem modification time (epoch ms) of the session. Null if unavailable.'
    ),
    whyMatched: z.array(z.enum([
      'matched_exact_id',    // Tier 0 — exact runId or sessionId match (strongest signal)
      'matched_notes',       // Tier 1 — query matched ALL session-text tokens
      'matched_notes_partial', // Tier 2 — query matched SOME session-text tokens
      'matched_workflow_id', // Tier 3 — workflow type matched the query
      'matched_head_sha',    // Tier 4 — exact git commit match
      'matched_branch',      // Tier 5 — same git branch
      'matched_repo_root',   // Supplemental — same repo/workspace
      'recency_fallback',    // Tier 6 — no signal; most recent sessions only. Verify snippet before resuming.
    ])).describe(
      'Match signals explaining why this candidate was ranked. ' +
      'matched_exact_id and matched_notes are strongest. ' +
      'matched_notes_partial/matched_workflow_id are moderate text signals. ' +
      'matched_repo_root/head_sha/branch are workspace-context signals. ' +
      'recency_fallback = no strong signal; inspect the snippet before resuming.'
    ),
    /**
     * Pre-built continuation template — pass directly to continue_workflow with intent: "rehydrate".
     * Follows the same nextCall pattern as start_workflow, continue_workflow, and checkpoint_workflow.
     * The resumeToken is valid as the continueToken for rehydration (no advance authority — read-only resume).
     */
    nextCall: V2ResumeNextCallSchema,
  })).max(5),
  /**
   * Total number of healthy sessions found before the top-5 cap was applied.
   * When equal to candidates.length: all found sessions are shown.
   * When greater than candidates.length: only the top-ranked subset is shown.
   */
  totalEligible: z.number().int().min(0),
});

export const V2CheckpointWorkflowOutputSchema = z.object({
  checkpointNodeId: z.string().min(1),
  /**
   * Durable cross-chat bookmark pointing at the original (pre-checkpoint) node.
   * To resume this exact position in a future chat: pass this as continueToken
   * with intent: "rehydrate" to continue_workflow.
   * Different from nextCall.params.continueToken (a ct_ token for advancing in the current chat).
   */
  resumeToken: z.string().regex(STATE_TOKEN_PATTERN, 'Invalid resumeToken format'),
  nextCall: V2NextCallSchema.describe(
    'Pre-built template for your next continue_workflow call. ' +
    'After checkpoint, use this to rehydrate and continue working on the current step.'
  ),
});

export const V2StartWorkflowOutputSchema = z.object({
  continueToken: continueTokenSchema,
  checkpointToken: checkpointTokenSchema,
  isComplete: z.boolean(),
  pending: V2PendingStepSchema.nullable(),
  preferences: V2PreferencesSchema,
  nextIntent: V2NextIntentSchema,
  nextCall: V2NextCallSchema,
  staleRoots: z.array(z.string()).optional().describe(
    'Remembered workspace roots that were inaccessible during workflow discovery. ' +
    'Workflows from these roots were not included in this response. ' +
    'These roots will be retried on the next call.'
  ),
}).refine(
  (data) => (data.pending ? data.continueToken != null : true),
  { message: 'continueToken is required when a pending step exists' }
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
