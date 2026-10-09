import { z } from 'zod';
import type { DomainEventV1 } from '../schemas/session/index.js';

export const ModelTierSchema = z.enum(['lightweight', 'mid', 'heavy']);
export type ModelTier = z.infer<typeof ModelTierSchema>;
const ClientNameSchema = z.string().min(1).max(256).regex(/^\S+$/);
export const ClientModelTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('model'), modelId: ClientNameSchema }).strict(),
  z.object({ kind: z.literal('executor'), name: ClientNameSchema }).strict(),
]);
export const ModelRoutingSchema = z.object({
  lightweight: ClientModelTargetSchema.optional(),
  mid: ClientModelTargetSchema.optional(),
  heavy: ClientModelTargetSchema.optional(),
}).strict();
export type ModelRouting = Readonly<z.infer<typeof ModelRoutingSchema>>;
export const RunModelConfigSchema = z.object({
  modelTier: ModelTierSchema.optional(),
  modelRouting: ModelRoutingSchema.optional(),
}).strict();
export type RunModelConfig = Readonly<z.infer<typeof RunModelConfigSchema>>;

export const ModelRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inherit') }).strict(),
  z.object({ kind: z.literal('tier'), tier: ModelTierSchema,
    source: z.enum(['session', 'step', 'workflow', 'delegation']) }).strict(),
]);
export type ModelRequest = Readonly<z.infer<typeof ModelRequestSchema>>;
const TierRequestSchema = ModelRequestSchema.options[1];
export const ModelSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inherit') }).strict(),
  z.object({ kind: z.literal('workflow_lookup'), workflowId: ClientNameSchema }).strict(),
  z.object({ kind: z.literal('resolved'), request: TierRequestSchema, target: ClientModelTargetSchema }).strict(),
  z.object({ kind: z.literal('unresolved'), request: TierRequestSchema, reason: z.literal('binding_missing') }).strict(),
]);
export type ModelSelection = Readonly<z.infer<typeof ModelSelectionSchema>>;

export function resolveModelRequest(config: RunModelConfig, stepTier?: ModelTier, workflowTier?: ModelTier): ModelRequest {
  if (config.modelTier) return { kind: 'tier', tier: config.modelTier, source: 'session' };
  if (stepTier) return { kind: 'tier', tier: stepTier, source: 'step' };
  if (workflowTier) return { kind: 'tier', tier: workflowTier, source: 'workflow' };
  return { kind: 'inherit' };
}

export function resolveModelSelection(request: ModelRequest, routing: ModelRouting = {}): ModelSelection {
  if (request.kind === 'inherit') return request;
  const target = routing[request.tier];
  return target ? { kind: 'resolved', request, target } : { kind: 'unresolved', request, reason: 'binding_missing' };
}

/** Run-start configuration is immutable: worker context cannot change launch policy. */
export function readRunModelConfig(events: readonly DomainEventV1[], runId: string): RunModelConfig {
  const started = events.find(event => event.kind === 'run_started' && event.scope?.runId === runId);
  return started?.kind === 'run_started' ? started.data.modelConfig ?? {} : {};
}

export function describeModelSelection(selection: ModelSelection): string {
  switch (selection.kind) {
    case 'workflow_lookup': return `Before spawning, call inspect_workflow for ${JSON.stringify(selection.workflowId)} and resolve its initialModelRequest against the supplied client routing map. If no tier is declared, inherit the client default. Pass modelRouting to the child session, but do not copy the parent modelTier override. Report an unsupported target before launching.`;
    case 'inherit': return 'Inherit the client execution configuration. WorkRail has not selected a concrete model.';
    case 'unresolved': return `Requested tier: ${selection.request.tier} (${selection.request.source}). No client binding was supplied. Resolve this tier against the client model catalog before launching; report an unsupported selection rather than silently substituting another model.`;
    case 'resolved': return `Requested tier: ${selection.request.tier} (${selection.request.source}). ` +
      (selection.target.kind === 'model'
        ? `Launch with the native model override ${JSON.stringify(selection.target.modelId)}.`
        : `Launch the configured executor ${JSON.stringify(selection.target.name)}.`) +
      ' Verify this target is available and allowed in the client. A resolved request is not evidence that the model ran. If unavailable, report it; do not silently substitute.';
  }
}
