import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { answerFormat, NotesAnswerSchema, reviewFields } from '../../../src/answer-v1/answer-format.js';
import { parseReviewFragment } from '../../../src/answer-v1/review-answer.js';

const ajv = new Ajv({ strict: true });
describe('published answer schemas agree with domain admission', () => {
  const cases = [null, [], {}, { notes: [] }, { notes: '' }, { notes: 'observed' },
    { notes: 'observed', unknown: true }, { summary: 'summary' }, { verdict: 'clean' },
    { verdict: 'invented' }, { confidence: 'high' }, { findings: [] },
    { findings: [{ severity: 'minor', summary: 'finding', file: 'src/file.ts', details: { line: 2 } }] },
    { findings: [{ severity: 'minor', summary: 'finding', findingCategory: 'invented' }] },
    { findings: [{ severity: 'minor', summary: '' }] },
    { notes: 'reviewed', verdict: 'clean', confidence: 'low', findings: [], summary: 'done' },
  ];
  for (const kind of ['notes', 'review'] as const) {
    const format = answerFormat(kind);
    const validate = ajv.compile(format.schema);
    it.each(cases.map(value => [JSON.stringify(value), value]))(`${kind}: %s`, (_label, value) => {
      const accepted = kind === 'notes' ? NotesAnswerSchema.safeParse(value).success : parseReviewFragment(value).kind === 'valid';
      expect(validate(value)).toBe(accepted);
    });
    it(`${kind} example is valid and metadata never includes capabilities`, () => {
      expect(validate(format.example)).toBe(true);
      expect(kind === 'notes' ? NotesAnswerSchema.safeParse(format.example).success : parseReviewFragment(format.example).kind === 'valid').toBe(true);
      expect(Object.keys(format)).not.toEqual(expect.arrayContaining(['reply', 'recovery']));
    });
  }
  it('review guidance separates partial admission from required completion', () => {
    const format = answerFormat('review');
    expect(format.completionFields).toEqual(reviewFields);
    expect(format.completionFields).toEqual(['notes', 'verdict', 'confidence', 'findings', 'summary']);
    expect(format.instructions).toContain('partial');
    expect(format.instructions).toContain('replacement');
  });
});
