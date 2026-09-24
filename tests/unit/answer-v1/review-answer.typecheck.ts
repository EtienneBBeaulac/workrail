import type { ReviewFragment, ReviewFields } from '../../../src/answer-v1/review-answer.js';
const partial: ReviewFragment = { summary: 'Review complete.' };
// @ts-expect-error Empty fragments cannot enter the contribution core.
const empty: ReviewFragment = {};
// @ts-expect-error Transport strings cannot create a verdict.
const arbitrary: ReviewFragment = { verdict: 'approved' };
// @ts-expect-error Findings require validated routing and separately retained JSON.
const finding: ReviewFragment = { findings: [{ severity: 'minor', summary: 'Unchecked' }] };
// @ts-expect-error A partial answer cannot be materialized as a full verdict.
const incomplete: ReviewFields = partial;
void [partial, empty, arbitrary, finding, incomplete];
