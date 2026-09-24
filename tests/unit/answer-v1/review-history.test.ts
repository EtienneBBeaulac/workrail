import { it, expect } from 'vitest';
import { reviewHistory } from '../../../src/answer-v1/review-history.js';
import { contributeReview, parseReviewFragment } from '../../../src/answer-v1/review-answer.js';
import { AnswerHostRecordSchema, type AnswerHostRecord } from '../../../src/v2/durable-core/schemas/session/answer-host.js';
const partial: AnswerHostRecord = { kind: 'review_partial', node: 'node_a', delivery: 'delivery_a', response: 'response_a', receipt: 'receipt_a', rawAnswer: '{"verdict":"minor"}' };
const proposal: AnswerHostRecord = { kind: 'review_correction', node: 'node_a', delivery: 'delivery_b', response: 'response_b', receipt: 'receipt_b', rawAnswer: '{"verdict":"blocking"}' };
it('invalid rejection clears correction authority, while another node cannot clear or contribute', () => {
  const records: AnswerHostRecord[] = [partial, proposal,
    { kind: 'delivered', delivery: 'delivery_c', node: 'node_b', reply: 'reply', epoch: '1' },
    { kind: 'rejected', delivery: 'delivery_c', response: 'response_c', receipt: 'receipt_c', reason: 'Invalid', encoding: 'raw_utf8', rawAnswer: 'bad' }];
  const before = reviewHistory(records, 'node_a');
  expect(before.kind).toBe('ready');
  if (before.kind !== 'ready') return;
  expect(before.state.correction).not.toBeNull();
  const after = reviewHistory([...records,
    { kind: 'delivered', delivery: 'delivery_d', node: 'node_a', reply: 'reply', epoch: '1' },
    { kind: 'rejected', delivery: 'delivery_d', response: 'response_d', receipt: 'receipt_d', reason: 'Invalid', encoding: 'raw_utf8', rawAnswer: 'bad' }], 'node_a');
  if (after.kind !== 'ready') throw new Error(after.kind);
  expect(after.state.correction).toBeNull();
  const fragment = parseReviewFragment({ verdict: 'blocking' });
  if (fragment.kind !== 'valid') throw new Error(fragment.kind);
  expect(contributeReview(after.state, fragment.fragment).kind).toBe('correction_required');
  expect(reviewHistory([partial, proposal], 'node_b')).toEqual({ kind: 'ready', state: { accepted: {}, correction: null } });
});
it.each(['{broken', '{"verdict":"bad"}', '{}'])('refuses malformed retained contributions: %s', rawAnswer => {
  expect(reviewHistory([{ ...partial, rawAnswer }], 'node_a')).toEqual({ kind: 'corrupt' });
});
it('refuses a recorded correction with no prior accepted conflicting value', () => {
  expect(reviewHistory([proposal], 'node_a')).toEqual({ kind: 'corrupt' });
});
it('validates complete prepared review at the persistence boundary', () => {
  const record = { kind: 'review_prepared', node: 'node', delivery: 'delivery', response: 'response', invocation: 'invocation', toolCallId: 'call', rawAnswer: '{}' };
  const valid = { notes: 'Reviewed', verdict: 'minor', confidence: 'high', findings: [], summary: 'Done' };
  expect(AnswerHostRecordSchema.safeParse({ ...record, reviewJson: JSON.stringify(valid) }).success).toBe(true);
  for (const invalid of [{ ...valid, kind: 'wr.review_verdict' }, { ...valid, summary: undefined }, null]) {
    expect(AnswerHostRecordSchema.safeParse({ ...record, reviewJson: JSON.stringify(invalid) }).success).toBe(false);
  }
});
