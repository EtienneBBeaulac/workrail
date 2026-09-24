import { z } from 'zod';
const ref = z.string().min(1).max(256);
const epoch = z.string().regex(/^[1-9][0-9]*$/);
/** Identifies an environment, not proof of uninterrupted daemon lifetime or I/O drainage. */
export const SupervisorBindingSchema = z.object({ daemon: ref, environment: ref }).strict().readonly();
const scoped = { supervisor: ref, epoch };
const bound = { ...scoped, binding: SupervisorBindingSchema };
export const SupervisorCreateIntendedSchema = z.object({
  kind: z.literal('supervisor_create_intended'), ...scoped,
  configurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const SupervisorCreatedSchema = z.object({ kind: z.literal('supervisor_created'), ...bound }).strict();
export const SupervisorStartIntendedSchema = z.object({ kind: z.literal('supervisor_start_intended'), ...bound }).strict();
export const SupervisorStartedSchema = z.object({ kind: z.literal('supervisor_started'), ...bound }).strict();
export const SupervisorStopIntendedSchema = z.object({ kind: z.literal('supervisor_stop_intended'), ...bound }).strict();
/** Process exit does not grant a lease release, rollback, export, or new execution. */
export const SupervisorProcessStoppedSchema = z.object({ kind: z.literal('supervisor_process_stopped'), ...bound }).strict();
export const SupervisorUnconfirmedSchema = z.object({ kind: z.literal('supervisor_unconfirmed'), ...scoped,
  operation: z.enum(['create', 'start', 'stop']), reason: z.enum(['ack_unknown', 'backend_refused']),
}).strict();
export type SupervisorBinding = z.infer<typeof SupervisorBindingSchema>;
export type SupervisorCreateIntent = Readonly<z.infer<typeof SupervisorCreateIntendedSchema>>;
export type SupervisorUnconfirmed = Readonly<z.infer<typeof SupervisorUnconfirmedSchema>>;
