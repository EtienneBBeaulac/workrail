import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { Result, ResultAsync, ok, err } from 'neverthrow';

export interface WorkspaceLockData {
  readonly pid: number;
  readonly uuid: string;
  readonly heartbeat: number;
}

async function safeWriteJson(filePath: string, data: any): Promise<void> {
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink()) {
      throw new Error(`WorkspaceLockViolation: Symbolic link detected at path: ${filePath}`);
    }
  } catch (e: any) {
    if (e.code !== 'ENOENT') {
      throw e;
    }
  }
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
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
        await safeWriteJson(lockFile, data);
      } catch (e) {
        console.error(`[WorkspaceLock] Failed to write heartbeat:`, e);
      }
    }, 30000); // 30s interval
    if (this.heartbeatInterval.unref) {
      this.heartbeatInterval.unref();
    }
  }

  public stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  public async release(): Promise<void> {
    this.stopHeartbeat();
    await WorkspaceLockManager.release(this.workspacePath, this.uuid);
  }
}

interface LockStackEntry {
  readonly uuid: string;
  readonly lock: WorkspaceLock;
}

export class WorkspaceLockManager {
  private static activeLocks = new Map<string, LockStackEntry[]>();
  private static acquireQueues = new Map<string, Promise<any>>();

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

  public static acquire(
    workspacePath: string,
    uuid: string,
    parentUuid?: string
  ): ResultAsync<WorkspaceLock, Error> {
    const canonical = path.resolve(workspacePath);
    const existingPromise = this.acquireQueues.get(canonical) || Promise.resolve();

    const nextPromise = existingPromise.then(async () => {
      return this.acquireInternal(canonical, uuid, parentUuid);
    });

    this.acquireQueues.set(canonical, nextPromise.then(() => {}).catch(() => {}));

    return ResultAsync.fromPromise(
      nextPromise,
      (e: any) => e instanceof Error ? e : new Error(String(e))
    ).andThen((res) => res);
  }

  private static async acquireInternal(
    canonical: string,
    uuid: string,
    parentUuid?: string
  ): Promise<Result<WorkspaceLock, Error>> {
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

      // Nested lock acquisition check:
      const stack = this.activeLocks.get(canonical);
      let isNested = false;
      if (stack && stack.length > 0) {
        const top = stack[stack.length - 1];
        isNested = parentUuid !== undefined && top.uuid === parentUuid;
      } else {
        isNested = parentUuid !== undefined && lockUuid === parentUuid;
      }

      if (isNested) {
        let stack = this.activeLocks.get(canonical);
        if (!stack) {
          stack = [];
          this.activeLocks.set(canonical, stack);
        }

        // Pause outer lock heartbeat
        if (stack.length > 0) {
          const top = stack[stack.length - 1];
          top.lock.stopHeartbeat();
        }

        const newLock = new WorkspaceLock(canonical, uuid, process.pid);
        const entry: LockStackEntry = { uuid, lock: newLock };
        stack.push(entry);

        // Update the lock file
        const data: WorkspaceLockData = {
          pid: process.pid,
          uuid,
          heartbeat: now,
        };
        await fs.mkdir(canonical, { recursive: true });
        await safeWriteJson(lockFile, data);

        await newLock.startHeartbeat();
        return ok(newLock);
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
        return err(new Error(`Workspace is locked by another process (PID: ${pid}, UUID: ${lockUuid}, last heartbeat: ${new Date(heartbeat).toISOString()})`));
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
    await safeWriteJson(lockFile, data);

    const newLock = new WorkspaceLock(canonical, uuid, process.pid);
    const stack: LockStackEntry[] = [{ uuid, lock: newLock }];
    this.activeLocks.set(canonical, stack);

    await newLock.startHeartbeat();
    return ok(newLock);
  }

  public static async release(workspacePath: string, uuid: string): Promise<void> {
    const canonical = path.resolve(workspacePath);
    const existingPromise = this.acquireQueues.get(canonical) || Promise.resolve();

    const nextPromise = existingPromise.then(async () => {
      await this.releaseInternal(canonical, uuid);
    });

    this.acquireQueues.set(canonical, nextPromise.then(() => {}).catch(() => {}));
    await nextPromise;
  }

  private static async releaseInternal(canonical: string, uuid: string): Promise<void> {
    const stack = this.activeLocks.get(canonical);
    if (!stack) return;

    const idx = stack.findIndex(entry => entry.uuid === uuid);
    if (idx === -1) return;

    const entry = stack[idx];
    entry.lock.stopHeartbeat();

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
        await safeWriteJson(lockFile, data);
        await top.lock.startHeartbeat();
      } catch (e) {
        console.error(`[WorkspaceLock] Failed to restore lock stack top:`, e);
      }
    }
  }
}
