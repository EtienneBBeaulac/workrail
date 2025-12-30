/**
 * Time and process info port.
 *
 * Lock: durable-core must not use Date/process globals
 * Design: v2-core-design-locks.md §17 (runtime neutrality)
 *
 * Purpose:
 * - Provide current time for lock timestamps, cache TTL, etc.
 * - Provide process ID for lock file metadata
 *
 * Guarantees:
 * - Synchronous (time lookup is instant)
 * - Monotonic (time never goes backwards within same process)
 * - Injectable for testing
 *
 * When to use:
 * - Lock acquisition timestamps
 * - Cache freshness checks
 * - TTL calculations
 */
export interface TimeClockPortV2 {
  /**
   * Get current time in milliseconds since Unix epoch.
   *
   * @returns Unix timestamp in milliseconds
   */
  nowMs(): number;

  /**
   * Get current process ID.
   *
   * @returns Process ID (for lock file metadata)
   */
  getPid(): number;
}
