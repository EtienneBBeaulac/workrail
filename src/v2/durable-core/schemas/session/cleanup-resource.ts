import { z } from 'zod';
const scope = {
  epoch: z.string().regex(/^[1-9][0-9]*$/),
  supervisor: z.string().min(1).max(256),
  daemon: z.string().min(1).max(256),
  container: z.string().regex(/^[a-f0-9]{64}$/),
};
/** Resource receipts never establish provider settlement or grant execution ownership. */
export const CleanupResourceBoundSchema = z.object({ kind: z.literal('cleanup_resource_bound'), ...scope }).strict();
export const CleanupStopIntendedSchema = z.object({ kind: z.literal('cleanup_stop_intended'), ...scope }).strict();
export const CleanupStoppedSchema = z.object({ kind: z.literal('cleanup_stopped'), ...scope }).strict();
export const CleanupRemoveIntendedSchema = z.object({ kind: z.literal('cleanup_remove_intended'), ...scope }).strict();
export const CleanupRemovedSchema = z.object({ kind: z.literal('cleanup_removed'), ...scope,
  evidence: z.enum(['remove_acknowledged', 'absent_after_remove_intent']),
}).strict();
export type CleanupResourceBinding = Readonly<z.infer<typeof CleanupResourceBoundSchema>>;
