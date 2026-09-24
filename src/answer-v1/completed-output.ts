import type { AnswerHostRecord } from '../v2/durable-core/schemas/session/answer-host.js';
import { completeReviewFromJson } from './review-history.js';
import { materializeReview } from './review-answer.js';

export type CompletedAnswerOutput =
  | Readonly<{ kind: 'notes'; notesMarkdown: string; artifacts: readonly [] }>
  | Readonly<{ kind: 'review' }> & ReturnType<typeof materializeReview>;

/** Only a committed invocation supplies a daemon handoff. Partial answers and later
 * rejected proposals cannot replace it, and exact finding enrichment is preserved. */
export function completedAnswerOutput(records: readonly AnswerHostRecord[]):
  Readonly<{ kind: 'available'; output: CompletedAnswerOutput }> | Readonly<{ kind: 'unavailable' }> {
  const committed = [...records].reverse().find(record => record.kind === 'committed' || record.kind === 'review_committed');
  if (committed?.kind === 'committed') return { kind: 'available', output: { kind: 'notes', notesMarkdown: committed.notes, artifacts: [] } };
  if (committed?.kind !== 'review_committed') return { kind: 'unavailable' };
  const prepared = records.find(record => record.kind === 'review_prepared' && record.invocation === committed.invocation);
  if (prepared?.kind !== 'review_prepared') return { kind: 'unavailable' };
  const fields = completeReviewFromJson(prepared.reviewJson);
  return fields ? { kind: 'available', output: { kind: 'review', ...materializeReview(fields) } } : { kind: 'unavailable' };
}
