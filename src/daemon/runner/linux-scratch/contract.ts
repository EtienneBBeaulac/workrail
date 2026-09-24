import { z } from 'zod';
import { createHash } from 'node:crypto';

import { LinuxScratchProfileSchema as ProfileSchema, ScratchPathSchema } from '../../../v2/durable-core/schemas/session/linux-scratch-profile.js';
export { ProfileSchema, ScratchPathSchema };

export type LinuxScratchProfile = z.infer<typeof ProfileSchema>;
export function decodeLinuxScratchProfile(raw: unknown) {
  const parsed=ProfileSchema.safeParse(raw);
  if(!parsed.success)return {kind:'refused' as const,reason:'invalid_profile' as const};
  // Copy before digesting: caller mutations cannot change what will be provisioned.
  const profile=parsed.data;
  profile.snapshot.files.forEach(Object.freeze); Object.freeze(profile.snapshot.files); Object.freeze(profile.snapshot);
  return {kind:'validated' as const,profile,digest:createHash('sha256').update(JSON.stringify(profile)).digest('hex')};
}
export const CommandSchema=z.discriminatedUnion('name',[
  z.object({name:z.literal('Read'),input:z.object({path:ScratchPathSchema}).strict()}).strict(),
  z.object({name:z.literal('Write'),input:z.object({path:ScratchPathSchema,content:z.string().max(65536)}).strict()}).strict(),
  z.object({name:z.literal('Edit'),input:z.object({path:ScratchPathSchema,old_string:z.string().min(1).max(65536),new_string:z.string().max(65536)}).strict()}).strict(),
  z.object({name:z.literal('Bash'),input:z.object({command:z.string().min(1).max(16384)}).strict()}).strict(),
  z.object({name:z.literal('Glob'),input:z.object({pattern:z.string().min(1).max(512)}).strict()}).strict(),
  z.object({name:z.literal('Grep'),input:z.object({pattern:z.string().max(512)}).strict()}).strict(),
]);
export type ScratchCommand=z.infer<typeof CommandSchema>;
export type ScratchOutcome=
  | Readonly<{kind:'completed';text:string;isError:boolean}>
  | Readonly<{kind:'unknown'}>
  | Readonly<{kind:'refused';reason:'invalid_command'|'closed'|'deadline_stopped'|'stale_owner'}>;
