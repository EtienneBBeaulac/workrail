import type {
  StudyReport,
  UnresolvedStudyReport,
  StageAStudyReport,
  StageBStudyReport,
  RejectedBytesReason,
} from './study-runner-contract.js';
import type { Trial as StageATrial } from './usability-scorer.mjs';

declare const fakeTrialA: StageATrial;

// --- POSITIVE CONTROLS ---

// 1. Valid unreadable_manifest report constructor
const validUnreadable: UnresolvedStudyReport = {
  version: 1,
  scope: 'orchestration_only',
  trialAuthorization: false,
  manifestPath: '/path/to/missing.json',
  stage: 'unresolved',
  status: 'failed',
  failureKind: 'unreadable_manifest',
  manifestSha256: null,
  scoreReport: null,
  trials: [],
  preflight: null,
  preflightTraces: [],
  agentLedger: [],
  hostLedger: [],
  slots: [],
};

// 2. Valid rejected_bytes report constructor (hash_mismatch)
const validHashMismatch: UnresolvedStudyReport = {
  version: 1,
  scope: 'orchestration_only',
  trialAuthorization: false,
  manifestPath: '/path/to/manifest.json',
  stage: 'unresolved',
  status: 'failed',
  failureKind: 'rejected_bytes',
  manifestSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  reason: 'hash_mismatch',
  scoreReport: null,
  trials: [],
  preflight: null,
  preflightTraces: [],
  agentLedger: [],
  hostLedger: [],
  slots: [{ runId: 'run-1', status: 'not_attempted' }],
};

// 3. Valid rejected_bytes report constructor (invalid_json)
const validInvalidJson: UnresolvedStudyReport = {
  version: 1,
  scope: 'orchestration_only',
  trialAuthorization: false,
  manifestPath: '/path/to/malformed.json',
  stage: 'unresolved',
  status: 'failed',
  failureKind: 'rejected_bytes',
  manifestSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  reason: 'invalid_json',
  scoreReport: null,
  trials: [],
  preflight: null,
  preflightTraces: [],
  agentLedger: [],
  hostLedger: [],
  slots: [],
};

// 4. Valid rejected_bytes report constructor (invalid_declaration)
const validInvalidDeclaration: UnresolvedStudyReport = {
  version: 1,
  scope: 'orchestration_only',
  trialAuthorization: false,
  manifestPath: '/path/to/bad-decl.json',
  stage: 'unresolved',
  status: 'failed',
  failureKind: 'rejected_bytes',
  manifestSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  reason: 'invalid_declaration',
  scoreReport: null,
  trials: [],
  preflight: null,
  preflightTraces: [],
  agentLedger: [],
  hostLedger: [],
  slots: [{ runId: 'run-2', status: 'not_attempted' }],
};

// 5. Positive StudyReport union assignment
const reportA: StudyReport = validUnreadable;
const reportB: StudyReport = validHashMismatch;

// 6. Positive narrowing
function checkNarrowing(report: StudyReport): void {
  if (report.stage === 'unresolved') {
    const status: 'failed' = report.status;
    const scoreReport: null = report.scoreReport;
    const trials: readonly [] = report.trials;
    void [status, scoreReport, trials];

    if (report.failureKind === 'unreadable_manifest') {
      const digest: null = report.manifestSha256;
      void digest;
    } else {
      const digest: string = report.manifestSha256;
      const reason: RejectedBytesReason = report.reason;
      void [digest, reason];
    }
  }
}

// --- NEGATIVE CONTROLS (Compile-only invalid constructors) ---

// @ts-expect-error unreadable cannot claim digest (manifestSha256 must be null)
const invalidUnreadableWithDigest: UnresolvedStudyReport = {
  ...validUnreadable,
  manifestSha256: '0000000000000000000000000000000000000000000000000000000000000000',
};

// @ts-expect-error byte-backed rejection cannot claim null digest
const invalidRejectedWithNullDigest: UnresolvedStudyReport = {
  ...validHashMismatch,
  manifestSha256: null,
};

// @ts-expect-error unreadable cannot define reason
const invalidUnreadableWithReason: UnresolvedStudyReport = {
  ...validUnreadable,
  reason: 'hash_mismatch',
};

const invalidRejectedReason: UnresolvedStudyReport = {
  ...validHashMismatch,
  // @ts-expect-error rejected_bytes cannot use arbitrary reason
  reason: 'unknown_failure_reason',
};

const invalidUnresolvedStageA: UnresolvedStudyReport = {
  ...validUnreadable,
  // @ts-expect-error unresolved report cannot have Stage A tag
  stage: 'A',
};

const invalidUnresolvedStageB: UnresolvedStudyReport = {
  ...validHashMismatch,
  // @ts-expect-error unresolved report cannot have Stage B tag
  stage: 'B',
};

const invalidUnresolvedWithTrials: UnresolvedStudyReport = {
  ...validUnreadable,
  // @ts-expect-error unresolved report cannot have non-empty trials
  trials: [fakeTrialA],
};

const invalidUnresolvedStatus: UnresolvedStudyReport = {
  ...validUnreadable,
  // @ts-expect-error unresolved report cannot have non-failed status
  status: 'complete_measurement',
};

// @ts-expect-error StageAStudyReport cannot accept unresolved stage
const invalidStageAFromUnresolved: StageAStudyReport = validUnreadable;

// @ts-expect-error StageBStudyReport cannot accept unresolved stage
const invalidStageBFromUnresolved: StageBStudyReport = validHashMismatch;

void [
  validUnreadable,
  validHashMismatch,
  validInvalidJson,
  validInvalidDeclaration,
  reportA,
  reportB,
  checkNarrowing,
  invalidUnreadableWithDigest,
  invalidRejectedWithNullDigest,
  invalidUnreadableWithReason,
  invalidRejectedReason,
  invalidUnresolvedStageA,
  invalidUnresolvedStageB,
  invalidUnresolvedWithTrials,
  invalidUnresolvedStatus,
  invalidStageAFromUnresolved,
  invalidStageBFromUnresolved,
];

const invalidUnresolvedNormalizedSlot: UnresolvedStudyReport = {
  ...validHashMismatch,
  // @ts-expect-error an unresolved manifest cannot claim a normalized trial
  slots: [{ runId: 'run-1', status: 'normalized' }],
};
void invalidUnresolvedNormalizedSlot;
