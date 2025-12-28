import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { ToolContext } from '../../src/mcp/types.js';
import { LocalDataDirV2 } from '../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../src/v2/infra/local/fs/index.js';
import { NodeHmacSha256V2 } from '../../src/v2/infra/local/hmac-sha256/index.js';
import { LocalKeyringV2 } from '../../src/v2/infra/local/keyring/index.js';
import { encodeTokenPayloadV1, signTokenV1 } from '../../src/v2/durable-core/tokens/index.js';

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
  };
}

/**
 * Sign a token using the keyring in the current WORKRAIL_DATA_DIR.
 */
export async function mkSignedToken(args: {
  unsignedPrefix: 'st.v1.' | 'ack.v1.' | 'chk.v1.';
  payload: unknown;
}): Promise<string> {
  const dataDir = new LocalDataDirV2(process.env);
  const fsPort = new NodeFileSystemV2();
  const hmac = new NodeHmacSha256V2();
  const keyringPort = new LocalKeyringV2(dataDir, fsPort);
  const keyring = await keyringPort.loadOrCreate().match(
    (v) => v,
    (e) => {
      throw new Error(`Unexpected keyring error in test helper: ${e.code}`);
    }
  );

  const payloadBytes = encodeTokenPayloadV1(args.payload as any).match(
    (v) => v,
    (e) => {
      throw new Error(`Unexpected token payload encode error in test helper: ${e.code}`);
    }
  );

  const token = signTokenV1(args.unsignedPrefix, payloadBytes, keyring, hmac).match(
    (v) => v,
    (e) => {
      throw new Error(`Unexpected token sign error in test helper: ${e.code}`);
    }
  );
  return String(token);
}
