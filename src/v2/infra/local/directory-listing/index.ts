import type { ResultAsync } from 'neverthrow';
import { okAsync, errAsync } from 'neverthrow';
import type { FsError, DirectoryListingOpsPortV2 } from '../../../ports/fs.port.js';
import type { DirectoryListingPortV2 } from '../../../ports/directory-listing.port.js';

/**
 * Local filesystem directory listing adapter.
 *
 * Delegates to DirectoryListingOpsPortV2 (minimal interface).
 * Returns entry names (not full paths). Returns empty array if directory does not exist.
 */
export class LocalDirectoryListingV2 implements DirectoryListingPortV2 {
  private readonly fs: DirectoryListingOpsPortV2;

  constructor(fs: DirectoryListingOpsPortV2) {
    this.fs = fs;
  }

  readdir(dirPath: string): ResultAsync<readonly string[], FsError> {
    return this.fs.readdir(dirPath).orElse((e) => {
      // Graceful: missing directory → empty list (not an error)
      if (e.code === 'FS_NOT_FOUND') {
        return okAsync([] as readonly string[]);
      }
      return errAsync(e);
    });
  }
}
