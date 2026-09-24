import { toCanonicalBytes } from '../../v2/durable-core/canonical/jcs.js';
import type { JsonValue } from '../../v2/durable-core/canonical/json-types.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, link, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const Binding = z.object({ version: z.literal(1), token: z.string(), payloadHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type BindAnswerInvocation = (session: string, invocation: string, token: string, payload: JsonValue) => Promise<
  | Readonly<{ kind: 'bound'; token: string }>
  | Readonly<{ kind: 'refused'; reason: 'conflicting_invocation' | 'storage_unavailable' }>
>;

export const answerInvocationDirectory = (sessionsDir: string, session: string): string =>
  join(sessionsDir, 'answer-invocations', createHash('sha256').update(session).digest('hex'));

/** Immutable bindings survive token-sidecar replacement and process interruption. */
export function createAnswerInvocationBinder(sessionsDir: string): BindAnswerInvocation {
  return async (session, invocation, token, payload) => {
    const directory = answerInvocationDirectory(sessionsDir, session);
    const key = createHash('sha256').update(JSON.stringify([session, invocation])).digest('hex');
    const target = join(directory, `${key}.json`);
    const temporary = join(directory, `${key}.${randomUUID()}.tmp`);
    try {
      const canonical = toCanonicalBytes(payload);
      if (canonical.isErr()) return { kind: 'refused', reason: 'conflicting_invocation' };
      const payloadHash = createHash('sha256').update(canonical.value).digest('hex');
      const load = async () => {
        const retained = Binding.safeParse(JSON.parse(await readFile(target, 'utf8')));
        if (!retained.success) return { kind: 'refused', reason: 'storage_unavailable' } as const;
        if (retained.data.payloadHash !== payloadHash) return { kind: 'refused', reason: 'conflicting_invocation' } as const;
        return { kind: 'bound', token: retained.data.token } as const;
      };
      // Existing immutable evidence remains readable when no further writes are possible.
      try { return await load(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'refused', reason: 'storage_unavailable' }; }
      await mkdir(directory, { recursive: true });
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ version: 1, token, payloadHash }));
        await handle.sync();
      } finally { await handle.close(); }
      try { await link(temporary, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { kind: 'refused', reason: 'storage_unavailable' }; }
      return await load();
    } catch { return { kind: 'refused', reason: 'storage_unavailable' }; }
    finally { await unlink(temporary).catch(() => undefined); }
  };
}
