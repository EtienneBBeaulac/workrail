import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { ToolContext } from '../../src/mcp/types.js';
import { LocalDataDirV2 } from '../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../src/v2/infra/local/fs/index.js';
import { NodeHmacSha256V2 } from '../../src/v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../../src/v2/infra/local/base64url/index.js';
import { LocalKeyringV2 } from '../../src/v2/infra/local/keyring/index.js';
import { NodeRandomEntropyV2 } from '../../src/v2/infra/local/random-entropy/index.js';
import { NodeSha256V2 } from '../../src/v2/infra/local/sha256/index.js';
import { NodeCryptoV2 } from '../../src/v2/infra/local/crypto/index.js';
import { NodeTimeClockV2 } from '../../src/v2/infra/local/time-clock/index.js';
import { LocalSessionLockV2 } from '../../src/v2/infra/local/session-lock/index.js';
import { LocalSessionEventLogStoreV2 } from '../../src/v2/infra/local/session-store/index.js';
import { LocalSnapshotStoreV2 } from '../../src/v2/infra/local/snapshot-store/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../../src/v2/infra/local/pinned-workflow-store/index.js';
import { ExecutionSessionGateV2 } from '../../src/v2/usecases/execution-session-gate.js';
import { IdFactoryV2 } from '../../src/v2/infra/local/id-factory/index.js';
import { Base32AdapterV2 } from '../../src/v2/infra/local/base32/index.js';
import { Bech32mAdapterV2 } from '../../src/v2/infra/local/bech32m/index.js';
import { signTokenV1Binary, unsafeTokenCodecPorts } from '../../src/v2/durable-core/tokens/index.js';
import type { V2Dependencies } from '../../src/mcp/types.js';
import type { KeyringV1 } from '../../src/v2/ports/keyring.port.js';

/**
 * Create a temporary data directory for v2 tests.
 * Returns both the path and a cleanup function.
 */
export async function mkV2TestDataDir(prefix = 'workrail-v2-test-'): Promise<{
  root: string;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const cleanup = async () => {
    await fs.rm(root, { recursive: true, force: true });
  };
  return { root, cleanup };
}

/**
 * Run a test function with automatic env setup and cleanup.
 * Guarantees cleanup even if the test function throws.
 */
export async function withV2TestEnv<T>(
  fn: (env: { root: string; prevDataDir: string | undefined }) => Promise<T>
): Promise<T> {
  const { root, cleanup } = await mkV2TestDataDir();
  const prevDataDir = process.env.WORKRAIL_DATA_DIR;
  process.env.WORKRAIL_DATA_DIR = root;
  try {
    return await fn({ root, prevDataDir });
  } finally {
    process.env.WORKRAIL_DATA_DIR = prevDataDir;
    await cleanup();
  }
}

/**
 * Wrap an async operation with a timeout.
 * Throws if the operation exceeds the timeout.
 */
export async function withTestTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  operationName: string
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`${operationName} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });
  return Promise.race([operation, timeoutPromise]);
}

/**
 * Create a minimal dummy ToolContext for unit tests.
 */
export function dummyToolContext(): ToolContext {
  return {
    workflowService: null as any,
    featureFlags: null as any,
    sessionManager: null,
    httpServer: null,
    v2: null,
  };
}

/**
 * Create complete V2Dependencies with all adapters initialized.
 * Useful for integration-style unit tests that need real implementations.
 * 
 * @param dataDir - LocalDataDirV2 instance (pass process.env or explicit path)
 * @returns V2Dependencies with all ports/adapters ready
 */
export async function createV2Dependencies(dataDir: LocalDataDirV2): Promise<V2Dependencies> {
  const fsPort = new NodeFileSystemV2();
  const sha256 = new NodeSha256V2();
  const crypto = new NodeCryptoV2();
  const clock = new NodeTimeClockV2();
  const hmac = new NodeHmacSha256V2();
  const base64url = new NodeBase64UrlV2();
  const entropy = new NodeRandomEntropyV2();
  const idFactory = new IdFactoryV2(entropy);
  const base32 = new Base32AdapterV2();
  const bech32m = new Bech32mAdapterV2();
  
  const sessionStore = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256);
  const sessionLock = new LocalSessionLockV2(dataDir, fsPort, clock);
  const gate = new ExecutionSessionGateV2(sessionLock, sessionStore);
  const snapshotStore = new LocalSnapshotStoreV2(dataDir, fsPort, crypto);
  const pinnedStore = new LocalPinnedWorkflowStoreV2(dataDir, fsPort);
  
  const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);
  const keyring = await keyringPort.loadOrCreate().match(
    (v) => v,
    (e) => {
      throw new Error(`Failed to load/create keyring in test: ${e.code}`);
    }
  );
  
  // Create grouped token codec ports (prevents "forgot base32" bugs)
  const tokenCodecPorts = unsafeTokenCodecPorts({
    keyring,
    hmac,
    base64url,
    base32,
    bech32m,
  });
  
  return {
    gate,
    sessionStore,
    snapshotStore,
    pinnedStore,
    sha256,
    crypto,
    idFactory,
    tokenCodecPorts,
  };
}

/**
 * Sign a token with given payload using provided V2Dependencies.
 * Throws if signing fails (test helper convenience).
 * 
 * @param payload - Token payload (StateTokenPayloadV1, AckTokenPayloadV1, or CheckpointTokenPayloadV1)
 * @param v2 - V2Dependencies object with tokenCodecPorts
 * @returns Signed binary token string (st1... / ack1... / chk1...)
 */
export function signToken(payload: unknown, v2: V2Dependencies): string {
  const token = signTokenV1Binary(payload as any, v2.tokenCodecPorts);
  if (token.isErr()) {
    throw new Error(`Token signing failed in test helper: ${token.error.code}`);
  }
  return token.value;
}

/**
 * Create complete ToolContext with V2Dependencies for integration tests.
 * 
 * @param dataDir - Optional LocalDataDirV2 instance (defaults to process.env)
 * @returns ToolContext with v2 dependencies initialized
 */
export async function createV2ToolContext(dataDir?: LocalDataDirV2): Promise<ToolContext> {
  const dir = dataDir ?? new LocalDataDirV2(process.env);
  const v2 = await createV2Dependencies(dir);
  
  return {
    workflowService: null as any,
    featureFlags: null as any,
    sessionManager: null,
    httpServer: null,
    v2,
  };
}
