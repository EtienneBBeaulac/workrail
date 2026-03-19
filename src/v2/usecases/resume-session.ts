import type { ResultAsync } from 'neverthrow';
import type { SessionSummaryProviderPortV2, SessionSummaryError } from '../ports/session-summary-provider.port.js';
import {
  rankResumeCandidates,
  type ResumeQuery,
  type RankedResumeCandidate,
} from '../projections/resume-ranking.js';

/**
 * Result of the resume session use case.
 * Separates the ranked candidates (top-N) from the total count so callers
 * can tell agents "we found X sessions but showed you the top 5."
 */
export interface ResumeSessionResult {
  /** Top-N ranked candidates with freshly minted resume tokens. */
  readonly candidates: readonly RankedResumeCandidate[];
  /** Total healthy sessions enumerated before ranking — may exceed candidates.length. */
  readonly totalFound: number;
}

/**
 * Resume session use case (thin orchestrator).
 *
 * 1. Load healthy session summaries from the provider
 * 2. Rank them using the pure 5-tier algorithm
 * 3. Return bounded candidate list AND the pre-cap total
 *
 * The orchestrator is thin because the provider and ranking are separate concerns.
 */
export function resumeSession(
  query: ResumeQuery,
  summaryProvider: SessionSummaryProviderPortV2,
): ResultAsync<ResumeSessionResult, SessionSummaryError> {
  return summaryProvider
    .loadHealthySummaries()
    .map((summaries) => ({
      candidates: rankResumeCandidates(summaries, query),
      totalFound: summaries.length,
    }));
}
