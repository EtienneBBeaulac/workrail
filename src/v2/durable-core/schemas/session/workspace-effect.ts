import { z } from 'zod';

const ref = z.string().min(1).max(256);
const epoch = z.string().regex(/^[1-9][0-9]*$/);
/** Only trusted registered adapters choose the operation. No model-declared read-only flag. */
export const WorkspaceEffectIntentSchema = z.object({
  kind: z.literal('workspace_effect_intended'),
  effect: ref,
  delivery: ref,
  epoch,
  modelCall: ref,
  toolCallId: ref,
  position: z.number().int().nonnegative().safe(),
  operation: z.enum(['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'report_issue']),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/** A retained result is not proof of rollback or process quiescence. */
export const WorkspaceEffectCompletedSchema = z.object({
  kind: z.literal('workspace_effect_completed'),
  effect: ref,
  epoch,
  result: z.object({ content: z.string().max(65536), isError: z.boolean() }).strict().readonly(),
}).strict();

export const WorkspaceEffectUnconfirmedSchema = z.object({
  kind: z.literal('workspace_effect_unconfirmed'),
  effect: ref,
  epoch,
  reason: z.enum(['execution_failed', 'cancelled', 'completion_unacknowledged']),
}).strict();

export type WorkspaceEffectIntent = Readonly<z.infer<typeof WorkspaceEffectIntentSchema>>;
export type WorkspaceEffectCompletion = Readonly<z.infer<typeof WorkspaceEffectCompletedSchema>>;
export type WorkspaceEffectUnconfirmed = Readonly<z.infer<typeof WorkspaceEffectUnconfirmedSchema>>;
