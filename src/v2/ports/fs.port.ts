import type { ResultAsync } from 'neverthrow';

export type FsError =
  | { readonly code: 'FS_IO_ERROR'; readonly message: string }
  | { readonly code: 'FS_NOT_FOUND'; readonly message: string }
  | { readonly code: 'FS_ALREADY_EXISTS'; readonly message: string }
  | { readonly code: 'FS_PERMISSION_DENIED'; readonly message: string }
  | { readonly code: 'FS_UNSUPPORTED'; readonly message: string };

/**
 * Port: Directory operations (creation and syncing).
 * Used by: session-store, snapshot-store, session-lock.
 */
export interface DirectoryOpsPortV2 {
  mkdirp(dirPath: string): ResultAsync<void, FsError>;
  fsyncDir(dirPath: string): ResultAsync<void, FsError>;
}

/**
 * Port: File reading and metadata.
 * Used by: session-store, snapshot-store.
 */
export interface FileReadPortV2 {
  readFileUtf8(filePath: string): ResultAsync<string, FsError>;
  readFileBytes(filePath: string): ResultAsync<Uint8Array, FsError>;
  stat(filePath: string): ResultAsync<{ readonly sizeBytes: number }, FsError>;
}

/**
 * Port: File descriptor operations for crash-safe writes.
 * Used by: session-store, snapshot-store, session-lock.
 */
export interface FileDescriptorPortV2 {
  /**
   * Open a file for writing (create or truncate). Used for crash-safe write+fsync+rename flows.
   */
  openWriteTruncate(filePath: string): ResultAsync<{ readonly fd: number }, FsError>;

  /**
   * Open a file for appending (create if missing). Used for `manifest.jsonl` append-only writes.
   */
  openAppend(filePath: string): ResultAsync<{ readonly fd: number }, FsError>;

  /**
   * Create file exclusively (fails if it already exists). Used for lock files.
   *
   * Return value is an opaque handle that can be passed to fsync/close.
   */
  openExclusive(filePath: string, bytes: Uint8Array): ResultAsync<{ readonly fd: number }, FsError>;

  writeAll(fd: number, bytes: Uint8Array): ResultAsync<void, FsError>;
  fsyncFile(fd: number): ResultAsync<void, FsError>;
  closeFile(fd: number): ResultAsync<void, FsError>;
}

/**
 * Port: File manipulation (rename, delete, write).
 * Used by: session-store, snapshot-store, session-lock.
 */
export interface FileManipulationPortV2 {
  rename(fromPath: string, toPath: string): ResultAsync<void, FsError>;
  unlink(filePath: string): ResultAsync<void, FsError>;

  /**
   * Write file bytes (no implicit fsync). Callers must explicitly fsync when required by locks.
   */
  writeFileBytes(filePath: string, bytes: Uint8Array): ResultAsync<void, FsError>;
}

/**
 * Port: Directory listing.
 * Used by: directory-listing adapter (for session enumeration).
 */
export interface DirectoryListingOpsPortV2 {
  /**
   * List directory entries (file and subdirectory names, not full paths).
   * Used for session enumeration and future Console features.
   */
  readdir(dirPath: string): ResultAsync<readonly string[], FsError>;
}

/**
 * Composite port for crash-safe file operations.
 * Most consumers (session-store, snapshot-store, session-lock) need this full set.
 */
export interface CrashSafeFileOpsPortV2 
  extends DirectoryOpsPortV2, 
          FileReadPortV2, 
          FileDescriptorPortV2, 
          FileManipulationPortV2,
          DirectoryListingOpsPortV2 {}

/**
 * Backward compatibility alias.
 * All existing consumers use this; they now get the composite interface.
 */
export type FileSystemPortV2 = CrashSafeFileOpsPortV2;
