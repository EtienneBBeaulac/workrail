import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export type ConsoleDiscoveryRecord = Readonly<{ pid: number; port: number }>;
export type ConsoleDiscoveryPublication =
  | Readonly<{ kind: 'published' }>
  | Readonly<{ kind: 'unavailable'; message: string }>;

/** The chosen path is captured at composition, not supplied by each caller. */
export interface ConsoleDiscoveryPort {
  publish(record: ConsoleDiscoveryRecord): Promise<ConsoleDiscoveryPublication>;
  remove(): Promise<void>;
}

export function createConsoleDiscovery(lockFilePath: string): ConsoleDiscoveryPort {
  return {
    async publish(record) {
      try {
        await mkdir(dirname(lockFilePath), { recursive: true });
        await writeFile(lockFilePath, JSON.stringify(record), 'utf8');
        return { kind: 'published' };
      } catch (error) {
        return { kind: 'unavailable', message: error instanceof Error ? error.message : String(error) };
      }
    },
    async remove() {
      try { await unlink(lockFilePath); } catch { /* Discovery cleanup is best-effort. */ }
    },
  };
}
