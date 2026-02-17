import type { ResultAsync } from 'neverthrow';
import type { FsError } from './fs.port.js';

/**
 * Port: Directory listing (segregated from FileSystemPortV2).
 *
 * Why separate: Only session enumeration needs directory listing.
 * File I/O consumers (session store, snapshot store) don't need readdir.
 * Follows interface segregation — small, focused ports.
 *
 * Lock: §DI — inject external effects at boundaries.
 */
export interface DirectoryListingPortV2 {
  /**
   * List entries (files + subdirectories) in a directory.
   * Returns entry names only (not full paths).
   * Returns empty array if directory does not exist.
   */
  readdir(dirPath: string): ResultAsync<readonly string[], FsError>;
}
