/**
 * Registry of ClientUsageReader implementations.
 *
 * WHY a registry (not a hardcoded call): adding a new MCP client reader requires
 * only writing one new file and adding one entry here. The collect() entry point
 * is unchanged.
 *
 * Ordering: readers are tried in order. All readers that match are collected --
 * multiple clients can produce usage events for the same session.
 */

import type { ClientUsageReader } from './types.js';
import { claudeCodeUsageReader } from './claude-code.js';

/**
 * Ordered list of all registered ClientUsageReader implementations.
 *
 * To add a new reader: implement ClientUsageReader, export a singleton,
 * and add it here.
 */
export const USAGE_READERS: readonly ClientUsageReader[] = [
  claudeCodeUsageReader,
  // Future: cursorUsageReader, antigravityUsageReader, etc.
];
