/**
 * In-memory fake for filesystem port.
 *
 * Implements filesystem operations in memory:
 * - mkdirp: in-memory directory tracking
 * - read/write operations on in-memory files
 * - Lock-like exclusive file creation
 * - No actual file I/O
 *
 * @enforces fs-mock-in-memory
 */

import { okAsync, errAsync, type ResultAsync } from 'neverthrow';
import type { FileSystemPortV2, FsError } from '../../../src/v2/ports/fs.port.js';

interface FileEntry {
  kind: 'file';
  bytes: Uint8Array;
}

interface DirectoryEntry {
  kind: 'dir';
}

type FileSystemEntry = FileEntry | DirectoryEntry;

/**
 * In-memory fake filesystem.
 *
 * Behavior:
 * - Maintains an in-memory tree structure
 * - read/write/delete operations on virtual files
 * - Directory creation is tracked
 * - File descriptors are synthetic (just integers)
 */
export class InMemoryFileSystem implements FileSystemPortV2 {
  private fs = new Map<string, FileSystemEntry>();
  private nextFd = 1;
  private openFiles = new Map<number, { path: string; mode: 'read' | 'write' | 'append' | 'exclusive'; data?: Uint8Array }>();

  private normalizePath(p: string): string {
    return p.replace(/\\/g, '/');
  }

  mkdirp(dirPath: string): ResultAsync<void, FsError> {
    const normalized = this.normalizePath(dirPath);
    const isAbs = normalized.startsWith('/');

    const parts = normalized.split('/').filter((p) => p.length > 0);
    let currentPath = '';

    for (const part of parts) {
      if (currentPath === '') {
        currentPath = isAbs ? `/${part}` : part;
      } else {
        currentPath = `${currentPath}/${part}`;
      }

      if (!this.fs.has(currentPath)) {
        this.fs.set(currentPath, { kind: 'dir' });
      } else {
        const entry = this.fs.get(currentPath);
        if (entry?.kind !== 'dir') {
          return errAsync({
            code: 'FS_IO_ERROR' as const,
            message: `Path exists and is not a directory: ${currentPath}`,
          });
        }
      }
    }

    return okAsync(void 0);
  }

  readFileUtf8(filePath: string): ResultAsync<string, FsError> {
    const p = this.normalizePath(filePath);
    const entry = this.fs.get(p);

    if (!entry) {
      return errAsync({ code: 'FS_NOT_FOUND' as const, message: `File not found: ${p}` });
    }

    if (entry.kind !== 'file') {
      return errAsync({
        code: 'FS_IO_ERROR' as const,
        message: `Path is not a file: ${p}`,
      });
    }

    try {
      const text = new TextDecoder().decode(entry.bytes);
      return okAsync(text);
    } catch (e) {
      return errAsync({
        code: 'FS_IO_ERROR' as const,
        message: `Failed to decode UTF-8: ${String(e)}`,
      });
    }
  }

  readFileBytes(filePath: string): ResultAsync<Uint8Array, FsError> {
    const p = this.normalizePath(filePath);
    const entry = this.fs.get(p);

    if (!entry) {
      return errAsync({ code: 'FS_NOT_FOUND' as const, message: `File not found: ${p}` });
    }

    if (entry.kind !== 'file') {
      return errAsync({
        code: 'FS_IO_ERROR' as const,
        message: `Path is not a file: ${p}`,
      });
    }

    return okAsync(new Uint8Array(entry.bytes));
  }

  writeFileBytes(filePath: string, bytes: Uint8Array): ResultAsync<void, FsError> {
    const p = this.normalizePath(filePath);

    // Ensure parent directory exists
    const lastSlash = p.lastIndexOf('/');
    if (lastSlash > 0) {
      const parentDir = p.substring(0, lastSlash);
      const parentEntry = this.fs.get(parentDir);
      if (!parentEntry || parentEntry.kind !== 'dir') {
        return errAsync({
          code: 'FS_IO_ERROR' as const,
          message: `Parent directory does not exist: ${parentDir}`,
        });
      }
    }

    this.fs.set(p, { kind: 'file', bytes: new Uint8Array(bytes) });
    return okAsync(void 0);
  }

  openWriteTruncate(filePath: string): ResultAsync<{ readonly fd: number }, FsError> {
    const p = this.normalizePath(filePath);
    const fd = this.nextFd++;
    this.openFiles.set(fd, { path: p, mode: 'write', data: new Uint8Array() });
    return okAsync({ fd });
  }

  openAppend(filePath: string): ResultAsync<{ readonly fd: number }, FsError> {
    const p = this.normalizePath(filePath);
    const fd = this.nextFd++;
    const existingData = this.fs.get(p);
    const initialData = existingData && existingData.kind === 'file' ? new Uint8Array(existingData.bytes) : new Uint8Array();

    this.openFiles.set(fd, { path: p, mode: 'append', data: initialData });
    return okAsync({ fd });
  }

  writeAll(fd: number, bytes: Uint8Array): ResultAsync<void, FsError> {
    const openFile = this.openFiles.get(fd);

    if (!openFile) {
      return errAsync({ code: 'FS_IO_ERROR' as const, message: `Invalid file descriptor: ${fd}` });
    }

    // Append or replace depending on mode
    if (openFile.mode === 'append') {
      const combined = new Uint8Array(openFile.data!.length + bytes.length);
      combined.set(openFile.data!, 0);
      combined.set(bytes, openFile.data!.length);
      openFile.data = combined;
    } else {
      openFile.data = new Uint8Array(bytes);
    }

    return okAsync(void 0);
  }

  openExclusive(filePath: string, bytes: Uint8Array): ResultAsync<{ readonly fd: number }, FsError> {
    const p = this.normalizePath(filePath);

    // Exclusive: fail if file already exists
    const entry = this.fs.get(p);
    if (entry) {
      return errAsync({
        code: 'FS_ALREADY_EXISTS' as const,
        message: `File already exists: ${p}`,
      });
    }

    const fd = this.nextFd++;
    const data = new Uint8Array(bytes);
    this.openFiles.set(fd, { path: p, mode: 'exclusive', data });

    return okAsync({ fd });
  }

  fsyncFile(_fd: number): ResultAsync<void, FsError> {
    // No-op for in-memory fake (always consistent)
    return okAsync(void 0);
  }

  fsyncDir(_dirPath: string): ResultAsync<void, FsError> {
    // No-op for in-memory fake
    return okAsync(void 0);
  }

  closeFile(fd: number): ResultAsync<void, FsError> {
    const openFile = this.openFiles.get(fd);

    if (!openFile) {
      return errAsync({ code: 'FS_IO_ERROR' as const, message: `Invalid file descriptor: ${fd}` });
    }

    // Flush data to filesystem on close
    this.fs.set(openFile.path, { kind: 'file', bytes: openFile.data! });
    this.openFiles.delete(fd);

    return okAsync(void 0);
  }

  rename(fromPath: string, toPath: string): ResultAsync<void, FsError> {
    const from = this.normalizePath(fromPath);
    const to = this.normalizePath(toPath);

    const entry = this.fs.get(from);

    if (!entry) {
      return errAsync({ code: 'FS_NOT_FOUND' as const, message: `Source not found: ${from}` });
    }

    this.fs.set(to, entry);
    this.fs.delete(from);

    return okAsync(void 0);
  }

  unlink(filePath: string): ResultAsync<void, FsError> {
    const p = this.normalizePath(filePath);
    const entry = this.fs.get(p);

    if (!entry) {
      return errAsync({ code: 'FS_NOT_FOUND' as const, message: `File not found: ${p}` });
    }

    this.fs.delete(p);
    return okAsync(void 0);
  }

  stat(filePath: string): ResultAsync<{ readonly sizeBytes: number }, FsError> {
    const p = this.normalizePath(filePath);
    const entry = this.fs.get(p);

    if (!entry) {
      return errAsync({ code: 'FS_NOT_FOUND' as const, message: `Path not found: ${p}` });
    }

    if (entry.kind === 'dir') {
      return okAsync({ sizeBytes: 0 });
    }

    return okAsync({ sizeBytes: entry.bytes.length });
  }

  readdir(dirPath: string): ResultAsync<readonly string[], FsError> {
    const p = this.normalizePath(dirPath);
    const entry = this.fs.get(p);

    if (!entry) {
      return errAsync({ code: 'FS_NOT_FOUND' as const, message: `Directory not found: ${p}` });
    }

    if (entry.kind !== 'dir') {
      return errAsync({
        code: 'FS_IO_ERROR' as const,
        message: `Path is not a directory: ${p}`,
      });
    }

    // Find all direct children of this directory
    const prefix = p === '/' ? '/' : `${p}/`;
    const entries: string[] = [];
    const allPaths = Array.from(this.fs.keys());

    for (const path of allPaths) {
      if (path === p) continue; // Skip the directory itself
      if (path.startsWith(prefix)) {
        // Extract the direct child name (first segment after prefix)
        const relativePath = path.substring(prefix.length);
        const slashIndex = relativePath.indexOf('/');
        const entryName = slashIndex === -1 ? relativePath : relativePath.substring(0, slashIndex);
        
        // Add only if not already in list (avoid duplicates from nested paths)
        if (entryName && !entries.includes(entryName)) {
          entries.push(entryName);
        }
      }
    }

    return okAsync(entries);
  }
}
