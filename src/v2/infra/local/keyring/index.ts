import { randomBytes } from 'crypto';
import { z } from 'zod';
import type { ResultAsync } from 'neverthrow';
import { ResultAsync as RA, okAsync, errAsync } from 'neverthrow';
import type { DataDirPortV2 } from '../../../ports/data-dir.port.js';
import type { FileSystemPortV2, FsError } from '../../../ports/fs.port.js';
import type { KeyringError, KeyringPortV2, KeyringV1 } from '../../../ports/keyring.port.js';
import { toCanonicalBytes } from '../../../durable-core/canonical/jcs.js';
import type { JsonValue } from '../../../durable-core/canonical/json-types.js';

const KeyRecordSchema = z.object({
  alg: z.literal('hmac_sha256'),
  keyBase64Url: z.string().min(1),
});

const KeyringFileV1Schema = z.object({
  v: z.literal(1),
  current: KeyRecordSchema,
  previous: KeyRecordSchema.nullable(),
});

function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function decodeBase64Url(s: string): Uint8Array | null {
  try {
    return new Uint8Array(Buffer.from(s, 'base64url'));
  } catch {
    return null;
  }
}

function validateKeyMaterialOrThrow(keyBase64Url: string): void {
  const decoded = decodeBase64Url(keyBase64Url);
  if (!decoded) throw new Error('invalid_base64url');
  if (decoded.length !== 32) throw new Error('invalid_key_length');
}

function createFreshKeyRecord(): { readonly alg: 'hmac_sha256'; readonly keyBase64Url: string } {
  const bytes = randomBytes(32);
  return { alg: 'hmac_sha256', keyBase64Url: encodeBase64Url(bytes) };
}

export class LocalKeyringV2 implements KeyringPortV2 {
  constructor(
    private readonly dataDir: DataDirPortV2,
    private readonly fs: FileSystemPortV2
  ) {}

  loadOrCreate(): ResultAsync<KeyringV1, KeyringError> {
    const path = this.dataDir.keyringPath();
    return this.fs
      .readFileUtf8(path)
      .andThen((raw) => this.parseAndValidate(raw, path))
      .orElse((e) => {
        if (e.code === 'FS_NOT_FOUND') return this.createAndPersistFresh();
        return errAsync({ code: 'KEYRING_IO_ERROR', message: e.message } as const);
      });
  }

  rotate(): ResultAsync<KeyringV1, KeyringError> {
    return this.loadOrCreate().andThen((kr) => {
      const next: KeyringV1 = {
        v: 1,
        current: createFreshKeyRecord(),
        previous: kr.current,
      };
      return this.persist(next).map(() => next);
    });
  }

  private createAndPersistFresh(): ResultAsync<KeyringV1, KeyringError> {
    const fresh: KeyringV1 = { v: 1, current: createFreshKeyRecord(), previous: null };
    return this.persist(fresh).map(() => fresh);
  }

  private parseAndValidate(raw: string, filePath: string): ResultAsync<KeyringV1, KeyringError> {
    return RA.fromPromise(
      (async () => {
        const parsed = JSON.parse(raw);
        const validated = KeyringFileV1Schema.safeParse(parsed);
        if (!validated.success) throw new Error('invalid_shape');

        // Validate key material lengths deterministically.
        validateKeyMaterialOrThrow(validated.data.current.keyBase64Url);
        if (validated.data.previous) validateKeyMaterialOrThrow(validated.data.previous.keyBase64Url);

        return validated.data as KeyringV1;
      })(),
      () => ({ code: 'KEYRING_CORRUPTION_DETECTED', message: `Invalid keyring file: ${filePath}` } as const)
    );
  }

  private persist(keyring: KeyringV1): ResultAsync<void, KeyringError> {
    const dir = this.dataDir.keysDir();
    const filePath = this.dataDir.keyringPath();
    const tmpPath = `${filePath}.tmp`;

    const canonical = toCanonicalBytes(keyring as unknown as JsonValue).mapErr((e) => ({
      code: 'KEYRING_INVARIANT_VIOLATION',
      message: e.message,
    }) as const);
    if (canonical.isErr()) return errAsync(canonical.error);

    return this.fs
      .mkdirp(dir)
      .andThen(() => this.fs.openWriteTruncate(tmpPath))
      .andThen((h) =>
        this.fs
          .writeAll(h.fd, canonical.value)
          .andThen(() => this.fs.fsyncFile(h.fd))
          .andThen(() => this.fs.closeFile(h.fd))
      )
      .andThen(() => this.fs.rename(tmpPath, filePath))
      .andThen(() => this.fs.fsyncDir(dir))
      .mapErr((e: FsError) => ({ code: 'KEYRING_IO_ERROR', message: e.message } as const));
  }
}
