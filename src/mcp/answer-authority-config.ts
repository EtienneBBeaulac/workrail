import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { AnswerMcpCompositionOptions } from '../answer-v1/contracts/host-composition.js';

const absolutePath = z.string().min(1).max(4096).refine(isAbsolute).refine(path => !path.includes('\0'));
const AuthorityFile = z.object({
  formatVersion: z.literal(1),
  authority: z.object({
    storage: z.object({ journalRootDir: absolutePath, hostIndexRootDir: absolutePath }).strict(),
    keyringPath: absolutePath,
    workflowStoragePath: absolutePath,
  }).strict(),
}).strict();
export type AnswerAuthorityResolution =
  | Readonly<{ kind: 'configured'; options: AnswerMcpCompositionOptions }>
  | Readonly<{ kind: 'refused'; reason: 'missing_authority' | 'ambiguous_authority' | 'invalid_configuration' | 'unreadable_configuration' }>;
const maxBytes = 65536;

/** Transport bootstrap only. Explicit config chooses existing shared authority paths;
 * no cwd defaults, token copying, journal migration or fallback to the legacy profile. */
export async function resolveAnswerAuthority(explicit: AnswerMcpCompositionOptions | undefined,
  file: string | undefined): Promise<AnswerAuthorityResolution> {
  if (explicit && file !== undefined) return { kind: 'refused', reason: 'ambiguous_authority' };
  if (explicit) return { kind: 'configured', options: explicit };
  if (file === undefined) return { kind: 'refused', reason: 'missing_authority' };
  if (!absolutePath.safeParse(file).success) return { kind: 'refused', reason: 'invalid_configuration' };
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes) return { kind: 'refused', reason: 'invalid_configuration' };
      // Bound bytes even if the file grows after stat; read from this same open handle.
      const bytes = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const next = await handle.read(bytes, length, bytes.length - length, length);
        if (next.bytesRead === 0) break;
        length += next.bytesRead;
      }
      if (length > maxBytes) return { kind: 'refused', reason: 'invalid_configuration' };
      let input: unknown;
      try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))); }
      catch { return { kind: 'refused', reason: 'invalid_configuration' }; }
      const parsed = AuthorityFile.safeParse(input);
      return parsed.success ? { kind: 'configured', options: { answerAuthority: parsed.data.authority } }
        : { kind: 'refused', reason: 'invalid_configuration' };
    } finally { await handle.close(); }
  } catch { return { kind: 'refused', reason: 'unreadable_configuration' }; }
}
