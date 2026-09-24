import { dirname } from 'node:path';
import { LocalDataDirV2 } from '../v2/infra/local/data-dir/index.js';
import type { SharedAuthorityConfig } from './contracts/host-composition.js';
export function answerDataDir(config: SharedAuthorityConfig): import('../v2/ports/data-dir.port.js').DataDirPortV2 {
    class DataDir extends LocalDataDirV2 {
        override sessionsDir() { return config.storage.journalRootDir; }
        override keyringPath() { return config.keyringPath; }
    }
    const dataDir: import('../v2/ports/data-dir.port.js').DataDirPortV2 = new DataDir({ WORKRAIL_DATA_DIR: dirname(config.storage.journalRootDir), WORKRAIL_KEYS_DIR: dirname(config.keyringPath) });
    return dataDir;
}
