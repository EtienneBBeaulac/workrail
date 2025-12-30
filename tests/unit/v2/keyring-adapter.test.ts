import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { DataDirPortV2 } from '../../../src/v2/ports/data-dir.port.js';
import type { FileSystemPortV2 } from '../../../src/v2/ports/fs.port.js';
import { LocalKeyringV2 } from '../../../src/v2/infra/local/keyring/index.js';
import { LocalDataDirV2 } from '../../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../../src/v2/infra/local/fs/index.js';
import { NodeBase64UrlV2 } from '../../../src/v2/infra/local/base64url/index.js';
import { NodeRandomEntropyV2 } from '../../../src/v2/infra/local/random-entropy/index.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-keyring-test-'));
}

/**
 * Tests that keyring adapter returns ResultAsync for port methods.
 * Ensures no throws escape port boundaries (Rule N4).
 *
 * @enforces no-throws-across-boundaries
 * @enforces errors-as-data
 */
describe('v2 Keyring adapter (error handling)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkTempDataDir();
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('loadOrCreate returns ResultAsync with success on first run (creates fresh keyring)', async () => {
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: tempDir });
    const fsPort = new NodeFileSystemV2();
    const base64url = new NodeBase64UrlV2();
    const entropy = new NodeRandomEntropyV2();
    const keyring = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);

    // First call should create a fresh keyring
    const result = await keyring.loadOrCreate();

    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw new Error('Expected Ok result');

    const kr = result.value;
    expect(kr.v).toBe(1);
    expect(kr.current).toBeDefined();
    expect(kr.current.alg).toBe('hmac_sha256');
    expect(kr.current.keyBase64Url).toBeTruthy();
    expect(kr.previous).toBeNull();
  });

  it('loadOrCreate returns ResultAsync with success on second run (loads existing)', async () => {
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: tempDir });
    const fsPort = new NodeFileSystemV2();
    const base64url = new NodeBase64UrlV2();
    const entropy = new NodeRandomEntropyV2();
    const keyring = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);

    // First call: create
    const result1 = await keyring.loadOrCreate();
    expect(result1.isOk()).toBe(true);
    const kr1 = result1._unsafeUnwrap();

    // Second call: load
    const result2 = await keyring.loadOrCreate();
    expect(result2.isOk()).toBe(true);
    const kr2 = result2._unsafeUnwrap();

    // Should load the same key
    expect(kr2.current.keyBase64Url).toBe(kr1.current.keyBase64Url);
  });

  it('loadOrCreate returns Err (not throw) when keyring file is malformed JSON', async () => {
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: tempDir });
    const fsPort = new NodeFileSystemV2();

    // Pre-populate keyring file with malformed JSON
    const keyringDir = dataDir.keysDir();
    const keyringPath = dataDir.keyringPath();
    await fs.mkdir(keyringDir, { recursive: true });
    await fs.writeFile(keyringPath, '{invalid json');

    const base64url = new NodeBase64UrlV2();
    const entropy = new NodeRandomEntropyV2();
    const keyring = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);
    const result = await keyring.loadOrCreate();

    // Should return Err, not throw (most important part)
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error('Expected Err result');

    const err = result.error;
    // Error code depends on where the error is caught (JSON parse vs schema validation)
    expect(['KEYRING_CORRUPTION_DETECTED', 'KEYRING_IO_ERROR']).toContain(err.code);
  });

  it('loadOrCreate returns Err (not throw) when keyring file has invalid shape', async () => {
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: tempDir });
    const fsPort = new NodeFileSystemV2();

    // Pre-populate with valid JSON but wrong schema
    const keyringDir = dataDir.keysDir();
    const keyringPath = dataDir.keyringPath();
    await fs.mkdir(keyringDir, { recursive: true });
    await fs.writeFile(keyringPath, JSON.stringify({ v: 2, foo: 'bar' }));

    const base64url = new NodeBase64UrlV2();
    const entropy = new NodeRandomEntropyV2();
    const keyring = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);
    const result = await keyring.loadOrCreate();

    // Should return Err, not throw
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error('Expected Err result');

    const err = result.error;
    // Error code depends on where the error is caught (JSON parse vs schema validation)
    expect(['KEYRING_CORRUPTION_DETECTED', 'KEYRING_IO_ERROR']).toContain(err.code);
  });

  it('loadOrCreate returns Err (not throw) when current key is invalid base64url', async () => {
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: tempDir });
    const fsPort = new NodeFileSystemV2();

    // Pre-populate with valid schema but invalid base64url key
    const keyringDir = dataDir.keysDir();
    const keyringPath = dataDir.keyringPath();
    await fs.mkdir(keyringDir, { recursive: true });
    await fs.writeFile(
      keyringPath,
      JSON.stringify({
        v: 1,
        current: { alg: 'hmac_sha256', keyBase64Url: '!!!invalid!!!' },
        previous: null,
      })
    );

    const base64url = new NodeBase64UrlV2();
    const entropy = new NodeRandomEntropyV2();
    const keyring = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);
    const result = await keyring.loadOrCreate();

    // Most important: result is Err, not thrown
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error('Expected Err result');

    const err = result.error;
    // Error code is one of the corruption/validation codes, not a raw throw
    expect(['KEYRING_CORRUPTION_DETECTED', 'KEYRING_IO_ERROR']).toContain(err.code);
  });

  it('loadOrCreate returns Err (not throw) when current key has wrong length', async () => {
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: tempDir });
    const fsPort = new NodeFileSystemV2();

    // Pre-populate with valid schema but short key (only 16 bytes instead of 32)
    const keyringDir = dataDir.keysDir();
    const keyringPath = dataDir.keyringPath();
    await fs.mkdir(keyringDir, { recursive: true });
    await fs.writeFile(
      keyringPath,
      JSON.stringify({
        v: 1,
        current: { alg: 'hmac_sha256', keyBase64Url: Buffer.from(new Uint8Array(16)).toString('base64url') },
        previous: null,
      })
    );

    const base64url = new NodeBase64UrlV2();
    const entropy = new NodeRandomEntropyV2();
    const keyring = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);
    const result = await keyring.loadOrCreate();

    // Most important: result is Err, not thrown
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error('Expected Err result');

    const err = result.error;
    // Error code is one of the corruption/validation codes, not a raw throw
    expect(['KEYRING_CORRUPTION_DETECTED', 'KEYRING_IO_ERROR']).toContain(err.code);
  });

  it('loadOrCreate returns Err (not throw) when previous key has wrong length', async () => {
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: tempDir });
    const fsPort = new NodeFileSystemV2();

    // Pre-populate with valid current key but invalid previous key
    const keyringDir = dataDir.keysDir();
    const keyringPath = dataDir.keyringPath();
    await fs.mkdir(keyringDir, { recursive: true });
    await fs.writeFile(
      keyringPath,
      JSON.stringify({
        v: 1,
        current: { alg: 'hmac_sha256', keyBase64Url: Buffer.from(new Uint8Array(32)).toString('base64url') },
        previous: { alg: 'hmac_sha256', keyBase64Url: Buffer.from(new Uint8Array(16)).toString('base64url') },
      })
    );

    const base64url = new NodeBase64UrlV2();
    const entropy = new NodeRandomEntropyV2();
    const keyring = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);
    const result = await keyring.loadOrCreate();

    // Most important: result is Err, not thrown
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error('Expected Err result');

    const err = result.error;
    // Error code is one of the corruption/validation codes, not a raw throw
    expect(['KEYRING_CORRUPTION_DETECTED', 'KEYRING_IO_ERROR']).toContain(err.code);
  });

  it('rotate returns ResultAsync with success', async () => {
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: tempDir });
    const fsPort = new NodeFileSystemV2();
    const base64url = new NodeBase64UrlV2();
    const entropy = new NodeRandomEntropyV2();
    const keyring = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);

    // Load or create
    const loadResult = await keyring.loadOrCreate();
    expect(loadResult.isOk()).toBe(true);
    const kr1 = loadResult._unsafeUnwrap();

    // Rotate
    const rotateResult = await keyring.rotate();
    expect(rotateResult.isOk()).toBe(true);
    const kr2 = rotateResult._unsafeUnwrap();

    // Verify rotation happened
    expect(kr2.current.keyBase64Url).not.toBe(kr1.current.keyBase64Url);
    expect(kr2.previous?.keyBase64Url).toBe(kr1.current.keyBase64Url);
  });

  it('port method signatures match ResultAsync return type', async () => {
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: tempDir });
    const fsPort = new NodeFileSystemV2();
    const base64url = new NodeBase64UrlV2();
    const entropy = new NodeRandomEntropyV2();
    const keyring = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);

    // Type check: these should compile and return ResultAsync
    const loadOrCreateResult = keyring.loadOrCreate();
    const rotateResult = keyring.rotate();

    // Both should be awaitable (ResultAsync is thenable)
    const result1 = await loadOrCreateResult;
    const result2 = await rotateResult;

    // After awaiting, both should be Result with isOk/isErr methods
    expect(typeof result1.isOk).toBe('function');
    expect(typeof result1.isErr).toBe('function');
    expect(typeof result2.isOk).toBe('function');
    expect(typeof result2.isErr).toBe('function');
  });
});
