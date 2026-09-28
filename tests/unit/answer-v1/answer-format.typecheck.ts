import type { ModelPromptInput } from '../../../src/answer-v1/contracts/host-composition.js';
import type { WorkView } from '../../../src/answer-v1/contracts/answer-contract.js';
// @ts-expect-error a model question cannot omit its answer format
const incomplete: ModelPromptInput = { instruction: 'work', issues: [], retainedSummaries: [] };
declare const missingFormat: Omit<Extract<WorkView, { kind: 'question' }>, 'answerFormat'>;
// @ts-expect-error a public question cannot omit its answer format
const invalidQuestion: WorkView = missingFormat;
void incomplete;
void invalidQuestion;
