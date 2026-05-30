/**
 * collect() -- entry point for usage collection.
 *
 * Scans all registered ClientUsageReaders for usage data belonging to a session.
 * Called fire-and-forget after run_completed is written; must never throw or block.
 *
 * Design:
 * - For each reader, enumerate files in searchDirs()
 * - For each candidate file (modified within session window), call parseUsage()
 * - Collect and return all non-null ClientUsage results
 * - All I/O errors are caught and discarded -- this is observability data, not correctness
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ClientUsage, ClientUsageReader } from './types.js';
import { USAGE_READERS } from './registry.js';

export type { ClientUsage, ClientUsageReader } from './types.js';

/**
 * Collect token usage for a session from all registered readers.
 *
 * @param sessionId - The WorkRail session ID (used for session ID grep in files)
 * @param workspacePath - Workspace root path (null-safe: returns [] if null/empty)
 * @param startMs - Session start timestamp in milliseconds (used to filter files by mtime)
 * @param readers - Readers to use (defaults to USAGE_READERS registry)
 *
 * @returns Array of ClientUsage objects, one per client that had matching data.
 *   Returns an empty array if no usage was found (not an error condition).
 *   Never throws.
 */
export async function collect(
  sessionId: string,
  workspacePath: string | null,
  startMs: number,
  readers: readonly ClientUsageReader[] = USAGE_READERS,
): Promise<readonly ClientUsage[]> {
  // Guard: workspacePath is required for directory enumeration.
  // When absent (e.g. no repo_root observation recorded), skip collection silently.
  if (!workspacePath) return [];

  const results: ClientUsage[] = [];

  for (const reader of readers) {
    const dirs = reader.searchDirs(workspacePath);

    for (const dir of dirs) {
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        // Directory doesn't exist or is unreadable -- skip this reader silently.
        continue;
      }

      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue;

        const filePath = join(dir, entry);
        try {
          const usage = await reader.parseUsage(filePath, sessionId, startMs);
          if (usage !== null) {
            results.push(usage);
          }
        } catch {
          // parseUsage should not throw (it catches internally), but guard here too.
          continue;
        }
      }
    }
  }

  return results;
}
