import type { ResultAsync } from 'neverthrow';
import type { SessionSummaryProviderPortV2, SessionSummaryError } from '../ports/session-summary-provider.port.js';
import {
  rankResumeCandidates,
  type ResumeQuery,
  type RankedResumeCandidate,
} from '../projections/resume-ranking.js';

/**
 * Resume session use case (thin orchestrator).
 *
 * 1. Load healthy session summaries from the provider
 * 2. Rank them using the pure 5-tier algorithm
 * 3. Return bounded candidate list
 *
 * The orchestrator is thin because the provider and ranking are separate concerns.
 */
export function resumeSession(
  query: ResumeQuery,
  summaryProvider: SessionSummaryProviderPortV2,
): ResultAsync<readonly RankedResumeCandidate[], SessionSummaryError> {
  return summaryProvider
    .loadHealthySummaries()
    .map((summaries) => rankResumeCandidates(summaries, query));
}
