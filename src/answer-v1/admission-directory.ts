import { mkdir, open, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { admissionFileName } from './immutable-admission-file.js';

export type AdmissionDirectoryFailure =
  | Readonly<{ kind: 'refused'; reason: 'invalid_input' | 'unsupported_platform' | 'invalid_directory' }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'cancelled' | 'storage_unavailable' }>;

/** Admission intent shares the journal's configured authority root. No separately
 * configurable store, mutable status index, expiration or automatic deletion exists.
 * Configuration ancestors are trusted; the reserved child must be a real directory.
 */
export async function prepareAdmissionDirectory(
  journalRoot: string, signal: AbortSignal,
): Promise<Readonly<{ kind: 'ready'; root: string }> | AdmissionDirectoryFailure> {
  if (!isAbsolute(journalRoot)) return { kind: 'refused', reason: 'invalid_input' };
  if (process.platform === 'win32') return { kind: 'refused', reason: 'unsupported_platform' };
  if (signal.aborted) return { kind: 'unconfirmed', reason: 'cancelled' };
  try {
    await mkdir(journalRoot, { recursive: true });
    const canonicalJournal = await realpath(journalRoot);
    const root = join(canonicalJournal, '.answer-admissions');
    await mkdir(root, { recursive: true });
    // Sync every ancestor, including on adoption: another creator could have died
    // before making its newly created directory chain durable. No mkdir return value
    // proves that an existing ancestor has already crossed that barrier.
    for (let current = root; ; current = dirname(current)) {
      if (signal.aborted) return { kind: 'unconfirmed', reason: 'cancelled' };
      const directory = await open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
      if (dirname(current) === current) break;
    }
    return signal.aborted ? { kind: 'unconfirmed', reason: 'cancelled' } : { kind: 'ready', root };
  } catch (error) {
    if (signal.aborted) return { kind: 'unconfirmed', reason: 'cancelled' };
    if (error instanceof Error && 'code' in error && ['ELOOP', 'ENOTDIR', 'EEXIST'].includes(String(error.code)))
      return { kind: 'refused', reason: 'invalid_directory' };
    return { kind: 'unconfirmed', reason: 'storage_unavailable' };
  }
}

/** Discovery is a deterministic inventory, never admission or owner acquisition.
 * Even candidate filenames must pass readAdmissionFile and reservation validation.
 * Temporary, foreign and future files remain untouched and are counted visibly.
 */
export async function discoverAdmissionOperations(
  journalRoot: string, signal: AbortSignal,
): Promise<Readonly<{ kind: 'discovered'; root: string; operationIds: readonly string[]; retainedOtherEntries: number }>
  | AdmissionDirectoryFailure> {
  const directory = await prepareAdmissionDirectory(journalRoot, signal);
  if (directory.kind !== 'ready') return directory;
  try {
    const entries = await readdir(directory.root);
    if (signal.aborted) return { kind: 'unconfirmed', reason: 'cancelled' };
    const operationIds = entries.flatMap(name => {
      const id = name.slice(0, -5);
      return admissionFileName(id) === name ? [id] : [];
    }).sort();
    return { kind: 'discovered', root: directory.root, operationIds, retainedOtherEntries: entries.length - operationIds.length };
  } catch {
    return { kind: 'unconfirmed', reason: signal.aborted ? 'cancelled' : 'storage_unavailable' };
  }
}
