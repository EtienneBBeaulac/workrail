import type { AnswerSubmission, DomainAnswer } from '../../../src/answer-v1/contracts/answer-contract.js';

// Transport data does not become a validated domain answer by sharing a port.
// @ts-expect-error raw JSON is not a validated notes or review answer
const invalidDomain: DomainAnswer = { kind: 'unvalidated_json', value: { notes: 42 } };
// @ts-expect-error executable values cannot enter the JSON submission variant
const invalidSubmission: AnswerSubmission = { kind: 'unvalidated_json', value: () => true };
void invalidDomain;
void invalidSubmission;
