import * as fs from 'fs/promises';
import * as fsCb from 'fs';
import { constants as fsConstants } from 'fs';
import type { ResultAsync } from 'neverthrow';
import { ResultAsync as RA } from 'neverthrow';
import type { FileSystemPortV2, FsError } from '../../../ports/fs.port.js';

function nodeErrorCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  // Node errors typically expose a string `code` property; treat it as best-effort.
  const code = (e as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function mapFsError(e: unknown, filePath: string): FsError {
  // WHY: Node.js fs errors have an undocumented `code` property that varies by error type.
  // We cannot narrow the type statically since Node error types are not exposed in TypeScript.
  // This is a one-off escaping point used only for error classification in this adapter.
  const code = nodeErrorCode(e);

  if (code === 'ENOENT') return { code: 'FS_NOT_FOUND', message: `Not found: ${filePath}` };
  if (code === 'EEXIST') return { code: 'FS_ALREADY_EXISTS', message: `Already exists: ${filePath}` };
  if (code === 'EACCES' || code === 'EPERM') return { code: 'FS_PERMISSION_DENIED', message: `Permission denied: ${filePath}` };
  return { code: 'FS_IO_ERROR', message: `FS error at ${filePath}: ${e instanceof Error ? e.message : String(e)}` };
}

export class NodeFileSystemV2 implements FileSystemPortV2 {
  mkdirp(dirPath: string): ResultAsync<void, FsError> {
    return RA.fromPromise(fs.mkdir(dirPath, { recursive: true }).then(() => undefined), (e) => mapFsError(e, dirPath));
  }

  readFileUtf8(filePath: string): ResultAsync<string, FsError> {
    return RA.fromPromise(fs.readFile(filePath, 'utf8'), (e) => mapFsError(e, filePath));
  }

  readFileBytes(filePath: string): ResultAsync<Uint8Array, FsError> {
    return RA.fromPromise(fs.readFile(filePath), (e) => mapFsError(e, filePath)).map((b) => new Uint8Array(b));
  }

  writeFileBytes(filePath: string, bytes: Uint8Array): ResultAsync<void, FsError> {
    return RA.fromPromise(fs.writeFile(filePath, Buffer.from(bytes)), (e) => mapFsError(e, filePath));
  }

  openWriteTruncate(filePath: string): ResultAsync<{ readonly fd: number }, FsError> {
    return RA.fromPromise(
      new Promise<{ fd: number }>((resolve, reject) => {
        fsCb.open(filePath, fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY, 0o600, (err, fd) => {
          if (err) reject(err);
          else resolve({ fd });
        });
      }),
      (e) => mapFsError(e, filePath)
    );
  }

  openAppend(filePath: string): ResultAsync<{ readonly fd: number }, FsError> {
    return RA.fromPromise(
      new Promise<{ fd: number }>((resolve, reject) => {
        fsCb.open(filePath, fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY, 0o600, (err, fd) => {
          if (err) reject(err);
          else resolve({ fd });
        });
      }),
      (e) => mapFsError(e, filePath)
    );
  }

  writeAll(fd: number, bytes: Uint8Array): ResultAsync<void, FsError> {
    return RA.fromPromise(
      new Promise<void>((resolve, reject) => {
        fsCb.write(fd, Buffer.from(bytes), 0, bytes.length, null, (err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
      (e) => mapFsError(e, `fd:${fd}`)
    );
  }

  openExclusive(filePath: string, bytes: Uint8Array): ResultAsync<{ readonly fd: number }, FsError> {
    return RA.fromPromise(
      (async () => {
        // Use low-level open to guarantee exclusive create semantics.
        const fd = await new Promise<number>((resolve, reject) => {
          fsCb.open(filePath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600, (err, opened) => {
            if (err) reject(err);
            else resolve(opened);
          });
        });

        await new Promise<void>((resolve, reject) => {
          fsCb.write(fd, Buffer.from(bytes), 0, bytes.length, null, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        return { fd };
      })(),
      (e) => mapFsError(e, filePath)
    );
  }

  fsyncFile(fd: number): ResultAsync<void, FsError> {
    return RA.fromPromise(
      new Promise<void>((resolve, reject) => {
        fsCb.fsync(fd, (err) => (err ? reject(err) : resolve()));
      }),
      (e) => mapFsError(e, `fd:${fd}`)
    );
  }

  fsyncDir(dirPath: string): ResultAsync<void, FsError> {
    return RA.fromPromise(
      (async () => {
        // fsync a directory by opening it, then fsyncing the fd.
        // This may not be supported on all platforms; fail fast if unsupported.
        const dirHandle = await fs.open(dirPath, 'r');
        try {
          await new Promise<void>((resolve, reject) => {
            fsCb.fsync(dirHandle.fd, (err) => (err ? reject(err) : resolve()));
          });
        } finally {
          await dirHandle.close();
        }
      })(),
      (e) => {
        // WHY: Same rationale as mapFsError—Node.js errors have undocumented `code` property.
        const code = nodeErrorCode(e);
        if (code === 'EINVAL' || code === 'ENOTSUP') {
          return { code: 'FS_UNSUPPORTED', message: `Directory fsync unsupported for: ${dirPath}` };
        }
        return mapFsError(e, dirPath);
      }
    );
  }

  closeFile(fd: number): ResultAsync<void, FsError> {
    return RA.fromPromise(
      new Promise<void>((resolve, reject) => {
        fsCb.close(fd, (err) => (err ? reject(err) : resolve()));
      }),
      (e) => mapFsError(e, `fd:${fd}`)
    );
  }

  rename(fromPath: string, toPath: string): ResultAsync<void, FsError> {
    return RA.fromPromise(fs.rename(fromPath, toPath), (e) => mapFsError(e, `${fromPath} -> ${toPath}`));
  }

  unlink(filePath: string): ResultAsync<void, FsError> {
    return RA.fromPromise(fs.unlink(filePath).then(() => undefined), (e) => mapFsError(e, filePath));
  }

  stat(filePath: string): ResultAsync<{ readonly sizeBytes: number }, FsError> {
    return RA.fromPromise(fs.stat(filePath), (e) => mapFsError(e, filePath)).map((s) => ({ sizeBytes: s.size }));
  }
}
