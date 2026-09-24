import { open, link, unlink, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

/** Storage primitive only: callers must validate the winning reservation's schema,
 * request binding and content references before using it to append execution events.
 * The root is an existing, trusted canonical directory, durably created by its owner.
 */
export type AdmissionFileResult =
  | Readonly<{ kind: 'durable'; bytes: Uint8Array }>
  | Readonly<{ kind: 'refused'; reason: 'invalid_input' | 'unsupported_platform' | 'invalid_file' }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'cancelled' | 'storage_unavailable' }>;

export const MAX_ADMISSION_BYTES = 4 * 1024 * 1024;

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** UUID correlation is transport-owned, never a model-supplied filename. */
export function admissionFileName(operationId: string): string | undefined {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId)
    ? `${operationId}.json` : undefined;
}

/** Publish complete bytes without overwrite. Even an existing winner is synced by
 * this caller: its creator may have died between link publication and directory sync.
 * Cancellation is cooperative between filesystem calls; an unconfirmed result never
 * means no write occurred. Node does not provide cancellable link/fsync operations.
 * No session writes, directory creation, admission deletion or owner acquisition here.
 */
export async function publishAdmissionFile(
  root: string, operationId: string, candidate: Uint8Array, signal: AbortSignal,
): Promise<AdmissionFileResult> {
  const name = admissionFileName(operationId);
  if (!isAbsolute(root) || !name || candidate.length === 0 || candidate.length > MAX_ADMISSION_BYTES)
    return { kind: 'refused', reason: 'invalid_input' };
  // The existing filesystem adapter silently skips directory sync on Windows.
  // Do not claim this stronger primitive's contract there without a real barrier.
  if (process.platform === 'win32') return { kind: 'refused', reason: 'unsupported_platform' };
  if (signal.aborted) return { kind: 'unconfirmed', reason: 'cancelled' };
  const bytes = Buffer.from(candidate);
  const target = join(root, name);
  const temporary = join(root, `.${name}.${randomUUID()}.tmp`);
  let temporaryCreated = false;
  try {
    const writer = await open(temporary, 'wx', 0o600);
    temporaryCreated = true;
    try {
      await writer.writeFile(bytes);
      await writer.sync();
    } finally { await writer.close(); }
    if (signal.aborted) return { kind: 'unconfirmed', reason: 'cancelled' };
    try { await link(temporary, target); }
    catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }

    const retained = await readAdmissionFile(root, operationId, signal);
    // Publication succeeded or found a winner. Disappearance is uncertainty, not
    // permission to allocate another execution.
    return retained.kind === 'missing'
      ? { kind: 'unconfirmed', reason: 'storage_unavailable' } : retained;
  } catch (error) {
    if (hasCode(error, 'ELOOP')) return { kind: 'refused', reason: 'invalid_file' };
    return { kind: 'unconfirmed', reason: signal.aborted ? 'cancelled' : 'storage_unavailable' };
  } finally {
    // Only this invocation's temporary link is disposable. Never remove the winner.
    if (temporaryCreated) await unlink(temporary).catch(() => undefined);
  }
}

export type AdmissionReadResult = AdmissionFileResult | Readonly<{ kind: 'missing' }>;

/** Reads and synchronizes the retained winner without preparing or publishing bytes.
 * Missing is an observation only, never proof that a concurrent admission cannot exist.
 * Unknown filesystem failures remain unconfirmed and never authorize fresh enrollment.
 */
export async function readAdmissionFile(
  root: string, operationId: string, signal: AbortSignal,
): Promise<AdmissionReadResult> {
  const name = admissionFileName(operationId);
  if (!isAbsolute(root) || !name) return { kind: 'refused', reason: 'invalid_input' };
  if (process.platform === 'win32') return { kind: 'refused', reason: 'unsupported_platform' };
  if (signal.aborted) return { kind: 'unconfirmed', reason: 'cancelled' };
  const target = join(root, name);
  try {
    // Read from the same bounded descriptor we sync. Never follow a substituted symlink.
    let winner: FileHandle;
    try { winner = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if (signal.aborted) return { kind: 'unconfirmed', reason: 'cancelled' };
      if (hasCode(error, 'ENOENT')) return { kind: 'missing' };
      throw error;
    }
    try {
      const stat = await winner.stat();
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_ADMISSION_BYTES)
        return { kind: 'refused', reason: 'invalid_file' };
      const retained = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < retained.length) {
        const read = await winner.read(retained, offset, retained.length - offset, offset);
        if (read.bytesRead === 0) return { kind: 'refused', reason: 'invalid_file' };
        offset += read.bytesRead;
      }
      await winner.sync();
      const directory = await open(root, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
      if (signal.aborted) return { kind: 'unconfirmed', reason: 'cancelled' };
      return { kind: 'durable', bytes: retained };
    } finally { await winner.close(); }
  } catch (error) {
    if (signal.aborted) return { kind: 'unconfirmed', reason: 'cancelled' };
    if (hasCode(error, 'ELOOP')) return { kind: 'refused', reason: 'invalid_file' };
    return { kind: 'unconfirmed', reason: 'storage_unavailable' };
  }
}
