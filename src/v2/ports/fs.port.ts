import type { ResultAsync } from 'neverthrow';

export type FsError =
  | { readonly code: 'FS_IO_ERROR'; readonly message: string }
  | { readonly code: 'FS_NOT_FOUND'; readonly message: string }
  | { readonly code: 'FS_ALREADY_EXISTS'; readonly message: string }
  | { readonly code: 'FS_PERMISSION_DENIED'; readonly message: string }
  | { readonly code: 'FS_UNSUPPORTED'; readonly message: string };

export interface FileSystemPortV2 {
  mkdirp(dirPath: string): ResultAsync<void, FsError>;

  readFileUtf8(filePath: string): ResultAsync<string, FsError>;
  readFileBytes(filePath: string): ResultAsync<Uint8Array, FsError>;

  /**
   * Write file bytes (no implicit fsync). Callers must explicitly fsync when required by locks.
   */
  writeFileBytes(filePath: string, bytes: Uint8Array): ResultAsync<void, FsError>;

  /**
   * Open a file for writing (create or truncate). Used for crash-safe write+fsync+rename flows.
   */
  openWriteTruncate(filePath: string): ResultAsync<{ readonly fd: number }, FsError>;

  /**
   * Open a file for appending (create if missing). Used for `manifest.jsonl` append-only writes.
   */
  openAppend(filePath: string): ResultAsync<{ readonly fd: number }, FsError>;

  writeAll(fd: number, bytes: Uint8Array): ResultAsync<void, FsError>;

  /**
   * Create file exclusively (fails if it already exists). Used for lock files.
   *
   * Return value is an opaque handle that can be passed to fsync/close.
   */
  openExclusive(filePath: string, bytes: Uint8Array): ResultAsync<{ readonly fd: number }, FsError>;

  fsyncFile(fd: number): ResultAsync<void, FsError>;
  fsyncDir(dirPath: string): ResultAsync<void, FsError>;
  closeFile(fd: number): ResultAsync<void, FsError>;

  rename(fromPath: string, toPath: string): ResultAsync<void, FsError>;

  unlink(filePath: string): ResultAsync<void, FsError>;

  stat(filePath: string): ResultAsync<{ readonly sizeBytes: number }, FsError>;

  /**
   * List directory entries (file and subdirectory names, not full paths).
   * Used for session enumeration and future Console features.
   */
  readdir(dirPath: string): ResultAsync<readonly string[], FsError>;
}
