import { z } from 'zod';
import type { ResultAsync, Result } from 'neverthrow';
import { ResultAsync as RA, okAsync, errAsync, ok, err } from 'neverthrow';
import type { DataDirPortV2 } from '../../../ports/data-dir.port.js';
import type { FileSystemPortV2, FsError } from '../../../ports/fs.port.js';
import type { KeyringError, KeyringPortV2, KeyringV1 } from '../../../ports/keyring.port.js';
import type { Base64UrlPortV2 } from '../../../ports/base64url.port.js';
import type { RandomEntropyPortV2 } from '../../../ports/random-entropy.port.js';
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

function validateKeyMaterialWithPort(base64url: Base64UrlPortV2, keyBase64Url: string): Result<void, KeyringError> {
  const decoded = base64url.decodeBase64Url(keyBase64Url);
  if (decoded.isErr()) {
    return err({
      code: 'KEYRING_CORRUPTION_DETECTED',
      message: `Invalid base64url in key material: ${decoded.error.code}`,
    } as const);
  }
  if (decoded.value.length !== 32) {
    return err({
      code: 'KEYRING_CORRUPTION_DETECTED',
      message: `Key material must be exactly 32 bytes, got ${decoded.value.length}`,
    } as const);
  }
  return ok(undefined);
}

function createFreshKeyRecord(
  base64url: Base64UrlPortV2,
  entropy: RandomEntropyPortV2
): { readonly alg: 'hmac_sha256'; readonly keyBase64Url: string } {
  const bytes = entropy.generateBytes(32);
  return { alg: 'hmac_sha256', keyBase64Url: base64url.encodeBase64Url(bytes) };
}

export class LocalKeyringV2 implements KeyringPortV2 {
  constructor(
    private readonly dataDir: DataDirPortV2,
    private readonly fs: FileSystemPortV2,
    private readonly base64url: Base64UrlPortV2,
    private readonly entropy: RandomEntropyPortV2
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
        current: createFreshKeyRecord(this.base64url, this.entropy),
        previous: kr.current,
      };
      return this.persist(next).map(() => next);
    });
  }

  private createAndPersistFresh(): ResultAsync<KeyringV1, KeyringError> {
    const fresh: KeyringV1 = { v: 1, current: createFreshKeyRecord(this.base64url, this.entropy), previous: null };
    return this.persist(fresh).map(() => fresh);
  }

  private parseAndValidate(raw: string, filePath: string): ResultAsync<KeyringV1, KeyringError> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return errAsync({ code: 'KEYRING_CORRUPTION_DETECTED', message: `Invalid keyring file: ${filePath}` } as const);
    }

    const validated = KeyringFileV1Schema.safeParse(parsed);
    if (!validated.success) {
      return errAsync({ code: 'KEYRING_CORRUPTION_DETECTED', message: `Invalid keyring file: ${filePath}` } as const);
    }

    const currentValidation = validateKeyMaterialWithPort(this.base64url, validated.data.current.keyBase64Url);
    if (currentValidation.isErr()) return errAsync(currentValidation.error);

    if (validated.data.previous) {
      const prevValidation = validateKeyMaterialWithPort(this.base64url, validated.data.previous.keyBase64Url);
      if (prevValidation.isErr()) return errAsync(prevValidation.error);
    }

    return okAsync(validated.data as KeyringV1);
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
