import { it, expect } from 'vitest';
import { completedAnswerOutput } from '../../src/answer-v1/completed-output.js';
import type { AnswerHostRecord } from '../../src/v2/durable-core/schemas/session/answer-host.js';

it('uses the complete committed review instead of its final partial submission', () => {
  const finding = { severity: 'minor', summary: 'Finding', evidence: { file: 'a.ts', line: 4 } };
  const review = { notes: 'Full review', verdict: 'minor', confidence: 'high', findings: [finding], summary: 'Final' };
  const records: AnswerHostRecord[] = [
    { kind: 'review_prepared', delivery: 'delivery', response: 'response', invocation: 'invocation', toolCallId: 'call', node: 'node', reviewJson: JSON.stringify(review), rawAnswer: JSON.stringify({ summary: 'Final' }) },
    { kind: 'review_committed', invocation: 'invocation', receipt: 'receipt', successorNode: 'end', rawAnswer: JSON.stringify({ summary: 'Final' }) },
  ];
  expect(completedAnswerOutput(records)).toEqual({ kind: 'available', output: { kind: 'review', notesMarkdown: review.notes,
    artifacts: [{ kind: 'wr.review_verdict', verdict: review.verdict, confidence: review.confidence, findings: [finding], summary: review.summary }] } });
  expect(completedAnswerOutput(records.slice(1))).toEqual({ kind: 'unavailable' });
  expect(completedAnswerOutput(records.slice(0, 1))).toEqual({ kind: 'unavailable' });
});

it('returns the final committed notes without borrowing earlier review artifacts', () => {
  expect(completedAnswerOutput([{ kind: 'committed', invocation: 'invocation', receipt: 'receipt', successorNode: 'end', notes: 'Final notes' }]))
    .toEqual({ kind: 'available', output: { kind: 'notes', notesMarkdown: 'Final notes', artifacts: [] } });
});
