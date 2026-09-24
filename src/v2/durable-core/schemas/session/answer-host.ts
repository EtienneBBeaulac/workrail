import { SupervisorCreateIntendedSchema, SupervisorCreatedSchema, SupervisorStartIntendedSchema, SupervisorStartedSchema, SupervisorStopIntendedSchema, SupervisorProcessStoppedSchema, SupervisorUnconfirmedSchema } from './supervisor.js';
import { z } from 'zod';
import { WorkspaceEffectIntentSchema, WorkspaceEffectCompletedSchema, WorkspaceEffectUnconfirmedSchema } from './workspace-effect.js';
import { DaemonExecutionPolicySchema } from './daemon-policy.js';
const id = z.string().min(1);
/** Immutable admission input, retained with enrollment rather than mutable context. */
export const AnswerHostRequestSchema = z.object({
    workflowId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
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
    SupervisorCreateIntendedSchema, SupervisorCreatedSchema, SupervisorStartIntendedSchema, SupervisorStartedSchema, SupervisorStopIntendedSchema, SupervisorProcessStoppedSchema, SupervisorUnconfirmedSchema,
    WorkspaceEffectIntentSchema, WorkspaceEffectCompletedSchema, WorkspaceEffectUnconfirmedSchema,
    z.object({ kind: z.literal('enrolled'), mode: z.enum(['host_bound','unbound']), recovery: id, initialNode: id,
        // Absent only in older journals; never invent a request from current workflow files.
        request: AnswerHostRequestSchema.optional() }).strict(),
    z.object({ kind: z.literal('owner_acquired'), epoch }).strict(),
    z.object({ kind: z.literal('owner_released'), epoch }).strict(),
    z.object({ kind: z.literal('delivered'), delivery: id, node: id, reply: id, epoch }).strict(),
    z.object({ kind: z.literal('model_call_reserved'), delivery: id, call: id, epoch, ordinal: z.number().int().positive().safe() }).strict(),
    z.object({ kind: z.literal('captured'), delivery: id, response: id, payload: raw }).strict(),
    z.object({ kind: z.literal('prepared'), delivery: id, response: id, invocation: id, toolCallId: z.string(), notes: z.string() }).strict(),
    z.object({ kind: z.literal('rejected'), delivery: id, response: id, receipt: id, reason: z.string(), encoding: z.enum(['canonical_json', 'raw_utf8']), rawAnswer: z.string() }).strict(),
    z.object({ kind: z.literal('committed'), invocation: id, receipt: id, successorNode: id, notes: z.string() }).strict(),
    z.object({ kind: z.literal('stopped'), reason: z.enum(['cancelled', 'gate_rejected', 'timeout', 'failed']), detail: z.string() }).strict(),
]);
export type AnswerHostRecord = z.infer<typeof AnswerHostRecordSchema>;
