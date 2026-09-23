import type { NormalizeStudyOutput } from './study-runner-normalization.mjs';
import type { StageAScoreReport } from './study-runner-contract.js';
import type { StageBScorerReport } from './stage-b-scorer-contract.js';

// Compile-only callers verify stage narrowing and reject mixed-stage reports.
declare const stageA: Extract<NormalizeStudyOutput, { readonly stage: 'A' }>;
declare const stageB: Extract<NormalizeStudyOutput, { readonly stage: 'B' }>;
declare const scoreA: StageAScoreReport;
declare const scoreB: StageBScorerReport;

const tagA: 'A' = stageA.stage;
const tagB: 'B' = stageB.stage;
const narrowedA: StageAScoreReport | null = stageA.scoreReport;
const narrowedB: StageBScorerReport | null = stageB.scoreReport;
const mixedA = { ...stageA, scoreReport: scoreB };
const mixedB = { ...stageB, scoreReport: scoreA };

// @ts-expect-error Stage B scores cannot describe Stage A trials.
const invalidA: NormalizeStudyOutput = mixedA;
// @ts-expect-error Stage A scores cannot describe Stage B trials.
const invalidB: NormalizeStudyOutput = mixedB;

void [tagA, tagB, narrowedA, narrowedB, invalidA, invalidB];
