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
 * Returns sorted (deterministic ordering for resume ranking tie-breaking).
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
