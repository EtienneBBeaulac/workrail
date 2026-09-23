import { dirname } from 'node:path';
import { LocalDataDirV2 } from '../v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../v2/infra/local/fs/index.js';
import { NodeHmacSha256V2 } from '../v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../v2/infra/local/base64url/index.js';
import { LocalKeyringV2 } from '../v2/infra/local/keyring/index.js';
import { NodeRandomEntropyV2 } from '../v2/infra/local/random-entropy/index.js';
import { NodeSha256V2 } from '../v2/infra/local/sha256/index.js';
import { NodeCryptoV2 } from '../v2/infra/local/crypto/index.js';
import { NodeTimeClockV2 } from '../v2/infra/local/time-clock/index.js';
import { LocalSessionLockV2 } from '../v2/infra/local/session-lock/index.js';
import { LocalSessionEventLogStoreV2 } from '../v2/infra/local/session-store/index.js';
import { LocalSnapshotStoreV2 } from '../v2/infra/local/snapshot-store/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../v2/infra/local/pinned-workflow-store/index.js';
import { LocalTokenAliasStoreV2 } from '../v2/infra/local/token-alias-store/index.js';
import { ExecutionSessionGateV2 } from '../v2/usecases/execution-session-gate.js';
import { IdFactoryV2 } from '../v2/infra/local/id-factory/index.js';
import { Base32AdapterV2 } from '../v2/infra/local/base32/index.js';
import { Bech32mAdapterV2 } from '../v2/infra/local/bech32m/index.js';
import { unsafeTokenCodecPorts } from '../v2/durable-core/tokens/index.js';
import { validateWorkflowSchema } from '../application/validation.js';
import { normalizeV1WorkflowToPinnedSnapshot } from '../v2/read-only/v1-to-v2-shim.js';
import { WorkflowCompiler } from '../application/services/workflow-compiler.js';
import { ValidationEngine } from '../application/services/validation-engine.js';
import { EnhancedLoopValidator } from '../application/services/enhanced-loop-validator.js';
import { NullGitSnapshotV2 } from '../v2/ports/git-snapshot.port.js';
import type { SharedAuthorityConfig } from './contracts/host-composition.js';

export function answerDataDir(config: SharedAuthorityConfig): import('../v2/ports/data-dir.port.js').DataDirPortV2 {
  class DataDir extends LocalDataDirV2 {
    override sessionsDir() { return config.storage.journalRootDir; }
    override keyringPath() { return config.keyringPath; }
  }
  const dataDir: import('../v2/ports/data-dir.port.js').DataDirPortV2 = new DataDir({ WORKRAIL_DATA_DIR: dirname(config.storage.journalRootDir), WORKRAIL_KEYS_DIR: dirname(config.keyringPath) });
  return dataDir;
}

/** Explicit roots prevent this composition from falling back to the user's live data. */
export async function composeAnswerEngine(config: SharedAuthorityConfig) {
  const dataDir = answerDataDir(config);
  const fs = new NodeFileSystemV2();
  const sha256 = new NodeSha256V2();
  const crypto = new NodeCryptoV2();
  const entropy = new NodeRandomEntropyV2();
  const base64url = new NodeBase64UrlV2();
  const keyring = await new LocalKeyringV2(dataDir, fs, base64url, entropy).loadOrCreate();
  if (keyring.isErr()) return { kind: 'unavailable' as const, detail: keyring.error.message };
  const tokenAliasStore = new LocalTokenAliasStoreV2(dataDir, fs);
  const aliases = await tokenAliasStore.loadIndex();
  if (aliases.isErr()) return { kind: 'unavailable' as const, detail: 'Cannot load engine token aliases' };
  const sessionStore = new LocalSessionEventLogStoreV2(dataDir, fs, sha256);
  const gate = new ExecutionSessionGateV2(new LocalSessionLockV2(dataDir, fs, new NodeTimeClockV2()), sessionStore);
  const validator = new ValidationEngine(new EnhancedLoopValidator());
  return { kind: 'ready' as const, dataDir, sessionStore, gate, sha256, crypto, entropy,
    snapshotStore: new LocalSnapshotStoreV2(dataDir, fs, crypto),
    pinnedStore: new LocalPinnedWorkflowStoreV2(dataDir, fs),
    idFactory: new IdFactoryV2(entropy),
    tokenCodecPorts: unsafeTokenCodecPorts({ keyring: keyring.value, hmac: new NodeHmacSha256V2(), base64url, base32: new Base32AdapterV2(), bech32m: new Bech32mAdapterV2() }),
    tokenAliasStore, gitSnapshot: new NullGitSnapshotV2(),
    validationPipelineDeps: { schemaValidate: validateWorkflowSchema, structuralValidate: validator.validateWorkflowStructureOnly.bind(validator), compiler: new WorkflowCompiler(), normalizeToExecutable: normalizeV1WorkflowToPinnedSnapshot },
  };
}
export type AnswerEngine = Extract<Awaited<ReturnType<typeof composeAnswerEngine>>, {kind: 'ready'}>;
