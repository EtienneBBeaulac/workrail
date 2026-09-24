import { z } from 'zod';
import { createHash } from 'node:crypto';

export const ScratchPathSchema = z.string().min(1).max(512).refine(p => !p.startsWith('/') && !p.includes('\\') && !/[\x00-\x1f\x7f]/.test(p)
  && p.split('/').every(s => s !== '' && s !== '.' && s !== '..' && s !== '.git'));
/** Explicit supplied files, not an implicit filesystem crawl. The caller must describe its
 * selection to the operator; this API has no authority to read a checkout or follow links. */
const Snapshot = z.object({ kind: z.literal('explicit_files'), description: z.string().min(1).max(1024),
  files: z.array(z.object({ path: ScratchPathSchema, text: z.string().max(65536) }).strict().readonly()).max(128).readonly(),
}).strict().superRefine((s,ctx) => {
  const names = s.files.map(f=>f.path);
  if (new Set(names).size !== names.length || names.some(a=>names.some(b=>a!==b && b.startsWith(a+'/'))))
    ctx.addIssue({code:'custom',message:'Conflicting paths'});
  if (s.files.reduce((n,f)=>n+Buffer.byteLength(f.text),0)>262144)
    ctx.addIssue({code:'custom',message:'Snapshot byte budget exceeded'});
}).readonly();
export const ProfileSchema = z.object({
  kind: z.literal('linux_scratch'),
  image: z.string().regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/),
  platform: z.enum(['linux/arm64','linux/amd64']),
  snapshot: Snapshot,
}).strict().readonly();
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
