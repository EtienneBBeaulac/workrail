import { NodeFileSystemV2 } from '../v2/infra/local/fs/index.js';
import { NodeHmacSha256V2 } from '../v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../v2/infra/local/base64url/index.js';
import { LocalKeyringV2 } from '../v2/infra/local/keyring/index.js';
import { NodeRandomEntropyV2 } from '../v2/infra/local/random-entropy/index.js';
import { NodeSha256V2 } from '../v2/infra/local/sha256/index.js';
import { NodeCryptoV2 } from '../v2/infra/local/crypto/index.js';
import { LocalSessionEventLogStoreV2 } from '../v2/infra/local/session-store/index.js';
import { LocalSnapshotStoreV2 } from '../v2/infra/local/snapshot-store/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../v2/infra/local/pinned-workflow-store/index.js';
import { answerDataDir } from './authority-paths.js';
import type { AnswerEngine } from './engine-composition.js';
import type { SharedAuthorityConfig } from './contracts/host-composition.js';
/** Read projections receive no append, lock, id minting or key creation capability. */
export type AnswerReadEngine = Readonly<{
    sessionStore: Pick<AnswerEngine['sessionStore'], 'load'>;
    snapshotStore: Pick<AnswerEngine['snapshotStore'], 'getExecutionSnapshotV1'>;
    pinnedStore: Pick<AnswerEngine['pinnedStore'], 'get'>;
    tokenCodecPorts: Pick<AnswerEngine['tokenCodecPorts'], 'hmac' | 'keyring'>;
}>;

export async function composeAnswerReader(config: SharedAuthorityConfig) {
    const dataDir = answerDataDir(config);
    const fs = new NodeFileSystemV2();
    const keyring = await new LocalKeyringV2(dataDir, fs, new NodeBase64UrlV2(), new NodeRandomEntropyV2()).loadExisting();
    if (keyring.isErr()) return { kind: 'unavailable' as const, detail: keyring.error.message };
    const sessions = new LocalSessionEventLogStoreV2(dataDir, fs, new NodeSha256V2());
    const snapshots = new LocalSnapshotStoreV2(dataDir, fs, new NodeCryptoV2());
    const pinned = new LocalPinnedWorkflowStoreV2(dataDir, fs);
    const engine: AnswerReadEngine = {
        sessionStore: { load: sessions.load.bind(sessions) },
        snapshotStore: { getExecutionSnapshotV1: snapshots.getExecutionSnapshotV1.bind(snapshots) },
        pinnedStore: { get: pinned.get.bind(pinned) },
        tokenCodecPorts: { keyring: keyring.value, hmac: new NodeHmacSha256V2() },
    };
    return { kind: 'ready' as const, engine };
}
