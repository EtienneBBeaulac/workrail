import type { AnswerHostRecord } from '../v2/durable-core/schemas/session/answer-host.js';
import { contributeReview, emptyReview, parseReviewFragment, materializeReview, type ReviewState, type ReviewFields } from './review-answer.js';
import { toCanonicalBytes } from '../v2/durable-core/canonical/jcs.js';

export function reviewFragmentFromJson(raw: string) {
  try { return parseReviewFragment(JSON.parse(raw)); }
  catch { return { kind: 'invalid' as const, issues: [{ kind: 'field' as const, field: 'notes' as const, reason: 'Invalid stored review JSON.' }] }; }
}
/** Replays decisions as well as contributions. Invalid history refuses, never repairs. */
export function reviewHistory(records: readonly AnswerHostRecord[], node: string):
  Readonly<{ kind: 'ready'; state: ReviewState }> | Readonly<{ kind: 'corrupt' }> {
  let state = emptyReview;
  for (const record of records) {
    if (record.kind === 'rejected') {
      const delivery = records.find(r => r.kind === 'delivered' && r.delivery === record.delivery);
      if (delivery?.kind === 'delivered' && delivery.node === node) state = { ...state, correction: null };
      continue;
    }
    if ((record.kind !== 'review_partial' && record.kind !== 'review_correction') || record.node !== node) continue;
    const parsed = reviewFragmentFromJson(record.rawAnswer);
    if (parsed.kind !== 'valid') return { kind: 'corrupt' };
    const result = contributeReview(state, parsed.fragment);
    if ((record.kind === 'review_partial' && result.kind !== 'partial')
      || (record.kind === 'review_correction' && result.kind !== 'correction_required')) return { kind: 'corrupt' };
    state = result.state;
  }
  return { kind: 'ready', state };
}
export function completeReviewFromJson(raw: string): ReviewFields | undefined {
  const parsed = reviewFragmentFromJson(raw);
  if (parsed.kind !== 'valid') return undefined;
  const result = contributeReview(emptyReview, parsed.fragment);
  return result.kind === 'complete' ? result.fields : undefined;
}
export function reviewFieldsJson(fields: ReviewFields): string | undefined {
  const output = materializeReview(fields);
  const { kind: _kind, ...artifact } = output.artifacts[0];
  const bytes = toCanonicalBytes({ notes: output.notesMarkdown, ...artifact });
  return bytes.isOk() ? Buffer.from(bytes.value).toString('utf8') : undefined;
}
