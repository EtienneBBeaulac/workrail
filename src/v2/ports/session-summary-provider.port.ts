import type { ResultAsync } from 'neverthrow';
import type { HealthySessionSummary } from '../projections/resume-ranking.js';

/**
 * Error from loading session summaries.
 */
export interface SessionSummaryError {
  readonly code: 'SESSION_SUMMARY_ENUMERATION_FAILED';
  readonly message: string;
}

/**
 * Port: Provides healthy session summaries for resume ranking.
 *
 * Today's implementation: enumerate sessions from disk, load + health-check + project each one.
 * Tomorrow: could use a session index file or cached projections for O(1) lookup.
 *
 * The seam exists from day one to prevent coupling resume to raw FS scanning.
 *
 * Lock: §DI — inject external effects at boundaries.
 */
export interface SessionSummaryProviderPortV2 {
  /**
   * Load all healthy session summaries.
   *
   * Returns only sessions that:
   * - Pass health check (healthy)
   * - Have at least one projectable run with a preferred tip
   *
   * Individual session failures are skipped gracefully (not fatal).
   * Bounded by MAX_SESSIONS_TO_SCAN to prevent unbounded enumeration.
   */
  loadHealthySummaries(): ResultAsync<readonly HealthySessionSummary[], SessionSummaryError>;
}
