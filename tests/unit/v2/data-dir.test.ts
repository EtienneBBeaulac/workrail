/**
 * v2 Data Directory Tests
 *
 * @enforces data-dir-workrail-owned
 */
import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';

import { LocalDataDirV2 } from '../../../src/v2/infra/local/data-dir/index.js';

describe('v2 data directory (Slice 2 locks)', () => {
  it('data-dir-workrail-owned: default root is WorkRail-owned when no env override', () => {
    // Use a clean env object without override
    const cleanEnv: Record<string, string | undefined> = {};

    const dataDir = new LocalDataDirV2(cleanEnv);
    const root = dataDir.sessionsDir().split('/sessions')[0];

    // Expected: ~/.workrail/data (or equivalent on this OS)
    const expectedRoot = path.join(os.homedir(), '.workrail', 'data');

    expect(root).toBe(expectedRoot);
  });

  it('data-dir-workrail-owned: respects WORKRAIL_DATA_DIR env override', () => {
    const customRoot = '/tmp/custom-workrail-root';
    const env = { WORKRAIL_DATA_DIR: customRoot };

    const dataDir = new LocalDataDirV2(env);
    const root = dataDir.sessionsDir().split('/sessions')[0];

    expect(root).toBe(customRoot);
  });

  it('data-dir-workrail-owned: provides isolated sessions directory', () => {
    const customRoot = '/tmp/workrail-test';
    const env = { WORKRAIL_DATA_DIR: customRoot };

    const dataDir = new LocalDataDirV2(env);
    const sessionsDir = dataDir.sessionsDir();

    // Sessions should be under the root, not in a workflow dir or repo
    expect(sessionsDir).toContain('sessions');
    expect(sessionsDir).toBe(path.join(customRoot, 'sessions'));
  });

  it('data-dir-workrail-owned: provides isolated snapshots directory', () => {
    const customRoot = '/tmp/workrail-test';
    const env = { WORKRAIL_DATA_DIR: customRoot };

    const dataDir = new LocalDataDirV2(env);
    const snapshotsDir = dataDir.snapshotsDir();

    expect(snapshotsDir).toContain('snapshots');
    expect(snapshotsDir).toBe(path.join(customRoot, 'snapshots'));
  });

  it('data-dir-workrail-owned: provides isolated keyring directory', () => {
    const customRoot = '/tmp/workrail-test';
    const env = { WORKRAIL_DATA_DIR: customRoot };

    const dataDir = new LocalDataDirV2(env);
    const keysDir = dataDir.keysDir();

    expect(keysDir).toContain('keys');
    expect(keysDir).toBe(path.join(customRoot, 'keys'));
  });

  it('data-dir-workrail-owned: provides isolated pinned workflows directory', () => {
    const customRoot = '/tmp/workrail-test';
    const env = { WORKRAIL_DATA_DIR: customRoot };

    const dataDir = new LocalDataDirV2(env);
    const pinnedDir = dataDir.pinnedWorkflowsDir();

    expect(pinnedDir).toContain('workflows');
    expect(pinnedDir).toContain('pinned');
    expect(pinnedDir).toBe(path.join(customRoot, 'workflows', 'pinned'));
  });
});
