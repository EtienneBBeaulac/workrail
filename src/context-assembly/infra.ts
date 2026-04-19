import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import { fromPromise } from 'neverthrow';
import type { ResultAsync } from 'neverthrow';
import { ok, err } from '../runtime/result.js';
import type { Result } from '../runtime/result.js';
import { LocalSessionSummaryProviderV2 } from '../v2/infra/local/session-summary-provider/index.js';
import { LocalDataDirV2 } from '../v2/infra/local/data-dir/index.js';
import { LocalDirectoryListingV2 } from '../v2/infra/local/directory-listing/index.js';
import { LocalSessionEventLogStoreV2 } from '../v2/infra/local/session-store/index.js';
import { NodeSha256V2 } from '../v2/infra/local/sha256/index.js';
import type { DirectoryListingOpsPortV2, FsError, FileSystemPortV2 } from '../v2/ports/fs.port.js';
import type { SessionNote } from './types.js';

// ---------------------------------------------------------------------------
// Minimal read-only FileSystemPortV2 adapter
//
// WHY: LocalSessionEventLogStoreV2 requires FileSystemPortV2 (the full composite
// port), but load() only calls readFileUtf8 (for manifest.jsonl) and readFileBytes
// (for segment files). All write/fd methods are unreachable during reads.
//
// The outer try/catch in createListRecentSessions() catches any unexpected throw,
// ensuring the partial-failure invariant is preserved even if a stub is ever reached.
// ---------------------------------------------------------------------------

const WRITE_NOT_SUPPORTED = 'context-assembly: write ops not supported in read-only session store';

function makeReadOnlyFsPort(): FileSystemPortV2 {
  return {
    // ---- Used by load() ----
    readFileUtf8(filePath: string): ResultAsync<string, FsError> {
      return fromPromise(
        fs.readFile(filePath, 'utf-8'),
        (e): FsError => {
          const nodeErr = e as NodeJS.ErrnoException;
          if (nodeErr.code === 'ENOENT') return { code: 'FS_NOT_FOUND', message: nodeErr.message ?? 'not found' };
          return { code: 'FS_IO_ERROR', message: nodeErr.message ?? String(e) };
        }
      );
    },
    readFileBytes(filePath: string): ResultAsync<Uint8Array, FsError> {
      return fromPromise(
        fs.readFile(filePath).then((buf) => new Uint8Array(buf)),
        (e): FsError => {
          const nodeErr = e as NodeJS.ErrnoException;
          if (nodeErr.code === 'ENOENT') return { code: 'FS_NOT_FOUND', message: nodeErr.message ?? 'not found' };
          return { code: 'FS_IO_ERROR', message: nodeErr.message ?? String(e) };
        }
      );
    },
    stat(_filePath: string): ResultAsync<{ readonly sizeBytes: number }, FsError> {
      throw new Error(WRITE_NOT_SUPPORTED);
    },
    // ---- Write/fd stubs -- unreachable during load() ----
    mkdirp(_dirPath: string): ResultAsync<void, FsError> { throw new Error(WRITE_NOT_SUPPORTED); },
    fsyncDir(_dirPath: string): ResultAsync<void, FsError> { throw new Error(WRITE_NOT_SUPPORTED); },
    openWriteTruncate(_filePath: string): ResultAsync<{ readonly fd: number }, FsError> { throw new Error(WRITE_NOT_SUPPORTED); },
    openAppend(_filePath: string): ResultAsync<{ readonly fd: number }, FsError> { throw new Error(WRITE_NOT_SUPPORTED); },
    openExclusive(_filePath: string, _bytes: Uint8Array): ResultAsync<{ readonly fd: number }, FsError> { throw new Error(WRITE_NOT_SUPPORTED); },
    writeAll(_fd: number, _bytes: Uint8Array): ResultAsync<void, FsError> { throw new Error(WRITE_NOT_SUPPORTED); },
    fsyncFile(_fd: number): ResultAsync<void, FsError> { throw new Error(WRITE_NOT_SUPPORTED); },
    closeFile(_fd: number): ResultAsync<void, FsError> { throw new Error(WRITE_NOT_SUPPORTED); },
    rename(_from: string, _to: string): ResultAsync<void, FsError> { throw new Error(WRITE_NOT_SUPPORTED); },
    unlink(_filePath: string): ResultAsync<void, FsError> { throw new Error(WRITE_NOT_SUPPORTED); },
    writeFileBytes(_filePath: string, _bytes: Uint8Array): ResultAsync<void, FsError> { throw new Error(WRITE_NOT_SUPPORTED); },
    readdir(_dirPath: string): ResultAsync<readonly string[], FsError> { throw new Error(WRITE_NOT_SUPPORTED); },
    readdirWithMtime(_dirPath: string): ResultAsync<readonly { readonly name: string; readonly mtimeMs: number }[], FsError> { throw new Error(WRITE_NOT_SUPPORTED); },
  };
}

/**
 * Minimal DirectoryListingOpsPortV2 adapter using fs.promises.
 *
 * Used by LocalDirectoryListingV2 for session enumeration (readdirWithMtime).
 * This is the only directory-listing port needed for loadHealthySummaries().
 */
function makeDirectoryListingOpsPort(): DirectoryListingOpsPortV2 {
  return {
    readdir(dirPath: string): ResultAsync<readonly string[], FsError> {
      return fromPromise(
        fs.readdir(dirPath),
        (e): FsError => {
          const nodeErr = e as NodeJS.ErrnoException;
          if (nodeErr.code === 'ENOENT') return { code: 'FS_NOT_FOUND', message: nodeErr.message ?? 'not found' };
          return { code: 'FS_IO_ERROR', message: nodeErr.message ?? String(e) };
        }
      );
    },
    readdirWithMtime(dirPath: string): ResultAsync<readonly { readonly name: string; readonly mtimeMs: number }[], FsError> {
      return fromPromise(
        (async () => {
          const entries = await fs.readdir(dirPath, { withFileTypes: true });
          const withMtimes = await Promise.all(
            entries.map(async (entry) => {
              try {
                const stat = await fs.stat(nodePath.join(dirPath, entry.name));
                return { name: entry.name, mtimeMs: stat.mtimeMs };
              } catch {
                // Graceful: entries that fail stat are skipped (same as LocalDirectoryListingV2 behavior)
                return null;
              }
            })
          );
          return withMtimes.filter((e): e is { name: string; mtimeMs: number } => e !== null);
        })(),
        (e): FsError => {
          const nodeErr = e as NodeJS.ErrnoException;
          if (nodeErr.code === 'ENOENT') return { code: 'FS_NOT_FOUND', message: nodeErr.message ?? 'not found' };
          return { code: 'FS_IO_ERROR', message: nodeErr.message ?? String(e) };
        }
      );
    },
  };
}

/**
 * Create the real `listRecentSessions` implementation for ContextAssemblerDeps.
 *
 * Constructs a LocalSessionSummaryProviderV2 with minimal local ports,
 * loads all healthy summaries, and maps to SessionNote[].
 *
 * WHY inline construction (not reuse of MCP provider instance): the coordinator
 * runs in a separate process. Constructing a fresh provider is safe -- it reads
 * only from disk.
 *
 * NOTE on workspace filtering: HealthySessionSummary has no typed workspacePath
 * field in v1. The adapter returns the N most recent sessions globally (newest-first).
 * The agent can judge relevance from sessionTitle and gitBranch fields.
 * Strict workspace filtering is a v2 improvement.
 */
export function createListRecentSessions(): (
  _workspacePath: string,
  limit: number,
) => Promise<Result<readonly SessionNote[], string>> {
  return async (_workspacePath: string, limit: number) => {
    try {
      const dataDir = new LocalDataDirV2(process.env as Record<string, string | undefined>);
      const directoryListingOps = makeDirectoryListingOpsPort();
      const directoryListing = new LocalDirectoryListingV2(directoryListingOps);
      const fsPort = makeReadOnlyFsPort();
      const sha256 = new NodeSha256V2();
      const sessionStore = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256);

      const provider = new LocalSessionSummaryProviderV2({
        directoryListing,
        dataDir,
        sessionStore,
        // snapshotStore omitted -- not needed for context assembly
      });

      const result = await provider.loadHealthySummaries();

      if (result.isErr()) {
        return err(`listRecentSessions: ${result.error.message}`);
      }

      const notes: SessionNote[] = result.value
        .slice()
        .sort((a, b) => (b.lastModifiedMs ?? 0) - (a.lastModifiedMs ?? 0))
        .slice(0, limit)
        .map((s) => ({
          sessionId: String(s.sessionId),
          recapSnippet: s.recapSnippet != null ? String(s.recapSnippet) : null,
          sessionTitle: s.sessionTitle,
          gitBranch: s.observations.gitBranch,
          lastModifiedMs: s.lastModifiedMs ?? 0,
        }));

      return ok(notes);
    } catch (e) {
      return err(`listRecentSessions error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}

