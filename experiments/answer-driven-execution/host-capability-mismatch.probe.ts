/** Bounded post-enrollment capability mismatch acceptance probe for answer-driven execution.
 * Verifies two real candidate builds across genuine notes and review workflows:
 * - Full writer supports 'notes' + 'wr.contracts.review_verdict'
 * - Restricted reader supports 'notes' only
 * - Metadata self-report is checked strictly, then proven by actual isolated enrollment rejection
 * - Writer advances turn 1 (notes); reader recovers on same storage and safely refuses with
 *   unsupported_capability without mutating session bytes or invoking model inference
 * - Compatible writer recovers, inspects original receipt notes, and answers review to completion
 * - Separate positive control: full writer creates two-notes workflow, notes-only reader recovers
 *   and completes turn 2, reading both receipts from shared storage.
 */
import 'reflect-metadata';
import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

import { asSessionId } from '../../src/v2/durable-core/ids/index.js';
import { LocalDataDirV2 } from '../../src/v2/infra/local/data-dir/index.js';
import { LocalSessionEventLogStoreV2 } from '../../src/v2/infra/local/session-store/index.js';
import { NodeFileSystemV2 } from '../../src/v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../../src/v2/infra/local/sha256/index.js';
import { readVerdictArtifact } from '../../src/coordinators/pr-review.js';

import type {
  HostWorkRequest, ModelCompletionResult, ModelInferenceBoundary, ModelPromptInput,
  PersistedHostPointer, RuntimeCapabilityDescriptor, SharedAuthorityConfig, SupportedAnswerOutput,
  TrustedAnswerScheduler,
} from '../../src/answer-v1/contracts/host-composition.js';
import type { HostExecutorPorts, RawModelResponse } from '../../src/answer-v1/contracts/invocation-contract.js';
import type { ReadRef, ReceiptRef } from '../../src/answer-v1/contracts/answer-contract.js';

interface LoadedCandidateBuild {
  readonly path: string;
  readonly realPath: string;
  readonly sha256: string;
  readonly createAnswerHost: typeof import('../../src/answer-v1/host.js').createAnswerHost;
  readonly capabilities: RuntimeCapabilityDescriptor;
}

const ALLOWED_OUTPUTS = new Set<string>(['notes', 'wr.contracts.review_verdict']);

function parseRuntimeCapabilityDescriptor(
  raw: unknown,
  envVarName: string,
  realPath: string,
): RuntimeCapabilityDescriptor {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    expect.fail(`runtime_error: ${envVarName} runtimeCapabilities at ${realPath} must be a non-null object`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.enrollmentFormatVersion !== 1) {
    expect.fail(`runtime_error: ${envVarName} runtimeCapabilities.enrollmentFormatVersion at ${realPath} must be 1 (got: ${String(obj.enrollmentFormatVersion)})`);
  }
  if (obj.journalFormatVersion !== 1) {
    expect.fail(`runtime_error: ${envVarName} runtimeCapabilities.journalFormatVersion at ${realPath} must be 1 (got: ${String(obj.journalFormatVersion)})`);
  }
  if (!Array.isArray(obj.supportedOutputs)) {
    expect.fail(`runtime_error: ${envVarName} runtimeCapabilities.supportedOutputs at ${realPath} must be an array`);
  }
  for (const item of obj.supportedOutputs) {
    if (typeof item !== 'string' || !ALLOWED_OUTPUTS.has(item)) {
      expect.fail(`runtime_error: ${envVarName} runtimeCapabilities.supportedOutputs at ${realPath} contains invalid output literal: ${String(item)}`);
    }
  }
  return {
    enrollmentFormatVersion: 1,
    journalFormatVersion: 1,
    supportedOutputs: obj.supportedOutputs as readonly SupportedAnswerOutput[],
  };
}

async function loadCandidateBuild(
  envVarName: 'WORKRAIL_CAPABILITY_WRITER_MODULE' | 'WORKRAIL_CAPABILITY_READER_MODULE',
): Promise<LoadedCandidateBuild> {
  const modPath = process.env[envVarName];
  if (!modPath) expect.fail(`runtime_unavailable: ${envVarName} environment variable is not set`);
  if (!isAbsolute(modPath)) expect.fail(`runtime_unavailable: ${envVarName} must be an absolute path (got: ${modPath})`);
  let realPath: string;
  try {
    await stat(modPath);
    realPath = await realpath(modPath);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      expect.fail(`runtime_unavailable: ${envVarName} file does not exist at ${modPath}`);
    }
    throw err;
  }

  const content = await readFile(realPath);
  const sha256 = createHash('sha256').update(content).digest('hex');
  console.log(`[capability-probe] loaded ${envVarName} from ${realPath} (entrypoint SHA256: ${sha256}); note: entrypoint hash != full installed/transitive build identity proof`);

  let mod: Record<string, unknown>;
  try {
    mod = (await import(/* @vite-ignore */ realPath)) as Record<string, unknown>;
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.stack ?? err.message : String(err);
    expect.fail(`runtime_error: ${envVarName} failed to load from ${realPath}: ${detail}`);
  }

  if (!mod || typeof mod.createAnswerHost !== 'function') {
    expect.fail(`runtime_error: ${envVarName} missing createAnswerHost export at ${realPath}`);
  }
  if (!Object.hasOwn(mod, 'runtimeCapabilities')) {
    expect.fail(`runtime_error: ${envVarName} missing runtimeCapabilities export at ${realPath}`);
  }
  const caps = parseRuntimeCapabilityDescriptor(mod.runtimeCapabilities, envVarName, realPath);
  return {
    path: modPath,
    realPath,
    sha256,
    createAnswerHost: mod.createAnswerHost as typeof import('../../src/answer-v1/host.js').createAnswerHost,
    capabilities: caps,
  };
}

class FakeTestModelBoundary implements ModelInferenceBoundary {
  public callCount = 0;
  public promptHistory: ModelPromptInput[] = [];
  private queued: RawModelResponse[] = [];
  setQueuedResponses(responses: RawModelResponse[]): void { this.queued = [...responses]; }
  async generate(input: ModelPromptInput, signal: AbortSignal): Promise<ModelCompletionResult> {
    this.callCount++; this.promptHistory.push(input);
    if (signal.aborted) return { kind: 'cancelled' };
    const next = this.queued.shift();
    return next ? { kind: 'completed', response: next } : { kind: 'unavailable', detail: 'No queued model response available' };
  }
}

const makeNotesResponse = (id: string, notes: string): RawModelResponse => ({
  responseText: notes,
  calls: [{ id, name: 'answer_work', argumentsJson: JSON.stringify({ answer: { notes } }) }],
});

interface ReviewFindingLocation {
  readonly file: string;
  readonly line: number;
}

interface ReviewFindingEvidence {
  readonly observed: string;
}

interface ReviewFindingRemedy {
  readonly recommendation: string;
}

type FindingSeverity = 'critical' | 'major' | 'minor' | 'nit';

interface ReviewFindingWithEnrichment {
  readonly severity: FindingSeverity;
  readonly summary: string;
  readonly findingCategory: 'correctness';
  readonly location: ReviewFindingLocation;
  readonly evidence: ReviewFindingEvidence;
  readonly remedy: ReviewFindingRemedy;
}

interface ReviewFindingPlain {
  readonly severity: FindingSeverity;
  readonly summary: string;
  readonly findingCategory?: never;
  readonly location?: never;
  readonly evidence?: never;
  readonly remedy?: never;
}

type ReviewAnswerFinding = ReviewFindingWithEnrichment | ReviewFindingPlain;

interface ReviewAnswerPayload {
  readonly notes: string;
  readonly verdict: 'clean' | 'minor' | 'blocking';
  readonly confidence: 'high' | 'medium' | 'low';
  readonly findings: readonly ReviewAnswerFinding[];
  readonly summary: string;
  readonly kind?: never;
}

const makeReviewResponse = (id: string, payload: ReviewAnswerPayload): RawModelResponse => ({
  responseText: payload.summary,
  calls: [{
    id,
    name: 'answer_work',
    argumentsJson: JSON.stringify({ answer: payload }),
  }],
});

async function verifyReceiptChunk(
  ports: HostExecutorPorts, readRef: ReadRef, receipt: ReceiptRef, expectedMatcher: unknown, signal: AbortSignal,
): Promise<void> {
  const read = await ports.inspector.inspectReceipt(readRef, receipt, signal);
  expect(read.kind).toBe('complete');
  if (read.kind === 'complete') {
    expect(read.disposition).toBe('accepted');
    expect(read.receipt).toBe(receipt);
    expect(JSON.parse(read.chunk)).toEqual(expectedMatcher);
  }
}

const bounded = async <T>(work: Promise<T>, timeoutMs = 3000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Operation timed out; preserving storage')), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
};

const snapshotStorage = async (dir: string): Promise<Record<string, string>> => {
  const res: Record<string, string> = { [dir]: '<directory>' };
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') return { [dir]: '<absent>' };
    throw err;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { res[`dir:${full}`] = 'directory'; Object.assign(res, await snapshotStorage(full)); }
    else if (e.isFile()) res[`file:${full}`] = (await readFile(full)).toString('base64');
    else throw new Error(`Unsupported storage entry: ${full}`);
  }
  return res;
};

async function verifyRestrictedReaderIsolation(readerBuild: LoadedCandidateBuild, signal: AbortSignal): Promise<void> {
  if (priorCleanupFailure) throw priorCleanupFailure;
  const isoRoot = await mkdtemp(join(tmpdir(), 'workrail-cap-reader-iso-'));
  const [dataDirRoot, workflowsDir] = [join(isoRoot, 'data'), join(isoRoot, 'workflows')];
  const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: dataDirRoot });
  const [journalRootDir, hostIndexRootDir, keysDir] = [dataDir.sessionsDir(), join(dataDirRoot, 'host-index'), dataDir.keysDir()];

  await Promise.all([
    mkdir(journalRootDir, { recursive: true }), mkdir(hostIndexRootDir, { recursive: true }),
    mkdir(keysDir, { recursive: true }), mkdir(workflowsDir, { recursive: true }),
  ]);

  await writeFile(join(workflowsDir, 'notes-only.json'), JSON.stringify({
    id: 'notes-only', name: 'Notes Only', description: 'Notes only', version: '1.0.0',
    steps: [{ id: 'step-1', title: 'Notes', prompt: 'Record notes.' }],
  }), 'utf8');

  await writeFile(join(workflowsDir, 'notes-then-review.json'), JSON.stringify({
    id: 'notes-then-review', name: 'Notes Then Review', description: 'Two-step workflow', version: '1.0.0',
    steps: [
      { id: 'step-1', title: 'Notes', prompt: 'Record notes.' },
      { id: 'step-2', title: 'Review', prompt: 'Review.', outputContract: { contractRef: 'wr.contracts.review_verdict' } },
    ],
  }), 'utf8');

  const sharedConfig: SharedAuthorityConfig = {
    storage: { journalRootDir, hostIndexRootDir }, keyringPath: dataDir.keyringPath(), workflowStoragePath: workflowsDir,
  };
  const fakeModel = new FakeTestModelBoundary();
  fakeModel.setQueuedResponses([makeNotesResponse('r-iso-1', 'Positive restricted notes observation')]);

  let hostScheduler: TrustedAnswerScheduler | undefined;
  let primaryError: unknown;
  let hostClosed = false;

  try {
    const hostRes = await readerBuild.createAnswerHost({ ...sharedConfig, model: fakeModel }, signal);
    expect(hostRes.kind).toBe('created');
    if (hostRes.kind !== 'created') return;
    hostScheduler = hostRes.scheduler;

    const posEnroll = await hostRes.scheduler.enroll({ workflowId: 'notes-only', goal: 'Restricted reader positive notes', workspacePath: isoRoot }, signal);
    expect(posEnroll.kind).toBe('enrolled');
    if (posEnroll.kind === 'enrolled') {
      const turn = await posEnroll.runner.runTurn(signal);
      expect(turn.kind).toBe('advanced');
      if (turn.kind === 'advanced') expect(turn.nextView.kind).toBe('finished');
    }

    const journalBefore = await snapshotStorage(journalRootDir);
    const inferenceCountBefore = fakeModel.callCount;

    const negEnroll = await hostRes.scheduler.enroll({ workflowId: 'notes-then-review', goal: 'Restricted reader negative attempt', workspacePath: isoRoot }, signal);
    expect(negEnroll.kind).toBe('refused');
    if (negEnroll.kind === 'refused') expect(negEnroll.reason).toBe('unsupported_workflow');

    expect(fakeModel.callCount).toBe(inferenceCountBefore);

    await bounded((async () => {
      const closeRes = await hostRes.scheduler.close(AbortSignal.timeout(2500));
      if (closeRes.kind !== 'closed') throw new Error(`Isolated reader host cleanup incomplete: ${closeRes.reason}`);
      hostClosed = true;
    })());

    const journalAfter = await snapshotStorage(journalRootDir);
    expect(journalAfter).toEqual(journalBefore);
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    if (!hostClosed && hostScheduler) {
      try {
        await bounded((async () => {
          const res = await hostScheduler!.close(AbortSignal.timeout(2500));
          if (res.kind === 'closed') hostClosed = true;
          else throw new Error(`Isolated reader host cleanup incomplete: ${res.reason}`);
        })());
      } catch (closeErr) {
        priorCleanupFailure = closeErr instanceof Error ? closeErr : new Error(String(closeErr));
      }
    }
    if (!primaryError && hostClosed) {
      await rm(isoRoot, { recursive: true, force: true });
    }
  }
}

interface WorkflowStepDef {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly outputContract?: { readonly contractRef: string };
}

interface WorkflowDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly steps: readonly WorkflowStepDef[];
}

interface CapabilityFixtureContext {
  root: string; dataDir: LocalDataDirV2; journalRootDir: string;
  sharedAuthorityConfig: SharedAuthorityConfig; workRequest: HostWorkRequest;
  writerBuild: LoadedCandidateBuild; readerBuild: LoadedCandidateBuild;
  trackHost: (s: TrustedAnswerScheduler) => void; closeHost: (s: TrustedAnswerScheduler) => Promise<void>;
}

interface CapabilityFixtureOptions {
  readonly workflow?: WorkflowDefinition;
}

const defaultNotesThenReviewWorkflow: WorkflowDefinition = {
  id: 'notes-then-review',
  name: 'Notes Then Review Workflow',
  description: 'Actual notes then review workflow',
  version: '1.0.0',
  steps: [
    { id: 'step-1', title: 'Step 1: Notes', prompt: 'Record first observation.' },
    { id: 'step-2', title: 'Step 2: Review Verdict', prompt: 'Provide structured review verdict.', outputContract: { contractRef: 'wr.contracts.review_verdict' } },
  ],
};

const twoNotesWorkflow: WorkflowDefinition = {
  id: 'notes-then-notes',
  name: 'Two Notes Workflow',
  description: 'Actual notes then notes workflow for cross-build compatible verification',
  version: '1.0.0',
  steps: [
    { id: 'step-1', title: 'Step 1: Notes', prompt: 'Record first observation.' },
    { id: 'step-2', title: 'Step 2: Second Notes', prompt: 'Record second observation.' },
  ],
};

let priorCleanupFailure: Error | undefined;

async function capabilityMismatchFixture(
  run: (f: CapabilityFixtureContext) => Promise<void>,
  options?: CapabilityFixtureOptions,
): Promise<void> {
  if (priorCleanupFailure) throw priorCleanupFailure;
  const writerBuild = await loadCandidateBuild('WORKRAIL_CAPABILITY_WRITER_MODULE');
  const readerBuild = await loadCandidateBuild('WORKRAIL_CAPABILITY_READER_MODULE');

  expect(writerBuild.realPath).not.toBe(readerBuild.realPath);
  expect(writerBuild.capabilities.enrollmentFormatVersion).toBe(1);
  expect(writerBuild.capabilities.journalFormatVersion).toBe(1);
  expect(readerBuild.capabilities.enrollmentFormatVersion).toBe(1);
  expect(readerBuild.capabilities.journalFormatVersion).toBe(1);
  expect(writerBuild.capabilities.supportedOutputs).toContain('notes');
  expect(writerBuild.capabilities.supportedOutputs).toContain('wr.contracts.review_verdict');
  expect(readerBuild.capabilities.supportedOutputs).toContain('notes');
  expect(readerBuild.capabilities.supportedOutputs).not.toContain('wr.contracts.review_verdict');

  const root = await mkdtemp(join(tmpdir(), 'workrail-cap-mismatch-'));
  const [dataDirRoot, workflowsDir] = [join(root, 'data'), join(root, 'workflows')];
  const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: dataDirRoot });
  const [journalRootDir, hostIndexRootDir, keysDir, pinnedWorkflowsDir] = [
    dataDir.sessionsDir(),
    join(dataDirRoot, 'host-index'),
    dataDir.keysDir(),
    dataDir.pinnedWorkflowsDir(),
  ];

  await Promise.all([
    mkdir(journalRootDir, { recursive: true }),
    mkdir(hostIndexRootDir, { recursive: true }),
    mkdir(keysDir, { recursive: true }),
    mkdir(workflowsDir, { recursive: true }),
    mkdir(pinnedWorkflowsDir, { recursive: true }),
  ]);

  const activeWorkflow = options?.workflow ?? defaultNotesThenReviewWorkflow;
  await writeFile(join(workflowsDir, `${activeWorkflow.id}.json`), JSON.stringify(activeWorkflow), 'utf8');

  const sharedAuthorityConfig: SharedAuthorityConfig = {
    storage: { journalRootDir, hostIndexRootDir }, keyringPath: dataDir.keyringPath(), workflowStoragePath: workflowsDir,
  };
  const workRequest: HostWorkRequest = { workflowId: activeWorkflow.id, goal: `Capability probe run: ${activeWorkflow.id}`, workspacePath: root };

  const hosts = new Set<TrustedAnswerScheduler>();
  const closeHost = async (host: TrustedAnswerScheduler) => {
    await bounded((async () => {
      const result = await host.close(AbortSignal.timeout(2500));
      if (result.kind !== 'closed') throw new Error(`Host cleanup incomplete: ${result.reason}`);
      hosts.delete(host);
    })());
  };

  let primaryError: unknown;
  try {
    await run({ root, dataDir, journalRootDir, sharedAuthorityConfig, workRequest, writerBuild, readerBuild, trackHost: s => { hosts.add(s); }, closeHost });
  } catch (err) {
    primaryError = err; throw err;
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const host of hosts) {
      try { await bounded(closeHost(host)); } catch (err) { cleanupErrors.push(err); }
    }
    if (cleanupErrors.length) {
      priorCleanupFailure = new AggregateError(cleanupErrors, `Cleanup incomplete; retained ${root}`, primaryError ? { cause: primaryError } : undefined);
      throw priorCleanupFailure;
    }
    if (!primaryError && hosts.size === 0) await rm(root, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------
// Cross-Build Compatible Notes Positive Control
// -----------------------------------------------------------------------------

it('cross-build compatible control: full writer creates two-notes workflow and accepts first notes, notes-only reader recovers on same storage and completes second notes, reading both receipts', () => capabilityMismatchFixture(async f => {
  const signal = new AbortController().signal;

  // 1. Writer enrolls two-notes workflow, advances first notes turn, preserves pointer and receipt 1, confirms close
  const writerModel = new FakeTestModelBoundary();
  const note1 = 'Compatible cross-build note from full writer.';
  writerModel.setQueuedResponses([makeNotesResponse('w-compat-1', note1)]);

  const writerHostRes = await f.writerBuild.createAnswerHost({ ...f.sharedAuthorityConfig, model: writerModel }, signal);
  expect(writerHostRes.kind).toBe('created');
  if (writerHostRes.kind !== 'created') return;
  f.trackHost(writerHostRes.scheduler);

  const enrollRes = await writerHostRes.scheduler.enroll(f.workRequest, signal);
  expect(enrollRes.kind).toBe('enrolled');
  if (enrollRes.kind !== 'enrolled') return;

  const pointer: PersistedHostPointer = writerHostRes.scheduler.hydrator.dehydrate(enrollRes.enrollment);
  expect(pointer.formatVersion).toBe(1);

  const turn1 = await enrollRes.runner.runTurn(signal);
  expect(turn1.kind).toBe('advanced');
  if (turn1.kind !== 'advanced') return;
  expect(turn1.nextView.kind).not.toBe('finished');
  expect(writerModel.callCount).toBe(1);
  const receipt1 = turn1.receipt;

  await f.closeHost(writerHostRes.scheduler);

  // 2. Notes-only reader on SAME root and keys recovers pointer, advances second notes turn to finished
  const readerModel = new FakeTestModelBoundary();
  const note2 = 'Compatible cross-build note from restricted reader.';
  readerModel.setQueuedResponses([makeNotesResponse('r-compat-2', note2)]);

  const readerHostRes = await f.readerBuild.createAnswerHost({ ...f.sharedAuthorityConfig, model: readerModel }, signal);
  expect(readerHostRes.kind).toBe('created');
  if (readerHostRes.kind !== 'created') return;
  f.trackHost(readerHostRes.scheduler);

  const recoverRes = await readerHostRes.scheduler.recover(pointer, signal);
  expect(recoverRes.kind).toBe('ready');
  if (recoverRes.kind !== 'ready') return;

  const ports = readerHostRes.scheduler.bindDiagnosticPorts(recoverRes.enrollment);

  const turn2 = await recoverRes.runner.runTurn(signal);
  expect(turn2.kind).toBe('advanced');
  if (turn2.kind !== 'advanced') return;
  expect(turn2.nextView.kind).toBe('finished');
  if (turn2.nextView.kind !== 'finished') return;
  expect(turn2.nextView.execution.kind).toBe('completed');
  expect(turn2.nextView.retained).toHaveLength(2);
  expect(turn2.nextView.retained[0]!.receipt).toBe(receipt1);
  expect(turn2.nextView.retained[1]!.receipt).toBe(turn2.receipt);
  expect(readerModel.callCount).toBe(1);

  // 3. Reader reads both receipts (writer note 1 and reader note 2)
  await verifyReceiptChunk(ports, turn2.nextView.read, receipt1, { notes: note1 }, signal);
  await verifyReceiptChunk(ports, turn2.nextView.read, turn2.receipt, { notes: note2 }, signal);

  await f.closeHost(readerHostRes.scheduler);
}, { workflow: twoNotesWorkflow }));

// -----------------------------------------------------------------------------
// Two-Build Capability Mismatch Acceptance Probe
// -----------------------------------------------------------------------------

it('capability mismatch acceptance: restricted reader safely refuses recovered session requiring unsupported review contract with zero inference, compatible writer finishes to completion', () => capabilityMismatchFixture(async f => {
  const signal = new AbortController().signal;

  // 1. Isolated verification: restricted reader positive notes pass, whole review workflow refusal
  await verifyRestrictedReaderIsolation(f.readerBuild, signal);

  // 2. Writer enrolls notes-then-review workflow, advances first notes turn, confirms close
  const writerModel = new FakeTestModelBoundary();
  const note1 = 'First observation candidate note.';
  writerModel.setQueuedResponses([makeNotesResponse('w-call-1', note1)]);

  const writerHostRes = await f.writerBuild.createAnswerHost({ ...f.sharedAuthorityConfig, model: writerModel }, signal);
  expect(writerHostRes.kind).toBe('created');
  if (writerHostRes.kind !== 'created') return;
  f.trackHost(writerHostRes.scheduler);

  const enrollRes = await writerHostRes.scheduler.enroll(f.workRequest, signal);
  expect(enrollRes.kind).toBe('enrolled');
  if (enrollRes.kind !== 'enrolled') return;

  const pointer: PersistedHostPointer = writerHostRes.scheduler.hydrator.dehydrate(enrollRes.enrollment);
  expect(pointer.formatVersion).toBe(1);

  // Future review requirements also prevent acquiring the initial notes step.
  const beforeFirstNote = await snapshotStorage(f.journalRootDir);
  const earlyReaderModel = new FakeTestModelBoundary();
  const earlyReader = await f.readerBuild.createAnswerHost({ ...f.sharedAuthorityConfig, model: earlyReaderModel }, signal);
  expect(earlyReader.kind).toBe('created');
  if (earlyReader.kind !== 'created') return;
  f.trackHost(earlyReader.scheduler);
  expect(await earlyReader.scheduler.recover(pointer, signal)).toMatchObject({
    kind: 'refused', reason: 'unsupported_capability', missingOutput: 'wr.contracts.review_verdict',
  });
  expect(earlyReaderModel.callCount).toBe(0);
  await f.closeHost(earlyReader.scheduler);
  expect(await snapshotStorage(f.journalRootDir)).toEqual(beforeFirstNote);

  const turn1 = await enrollRes.runner.runTurn(signal);
  expect(turn1.kind).toBe('advanced');
  if (turn1.kind !== 'advanced') return;
  expect(turn1.nextView.kind).not.toBe('finished');
  expect(writerModel.callCount).toBe(1);
  const receipt1 = turn1.receipt;

  await f.closeHost(writerHostRes.scheduler);

  const sessionEntries = (await readdir(f.journalRootDir, { withFileTypes: true })).filter(e => e.isDirectory());
  expect(sessionEntries).toHaveLength(1);
  const sessionId = asSessionId(sessionEntries[0]!.name);

  // Snapshot canonical sessions and pinned workflows before reader recovery attempt
  const snapSessionAfterWriter = await snapshotStorage(f.journalRootDir);
  const snapPinnedAfterWriter = await snapshotStorage(f.dataDir.pinnedWorkflowsDir());

  // 3. Restricted reader on SAME auth+storage recovers pointer -> unsupported_capability
  const readerModel = new FakeTestModelBoundary();
  const readerHostRes = await f.readerBuild.createAnswerHost({ ...f.sharedAuthorityConfig, model: readerModel }, signal);
  expect(readerHostRes.kind).toBe('created');
  if (readerHostRes.kind !== 'created') return;
  f.trackHost(readerHostRes.scheduler);

  const recoverRes = await readerHostRes.scheduler.recover(pointer, signal);
  expect(recoverRes.kind).toBe('refused');
  if (recoverRes.kind === 'refused') {
    expect(recoverRes.reason).toBe('unsupported_capability');
    if (recoverRes.reason === 'unsupported_capability') {
      expect(recoverRes.missingOutput).toBe('wr.contracts.review_verdict');
      expect(typeof recoverRes.detail).toBe('string');
      expect(recoverRes.detail.length).toBeGreaterThan(0);
      expect((recoverRes as unknown as { runner?: unknown }).runner).toBeUndefined();
      expect((recoverRes as unknown as { enrollment?: unknown }).enrollment).toBeUndefined();
      expect((recoverRes as unknown as { owner?: unknown }).owner).toBeUndefined();
    }
  }
  // Every ownership-acquiring recovery entry point enforces the same build boundary.
  expect(await readerHostRes.scheduler.automaticRecovery.claimUnowned(pointer, signal)).toMatchObject({
    kind: 'refused', reason: 'unsupported_capability', missingOutput: 'wr.contracts.review_verdict',
  });
  expect(await readerHostRes.scheduler.conditionalRecovery.replaceIfCurrent(pointer, enrollRes.owner, signal)).toMatchObject({
    kind: 'refused', reason: 'unsupported_capability', missingOutput: 'wr.contracts.review_verdict',
  });
  expect(readerModel.callCount).toBe(0);

  await f.closeHost(readerHostRes.scheduler);

  // Exact byte comparison: session journal and pinned workflow storage unchanged across reader refusal
  expect(await snapshotStorage(f.journalRootDir)).toEqual(snapSessionAfterWriter);
  expect(await snapshotStorage(f.dataDir.pinnedWorkflowsDir())).toEqual(snapPinnedAfterWriter);

  // 4. Compatible full writer recovers original pointer, inspects receipt 1, answers review to completion
  const writerModel2 = new FakeTestModelBoundary();
  const finding1: ReviewFindingWithEnrichment = {
    severity: 'minor',
    summary: 'Array bounds check allows off-by-one read',
    findingCategory: 'correctness',
    location: {
      file: 'src/buffer-reader.ts',
      line: 42,
    },
    evidence: {
      observed: 'Buffer boundary index exceeds allocated length by 1',
    },
    remedy: {
      recommendation: 'Replace <= with < in buffer limit check',
    },
  };
  const finding2: ReviewFindingPlain = {
    severity: 'minor',
    summary: 'Missing descriptive error message on unexpected EOF',
  };
  const reviewPayload: ReviewAnswerPayload = {
    notes: 'Review complete notes.',
    verdict: 'minor',
    confidence: 'low',
    findings: [finding1, finding2],
    summary: 'Minor review verdict with findings.',
  };
  writerModel2.setQueuedResponses([makeReviewResponse('w-call-2', reviewPayload)]);

  const writerHostRes2 = await f.writerBuild.createAnswerHost({ ...f.sharedAuthorityConfig, model: writerModel2 }, signal);
  expect(writerHostRes2.kind).toBe('created');
  if (writerHostRes2.kind !== 'created') return;
  f.trackHost(writerHostRes2.scheduler);

  const readyRes = await writerHostRes2.scheduler.recover(pointer, signal);
  expect(readyRes.kind).toBe('ready');
  if (readyRes.kind !== 'ready') return;

  const ports = writerHostRes2.scheduler.bindDiagnosticPorts(readyRes.enrollment);

  const turn2 = await readyRes.runner.runTurn(signal);
  expect(turn2.kind).toBe('advanced');
  if (turn2.kind !== 'advanced') return;
  expect(turn2.nextView.kind).toBe('finished');
  if (turn2.nextView.kind !== 'finished') return;
  expect(turn2.nextView.execution.kind).toBe('completed');
  expect(turn2.nextView.retained).toHaveLength(2);
  expect(turn2.nextView.retained[0]!.receipt).toBe(receipt1);
  expect(turn2.nextView.retained[1]!.receipt).toBe(turn2.receipt);

  // Completion reconciliation needs no execution capability or new ownership.
  const settledBefore = await snapshotStorage(f.journalRootDir);
  const terminalModel = new FakeTestModelBoundary();
  const terminalReader = await f.readerBuild.createAnswerHost({ ...f.sharedAuthorityConfig, model: terminalModel }, signal);
  expect(terminalReader.kind).toBe('created');
  if (terminalReader.kind !== 'created') return;
  f.trackHost(terminalReader.scheduler);
  expect(await terminalReader.scheduler.recover(pointer, signal)).toMatchObject({ kind: 'settled', receipt: turn2.receipt });
  expect(terminalModel.callCount).toBe(0);
  await f.closeHost(terminalReader.scheduler);
  expect(await snapshotStorage(f.journalRootDir)).toEqual(settledBefore);

  await verifyReceiptChunk(ports, turn2.nextView.read, receipt1, { notes: note1 }, signal);
  await verifyReceiptChunk(ports, turn2.nextView.read, turn2.receipt, reviewPayload, signal);

  // Materialized review artifact consumed by readVerdictArtifact
  const fsPort = new NodeFileSystemV2();
  const shaPort = new NodeSha256V2();
  const store = new LocalSessionEventLogStoreV2(f.dataDir, fsPort, shaPort);
  const sessionLog = await store.load(sessionId);
  expect(sessionLog.isOk()).toBe(true);
  if (!sessionLog.isOk()) {
    expect.fail(`Failed to load session event log for ${sessionId}`);
  }

  // Verify original notes are retained in the session event log
  const rawNotes = sessionLog.value.events
    .filter((e): e is Extract<typeof e, { kind: 'node_output_appended' }> =>
      e.kind === 'node_output_appended' && (e.data as { payload?: { payloadKind?: string } })?.payload?.payloadKind === 'notes')
    .map(e => (e.data as { payload: { notesMarkdown: string } }).payload.notesMarkdown);
  expect(rawNotes).toEqual([note1, reviewPayload.notes]);

  const rawArtifacts = sessionLog.value.events
    .filter((e): e is Extract<typeof e, { kind: 'node_output_appended' }> =>
      e.kind === 'node_output_appended' && (e.data as { payload?: { payloadKind?: string } })?.payload?.payloadKind === 'artifact_ref')
    .map(e => (e.data as { payload: { content: unknown } }).payload.content);

  expect(rawArtifacts).toHaveLength(1);
  const materialized = rawArtifacts[0];
  const expectedArtifact = {
    kind: 'wr.review_verdict',
    verdict: reviewPayload.verdict,
    confidence: reviewPayload.confidence,
    findings: reviewPayload.findings,
    summary: reviewPayload.summary,
  };
  expect(materialized).toEqual(expectedArtifact);
  expect((materialized as Record<string, unknown>).verdict).toBe('minor');
  expect((materialized as Record<string, unknown>).confidence).toBe('low');
  expect((materialized as Record<string, unknown>).findings).toHaveLength(2);
  expect((materialized as { findings: readonly unknown[] }).findings[0]).toEqual(reviewPayload.findings[0]);
  expect((materialized as { findings: readonly unknown[] }).findings[1]).toEqual(reviewPayload.findings[1]);
  expect(Object.hasOwn((materialized as { findings: readonly Record<string, unknown>[] }).findings[1]!, 'findingCategory')).toBe(false);

  const consumed = readVerdictArtifact(rawArtifacts, sessionId);
  expect(consumed).not.toBeNull();
  expect(consumed).toEqual({
    severity: 'minor',
    findingSummaries: [
      finding1.summary,
      finding2.summary,
    ],
    raw: JSON.stringify(materialized),
    source: 'artifact',
  });

  await f.closeHost(writerHostRes2.scheduler);
}));
