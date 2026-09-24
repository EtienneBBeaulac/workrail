import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, link, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const Binding = z.object({ version: z.literal(1), token: z.string(), payload: z.string() }).strict();
export type BindAnswerInvocation = (session: string, invocation: string, token: string, payload: string) => Promise<
  | Readonly<{ kind: 'bound'; token: string }>
  | Readonly<{ kind: 'refused'; reason: 'conflicting_invocation' | 'storage_unavailable' }>
>;

/** Immutable bindings survive token-sidecar replacement and process interruption. */
export function createAnswerInvocationBinder(sessionsDir: string): BindAnswerInvocation {
  return async (session, invocation, token, payload) => {
    const directory = join(sessionsDir, 'answer-invocations');
    const key = createHash('sha256').update(JSON.stringify([session, invocation])).digest('hex');
    const target = join(directory, `${key}.json`);
    const temporary = join(directory, `${key}.${randomUUID()}.tmp`);
    try {
      await mkdir(directory, { recursive: true });
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ version: 1, token, payload }));
        await handle.sync();
      } finally { await handle.close(); }
      try { await link(temporary, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { kind: 'refused', reason: 'storage_unavailable' }; }
      const retained = Binding.safeParse(JSON.parse(await readFile(target, 'utf8')));
      if (!retained.success) return { kind: 'refused', reason: 'storage_unavailable' };
      if (retained.data.payload !== payload) return { kind: 'refused', reason: 'conflicting_invocation' };
      return { kind: 'bound', token: retained.data.token };
    } catch { return { kind: 'refused', reason: 'storage_unavailable' }; }
    finally { await unlink(temporary).catch(() => undefined); }
  };
}
