import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { Result, ResultAsync, ok, err } from 'neverthrow';

export interface WorkspaceLockData {
  readonly pid: number;
  readonly uuid: string;
  readonly heartbeat: number;
}

export class WorkspaceLock {
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(
    public readonly workspacePath: string,
    public readonly uuid: string,
    public readonly pid: number
  ) {}

  public async startHeartbeat(): Promise<void> {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(async () => {
      try {
        const lockFile = path.join(this.workspacePath, '.workrail.lock');
        const data: WorkspaceLockData = {
          pid: this.pid,
          uuid: this.uuid,
          heartbeat: Date.now(),
        };
        await fs.writeFile(lockFile, JSON.stringify(data, null, 2), 'utf8');
      } catch (e) {
        console.error(`[WorkspaceLock] Failed to write heartbeat:`, e);
      }
    }, 30000); // 30s interval
    if (this.heartbeatInterval.unref) {
      this.heartbeatInterval.unref();
    }
  }

  public async release(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    await WorkspaceLockManager.release(this.workspacePath, this.uuid);
  }
}

interface LockStackEntry {
  readonly uuid: string;
  heartbeatInterval: NodeJS.Timeout | null;
}

export class WorkspaceLockManager {
  private static activeLocks = new Map<string, LockStackEntry[]>();

  public static isLockedLocally(workspacePath: string): boolean {
    const canonical = path.resolve(workspacePath);
    return this.activeLocks.has(canonical);
  }

  public static assertLockActive(workspacePath: string, uuid: string): void {
    const canonical = path.resolve(workspacePath);
    const stack = this.activeLocks.get(canonical);
    if (!stack || stack.length === 0) {
      throw new Error(`WorkspaceLockViolation: Process does not hold the active lock for workspace: ${workspacePath}`);
    }
    const top = stack[stack.length - 1];
    if (top.uuid !== uuid) {
      throw new Error(`WorkspaceLockViolation: Lock UUID mismatch for workspace: ${workspacePath}. Expected ${uuid}, found active lock ${top.uuid}`);
    }

    const lockFile = path.join(canonical, '.workrail.lock');
    try {
      const content = fsSync.readFileSync(lockFile, 'utf8');
      const data: WorkspaceLockData = JSON.parse(content);
      if (data.uuid !== uuid) {
        throw new Error(`WorkspaceLockViolation: Lock has been stolen/overwritten by UUID: ${data.uuid}`);
      }
    } catch (e: any) {
      if (e.message?.includes('WorkspaceLockViolation')) {
        throw e;
      }
      throw new Error(`WorkspaceLockViolation: Lock file is missing or corrupt: ${e.message}`);
    }
  }

  public static acquire(workspacePath: string, uuid: string): ResultAsync<WorkspaceLock, Error> {
    return ResultAsync.fromPromise(
      (async () => {
        const canonical = path.resolve(workspacePath);
        const lockFile = path.join(canonical, '.workrail.lock');

        let existingLock: WorkspaceLockData | null = null;
        try {
          const content = await fs.readFile(lockFile, 'utf8');
          existingLock = JSON.parse(content);
        } catch {
          // File does not exist or is invalid JSON
        }

        const now = Date.now();
        if (existingLock) {
          const pid = existingLock.pid;
          const heartbeat = existingLock.heartbeat;
          const lockUuid = existingLock.uuid;

          // Nested lock acquisition in the same process
          if (pid === process.pid) {
            let stack = this.activeLocks.get(canonical);
            if (!stack) {
              stack = [];
              this.activeLocks.set(canonical, stack);
            }
            const entry: LockStackEntry = { uuid, heartbeatInterval: null };
            stack.push(entry);

            // Update the lock file
            const data: WorkspaceLockData = {
              pid: process.pid,
              uuid,
              heartbeat: now,
            };
            await fs.mkdir(canonical, { recursive: true });
            await fs.writeFile(lockFile, JSON.stringify(data, null, 2), 'utf8');

            const newLock = new WorkspaceLock(canonical, uuid, process.pid);
            await newLock.startHeartbeat();
            return newLock;
          }

          // Check external process liveness
          let isAlive = false;
          try {
            process.kill(pid, 0);
            isAlive = true;
          } catch (e: any) {
            isAlive = e.code === 'EPERM'; // alive but no permission
          }

          const isStarved = now - heartbeat > 90000; // 90s heartbeat starvation lease buffer

          if (isAlive && !isStarved) {
            throw new Error(`Workspace is locked by another process (PID: ${pid}, UUID: ${lockUuid}, last heartbeat: ${new Date(heartbeat).toISOString()})`);
          }
          console.warn(`[WorkspaceLock] Evicting dead/starved lock file at ${lockFile}`);
          // Clear stack on eviction
          this.activeLocks.delete(canonical);
        }

        // Write new lock
        const data: WorkspaceLockData = {
          pid: process.pid,
          uuid,
          heartbeat: now,
        };
        await fs.mkdir(canonical, { recursive: true });
        await fs.writeFile(lockFile, JSON.stringify(data, null, 2), 'utf8');

        const stack: LockStackEntry[] = [{ uuid, heartbeatInterval: null }];
        this.activeLocks.set(canonical, stack);

        const newLock = new WorkspaceLock(canonical, uuid, process.pid);
        await newLock.startHeartbeat();
        return newLock;
      })(),
      (e: any) => e instanceof Error ? e : new Error(String(e))
    );
  }

  public static async release(workspacePath: string, uuid: string): Promise<void> {
    const canonical = path.resolve(workspacePath);
    const stack = this.activeLocks.get(canonical);
    if (!stack) return;

    const idx = stack.findIndex(entry => entry.uuid === uuid);
    if (idx === -1) return;

    stack.splice(idx, 1);

    if (stack.length === 0) {
      this.activeLocks.delete(canonical);
      const lockFile = path.join(canonical, '.workrail.lock');
      try {
        const content = await fs.readFile(lockFile, 'utf8');
        const data: WorkspaceLockData = JSON.parse(content);
        if (data.uuid === uuid) {
          await fs.rm(lockFile, { force: true });
          console.log(`[WorkspaceLock] Released lock for ${canonical}`);
        }
      } catch {
        // ignore
      }
    } else {
      // Restore the top of the stack's lock in the file
      const top = stack[stack.length - 1];
      const lockFile = path.join(canonical, '.workrail.lock');
      try {
        const data: WorkspaceLockData = {
          pid: process.pid,
          uuid: top.uuid,
          heartbeat: Date.now(),
        };
        await fs.writeFile(lockFile, JSON.stringify(data, null, 2), 'utf8');
      } catch (e) {
        console.error(`[WorkspaceLock] Failed to restore lock stack top:`, e);
      }
    }
  }
}
