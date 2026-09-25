import { describe, expect, it } from 'vitest';
import { contributeReview, emptyReview, materializeReview, parseReviewFragment, type ReviewFragment } from '../../../src/answer-v1/review-answer.js';
import { parseReviewVerdictArtifact } from '../../../src/v2/durable-core/schemas/artifacts/review-verdict.js';

function fragment(value: unknown): ReviewFragment {
  const parsed = parseReviewFragment(value);
  if (parsed.kind !== 'valid') throw new Error(JSON.stringify(parsed.issues));
  return parsed.fragment;
}
const finding = { severity: 'minor', summary: 'Retained finding', file: 'sample.ts',
  remediation: { steps: ['Repair guard'], context: null } };
const first = () => contributeReview(emptyReview, fragment({ notes: 'Reviewed.', verdict: 'minor',
  confidence: 'high', findings: [finding] }));

describe('review contributions', () => {
  it('retains compatible fields across a serialized restart and materializes the existing artifact contract', () => {
    const initial = first();
    expect(initial.kind).toBe('partial');
    if (initial.kind !== 'partial') return;
    expect(initial.issues).toEqual([{ kind: 'field', field: 'summary', reason: 'Provide summary.' }]);
    const finished = contributeReview(JSON.parse(JSON.stringify(initial.state)), fragment({ summary: 'Review complete.' }));
    expect(finished.kind).toBe('complete');
    if (finished.kind !== 'complete') return;
    const output = materializeReview(finished.fields);
    expect(output.notesMarkdown).toBe('Reviewed.');
    expect(output.artifacts).toEqual([{ kind: 'wr.review_verdict', verdict: 'minor', confidence: 'high',
      findings: [finding], summary: 'Review complete.' }]);
    expect(parseReviewVerdictArtifact(output.artifacts[0])).toEqual(output.artifacts[0]);
    expect(output.artifacts[0].findings[0]).not.toHaveProperty('findingCategory');
    expect(initial.state.accepted).not.toHaveProperty('summary');
  });

  it('accepts a complete compatible replacement after an incomplete answer', () => {
    const initial = first();
    const full = fragment({ notes: 'Reviewed.', verdict: 'minor', confidence: 'high',
      findings: [finding], summary: 'Review complete.' });
    expect(contributeReview(initial.state, full).kind).toBe('complete');
  });

  it('completes with retained judgments after declining a conflicting fragment', () => {
    const initial = first();
    const conflict = contributeReview(initial.state, fragment({ verdict: 'clean' }));
    expect(conflict.kind).toBe('correction_required');
    const completed = contributeReview(conflict.state, fragment({ summary: 'Original finding stands.' }));
    expect(completed.kind).toBe('complete');
    if (completed.kind === 'complete') expect(completed.fields.verdict).toBe('minor');
  });

  it('does not infer missing judgments from an explicit empty findings list', () => {
    const initial = contributeReview(emptyReview, fragment({ notes: 'Reviewed.', findings: [], summary: 'No findings.' }));
    expect(initial.kind).toBe('partial');
    if (initial.kind !== 'partial') return;
    expect(initial.issues.map(issue => issue.kind === 'field' ? issue.field : '')).toEqual(['verdict', 'confidence']);
    expect(contributeReview(initial.state, fragment({ verdict: 'clean', confidence: 'high' })).kind).toBe('complete');
  });

  it('rejects replacement first, then accepts exact confirmation plus missing information after restart', () => {
    const initial = first();
    const replacement = { ...finding, summary: 'Corrected finding' };
    const proposed = contributeReview(initial.state, fragment({ findings: [replacement] }));
    expect(proposed.kind).toBe('correction_required');
    expect(proposed.state.accepted).toEqual(initial.state.accepted);
    const done = contributeReview(JSON.parse(JSON.stringify(proposed.state)), fragment({ findings: [replacement], summary: 'Done.' }));
    expect(done.kind).toBe('complete');
    if (done.kind !== 'complete') return;
    expect(materializeReview(done.fields).artifacts[0].findings).toEqual([replacement]);
  });

  it('requires every proposed replacement and refuses unrelated changed fields on confirmation', () => {
    const initial = first();
    const proposed = contributeReview(initial.state, fragment({ verdict: 'blocking', confidence: 'low' }));
    const partialConfirmation = contributeReview(proposed.state, fragment({ verdict: 'blocking' }));
    expect(partialConfirmation.kind).toBe('correction_required');
    expect(partialConfirmation.state.accepted).toEqual(initial.state.accepted);
    const addedConflict = contributeReview(proposed.state, fragment({ verdict: 'blocking', confidence: 'low', notes: 'Different.' }));
    expect(addedConflict.kind).toBe('correction_required');
    expect(addedConflict.state.accepted).toEqual(initial.state.accepted);
  });

  it('clears correction authority after an unrelated compatible answer', () => {
    const initial = contributeReview(emptyReview, fragment({ findings: [finding] }));
    const proposed = contributeReview(initial.state, fragment({ findings: [] }));
    const other = contributeReview(proposed.state, fragment({ notes: 'Checked.' }));
    expect(other.state.correction).toBeNull();
    expect(contributeReview(other.state, fragment({ findings: [] })).kind).toBe('correction_required');
  });

  it('distinguishes explicit empty findings from absence and never appends findings on confirmation', () => {
    const initial = first();
    const proposed = contributeReview(initial.state, fragment({ findings: [] }));
    const confirmed = contributeReview(proposed.state, fragment({ findings: [], summary: 'No remaining findings.' }));
    expect(confirmed.kind).toBe('complete');
    if (confirmed.kind === 'complete') expect(materializeReview(confirmed.fields).artifacts[0].findings).toEqual([]);
  });

  it('compares finding enrichment canonically and preserves properties parsers may strip', () => {
    const enriched = JSON.parse('{"severity":"minor","summary":"Finding","__proto__":{"evidence":true},"nested":{"b":2,"a":1}}');
    const initial = contributeReview(emptyReview, fragment({ findings: [enriched] }));
    const same = JSON.parse('{"nested":{"a":1,"b":2},"__proto__":{"evidence":true},"summary":"Finding","severity":"minor"}');
    expect(contributeReview(initial.state, fragment({ findings: [same] })).kind).toBe('partial');
    expect(JSON.stringify(initial.state.accepted.findings![0]!.original)).toContain('"__proto__"');
    const changed = { ...same, nested: { a: 1, b: 3 } };
    expect(contributeReview(initial.state, fragment({ findings: [changed] })).kind).toBe('correction_required');
  });

  it.each([{}, { summary: '' }, { verdict: 'approved' }, { confidence: 'certain' },
    { findings: [{ severity: 'fatal', summary: 'Bad' }] }, { notes: 'Good', sessionId: 'other' },
    { kind: 'wr.review_verdict', notes: 'Good' }, { findings: [{ ...finding, extra: Infinity }] },
  ])('rejects invalid or privileged input without producing a contribution: %j', value => {
    expect(parseReviewFragment(value).kind).toBe('invalid');
  });
});
