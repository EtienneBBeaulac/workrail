import * as os from 'os';
import * as path from 'path';
import type { DataDirPortV2 } from '../../../ports/data-dir.port.js';

export class LocalDataDirV2 implements DataDirPortV2 {
  constructor(private readonly env: Record<string, string | undefined>) {}

  /**
   * Convert an identifier (hash/ref) into a filename-safe segment.
   *
   * WHY: Windows forbids ':' in filenames, but our refs/hashes are `sha256:...`.
   * We must store them on disk in a cross-platform safe form.
   */
  private safeFileSegment(raw: string): string {
    // Keep it deterministic; replace anything outside a conservative set.
    return raw.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  private root(): string {
    const configured = this.env['WORKRAIL_DATA_DIR'];
    return configured ? configured : path.join(os.homedir(), '.workrail', 'data');
  }

  snapshotsDir(): string {
    return path.join(this.root(), 'snapshots');
  }

  snapshotPath(snapshotRef: string): string {
    return path.join(this.snapshotsDir(), `${this.safeFileSegment(snapshotRef)}.json`);
  }

  keysDir(): string {
    return path.join(this.root(), 'keys');
  }

  keyringPath(): string {
    return path.join(this.keysDir(), 'keyring.json');
  }

  pinnedWorkflowsDir(): string {
    return path.join(this.root(), 'workflows', 'pinned');
  }

  pinnedWorkflowPath(workflowHash: string): string {
    return path.join(this.pinnedWorkflowsDir(), `${this.safeFileSegment(workflowHash)}.json`);
  }

  sessionsDir(): string {
    return path.join(this.root(), 'sessions');
  }

  sessionDir(sessionId: string): string {
    return path.join(this.sessionsDir(), sessionId);
  }

  sessionEventsDir(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'events');
  }

  sessionManifestPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'manifest.jsonl');
  }

  sessionLockPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), '.lock');
  }
}
