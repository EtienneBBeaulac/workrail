import { z } from 'zod';

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
  if (s.files.reduce((n,f)=>n+new TextEncoder().encode(f.text).length,0)>262144)
    ctx.addIssue({code:'custom',message:'Snapshot byte budget exceeded'});
}).readonly();
export const LinuxScratchProfileSchema = z.object({
  kind: z.literal('linux_scratch'),
  image: z.string().regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/),
  platform: z.enum(['linux/arm64','linux/amd64']),
  snapshot: Snapshot,
}).strict().readonly();
