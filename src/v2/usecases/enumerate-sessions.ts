import type { ResultAsync } from 'neverthrow';
import { okAsync } from 'neverthrow';
import type { DirectoryListingPortV2 } from '../ports/directory-listing.port.js';
import type { DataDirPortV2 } from '../ports/data-dir.port.js';
import type { FsError } from '../ports/fs.port.js';
import { asSessionId, type SessionId } from '../durable-core/ids/index.js';

/**
 * Session ID format: starts with "sess_" followed by alphanumeric + underscore characters.
 * Rejects dotfiles, temp directories, and other non-session entries.
 */
const SESSION_DIR_PATTERN = /^sess_[a-zA-Z0-9_]+$/;

/**
 * Enumerate all session IDs from the durable session storage directory.
 *
 * Filters directory entries to valid session ID format only.
 * Returns sorted alphabetically (deterministic ordering for tests and tie-breaking).
 *
 * Why separate function: Reusable by resume + future Console features.
 * Why sorted: Determinism — same directory state always produces same order.
 */
export function enumerateSessions(ports: {
  readonly directoryListing: DirectoryListingPortV2;
  readonly dataDir: DataDirPortV2;
}): ResultAsync<readonly SessionId[], FsError> {
  return ports.directoryListing
    .readdir(ports.dataDir.sessionsDir())
    .map((entries) =>
      entries
        .filter((entry) => SESSION_DIR_PATTERN.test(entry))
        .sort()
        .map((entry) => asSessionId(entry))
    );
}

/**
 * Enumerate session IDs by most recent modification time (descending).
 *
 * Used by resume_session to ensure the scan cap naturally retains recent sessions.
 * With >50 sessions, alphabetical ordering causes random exclusion since session IDs
 * are uncorrelated with recency. Sorting by mtime ensures the most relevant sessions
 * are prioritized.
 *
 * Filters directory entries to valid session ID format only.
 * Sorts by mtime descending, with alphabetical tie-breaking for determinism.
 *
 * Graceful degradation: entries that fail stat are skipped (not an error).
 */
export function enumerateSessionsByRecency(ports: {
  readonly directoryListing: DirectoryListingPortV2;
  readonly dataDir: DataDirPortV2;
}): ResultAsync<readonly SessionId[], FsError> {
  return ports.directoryListing
    .readdirWithMtime(ports.dataDir.sessionsDir())
    .map((entries) =>
      entries
        .filter((entry) => SESSION_DIR_PATTERN.test(entry.name))
        .sort((a, b) => {
          // Sort by mtime descending (most recent first)
          if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
          // Tie-break alphabetically by name (deterministic)
          return a.name.localeCompare(b.name);
        })
        .map((entry) => asSessionId(entry.name))
    );
}
