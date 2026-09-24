import { CleanupResourceBoundSchema, CleanupStopIntendedSchema, CleanupStoppedSchema, CleanupRemoveIntendedSchema, CleanupRemovedSchema } from './cleanup-resource.js';
import { ReviewVerdictArtifactV1Schema } from '../artifacts/review-verdict.js';
import { SupervisorCreateIntendedSchema, SupervisorCreatedSchema, SupervisorStartIntendedSchema, SupervisorStartedSchema, SupervisorStopIntendedSchema, SupervisorProcessStoppedSchema, SupervisorUnconfirmedSchema } from './supervisor.js';
import { z } from 'zod';
import { WorkspaceEffectIntentSchema, WorkspaceEffectCompletedSchema, WorkspaceEffectUnconfirmedSchema } from './workspace-effect.js';
import { DaemonExecutionPolicySchema } from './daemon-policy.js';
const id = z.string().min(1);
const completeReviewFields = ReviewVerdictArtifactV1Schema.omit({ kind: true }).extend({ notes: z.string().min(1) }).strict();
const completeReviewJson = z.string().refine(raw => {
    try { return completeReviewFields.safeParse(JSON.parse(raw)).success; }
    catch { return false; }
}, 'Invalid prepared review');
/** Immutable admission input, retained with enrollment rather than mutable context. */
export const AnswerHostRequestSchema = z.object({
    workflowId: z.string().regex(/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)?$/),
    goal: z.string(),
    workspacePath: z.string().min(1),
    daemonPolicy: DaemonExecutionPolicySchema.optional(),
// For scratch profiles workspacePath identifies request provenance, never a mount or file-read grant.
}).strict().refine(request => !request.daemonPolicy || request.daemonPolicy.workspace.kind === 'linux_scratch'
    || request.workspacePath === request.daemonPolicy.workspace.workspacePath).readonly();
const epoch = z.string().regex(/^[1-9][0-9]*$/);
const raw = z.object({ providerResponseId: z.string().optional(), responseText: z.string(),
    calls: z.array(z.object({ id: z.string(), name: z.string(), argumentsJson: z.string() }).strict().readonly()).readonly() }).strict().readonly();
/** Host lifecycle records live in the same atomic event stream as engine transitions. */
export const AnswerHostRecordSchema = z.discriminatedUnion('kind', [
    CleanupResourceBoundSchema, CleanupStopIntendedSchema, CleanupStoppedSchema, CleanupRemoveIntendedSchema, CleanupRemovedSchema,
    SupervisorCreateIntendedSchema, SupervisorCreatedSchema, SupervisorStartIntendedSchema, SupervisorStartedSchema, SupervisorStopIntendedSchema, SupervisorProcessStoppedSchema, SupervisorUnconfirmedSchema,
    WorkspaceEffectIntentSchema, WorkspaceEffectCompletedSchema, WorkspaceEffectUnconfirmedSchema,
    z.object({ kind: z.literal('enrolled'), mode: z.enum(['host_bound','unbound']), recovery: id, initialNode: id,
        // Absent only in older journals; never invent a request from current workflow files.
        request: AnswerHostRequestSchema.optional(),
        // Strict older readers reject this capability before loading or acquiring ownership.
        requiredOutput: z.literal('wr.contracts.review_verdict').optional() }).strict(),
    z.object({ kind: z.literal('owner_acquired'), epoch }).strict(),
    z.object({ kind: z.literal('owner_released'), epoch }).strict(),
    z.object({ kind: z.literal('cleanup_claimed'), epoch, previousEpoch: epoch, supervisor: id }).strict(),
    z.object({ kind: z.literal('delivered'), delivery: id, node: id, reply: id, epoch }).strict(),
    z.object({ kind: z.literal('model_call_reserved'), delivery: id, call: id, epoch, ordinal: z.number().int().positive().safe() }).strict(),
    z.object({ kind: z.literal('captured'), delivery: id, response: id, payload: raw }).strict(),
    z.object({ kind: z.literal('prepared'), delivery: id, response: id, invocation: id, toolCallId: z.string(), notes: z.string() }).strict(),
    z.object({ kind: z.literal('rejected'), delivery: id, response: id, receipt: id, reason: z.string(), issues: z.array(z.object({ kind: z.literal('field'), field: z.enum(['notes', 'verdict', 'confidence', 'findings', 'summary']), reason: z.string() }).strict()).optional(), encoding: z.enum(['canonical_json', 'raw_utf8']), rawAnswer: z.string() }).strict(),
    z.object({ kind: z.literal('committed'), invocation: id, receipt: id, successorNode: id, notes: z.string() }).strict(),
    z.object({ kind: z.literal('review_partial'), delivery: id, response: id, receipt: id, node: id, rawAnswer: z.string() }).strict(),
    z.object({ kind: z.literal('review_correction'), delivery: id, response: id, receipt: id, node: id, rawAnswer: z.string() }).strict(),
    z.object({ kind: z.literal('review_prepared'), delivery: id, response: id, invocation: id, toolCallId: z.string(), node: id, reviewJson: completeReviewJson, rawAnswer: z.string() }).strict(),
    z.object({ kind: z.literal('review_committed'), invocation: id, receipt: id, successorNode: id, rawAnswer: z.string() }).strict(),
    z.object({ kind: z.literal('stopped'), reason: z.enum(['cancelled', 'gate_rejected', 'timeout', 'failed']), detail: z.string() }).strict(),
]);
export type AnswerHostRecord = z.infer<typeof AnswerHostRecordSchema>;
