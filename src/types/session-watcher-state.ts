/**
 * State types for session file watchers.
 * 
 * CRITICAL DESIGN:
 * Watcher and timer are stored together in WatcherState.
 * This ensures they have the same lifecycle and are cleaned up atomically.
 * 
 * This is the core fix for the timer leak bug.
 */

import type { FSWatcher } from 'fs';

/**
 * State for a single session file watcher.
 * 
 * INVARIANTS:
 * 1. If timer is not null, watcher must be valid (not closed)
 * 2. Both watcher and timer must be cleaned up together
 * 3. Error counts are reset on successful updates
 * 
 * These invariants are enforced by using createWatcherState() and
 * disposeWatcherState() functions - the only ways to create/destroy state.
 */
export interface WatcherState {
  /** The file system watcher - must be closed on cleanup */
  readonly watcher: FSWatcher;
  
  /** 
   * Pending debounce timer - must be cleared on cleanup.
   * Mutable because it's set/cleared during normal operation.
   * This is the key to fixing the timer leak bug.
   */
  timer: NodeJS.Timeout | null;
  
  /** Consecutive transient errors (EBUSY, EAGAIN, bad JSON) */
  transientErrorCount: number;
  
  /** Consecutive permanent errors (EACCES, file not found) */
  permanentErrorCount: number;
  
  /** When this watcher was created (for monitoring) */
  readonly createdAt: Date;
}

/**
 * Create a new watcher state.
 * Timer starts as null - set when file changes.
 * 
 * @param watcher - The FSWatcher instance
 * @returns Initialized WatcherState
 */
export function createWatcherState(watcher: FSWatcher): WatcherState {
  return {
    watcher,
    timer: null,
    transientErrorCount: 0,
    permanentErrorCount: 0,
    createdAt: new Date(),
  };
}

/**
 * Dispose a watcher state - clean up ALL resources.
 * 
 * CRITICAL: This is the ONLY place cleanup happens.
 * This function encodes the invariant: watcher and timer are cleaned up together.
 * 
 * Order matters:
 * 1. Clear timer first (might be holding references)
 * 2. Close watcher second
 * 
 * This function is idempotent - safe to call multiple times.
 * After calling, the WatcherState should not be used.
 * 
 * @param state - The watcher state to dispose
 */
export function disposeWatcherState(state: WatcherState): void {
  // 1. Clear timer (THE BUG FIX!)
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  
  // 2. Close watcher
  try {
    state.watcher.close();
  } catch (error) {
    // Watcher might already be closed - that's okay
    // Don't throw, just log
    if (process.env.NODE_ENV === 'development') {
      console.error('[disposeWatcherState] Error closing watcher:', error);
    }
  }
}

/**
 * Check if an error is transient (temporary, might resolve on retry).
 * 
 * Transient errors:
 * - EBUSY: File is locked (another process writing)
 * - EAGAIN: Resource temporarily unavailable
 * - ENOENT: File doesn't exist yet (mid-atomic-write)
 * - SyntaxError: Bad JSON (mid-write, will be fixed on next write)
 * 
 * Permanent errors:
 * - EACCES: Permission denied
 * - EISDIR: Path is a directory, not a file
 * - Others: Unknown issues
 * 
 * @param error - The error to categorize
 * @returns true if error is transient, false if permanent
 */
export function isTransientError(error: Error): boolean {
  const code = (error as any).code;
  
  // File system transient errors
  if (code === 'EBUSY') return true;
  if (code === 'EAGAIN') return true;
  if (code === 'ENOENT') return true;
  
  // JSON parse errors during atomic writes
  if (error instanceof SyntaxError) return true;
  
  // Everything else is permanent
  return false;
}
