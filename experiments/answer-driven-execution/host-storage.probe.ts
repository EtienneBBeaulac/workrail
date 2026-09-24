/** Candidate host storage acceptance probes for answer-driven execution (DI10).
 * Covers:
 * - Positive control: Valid pending recovery acquires new owner and recovered runner;
 *   fresh final turn advances; completed recovery is settled with exact retained payloads.
 * - POINTER scope: Closed mutants derived from real enrolled pointer refused by both
 *   hydrator and recover without journal mutation or model inference.
 * - CONFIGURED STORE scope: Storage obstruction preserves file bytes and zero model calls;
 *   removing obstruction allows same-factory positive enrollment and completion.
 * - AUTHORITATIVE STORE scope (missing): Loss of generated session storage after first turn
 *   recomposes and refuses with 'missing'; strictly no empty-session fallback or model calls.
 * - INDEX LOSS scope: Loss of host index root recomposes and recovers via direct pointer,
 *   completing execution with exact original retained and fresh payloads.
 *
 * Production module 'src/answer-v1/host.ts' is currently absent.
 * Per probe contract, module absence fails explicitly with 'runtime_unavailable: src/answer-v1/host.ts'.
 * Import errors in an existing module propagate as runtime_error. Tests never skip or pass.
 */
import 'reflect-metadata';
import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type {
  AnswerHostConfig, HostJournalStorageConfig, HostWorkRequest,
  ModelCompletionResult, ModelInferenceBoundary, ModelPromptInput,
} from './host-composition.js';
import type { HostExecutorPorts, RawModelResponse } from './invocation-contract.js';
import type { ReadRef, ReceiptRef } from './answer-contract.js';

const PRODUCTION_MODULE_PATH = 'src/answer-v1/host.ts';

async function loadCandidateHostFactory(): Promise<typeof import('./host-composition.js').createAnswerHost> {
  const absPath = resolve(process.cwd(), PRODUCTION_MODULE_PATH);
  try { await stat(absPath); } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      expect.fail(`runtime_unavailable: ${PRODUCTION_MODULE_PATH} (module file does not exist at ${absPath})`);
    }
    throw err;
  }
  let mod: { createAnswerHost?: typeof import('./host-composition.js').createAnswerHost };
  try { mod = await import(/* @vite-ignore */ absPath); } catch (err: unknown) {
    const detail = err instanceof Error ? err.stack ?? err.message : String(err);
    expect.fail(`runtime_error: ${PRODUCTION_MODULE_PATH} (${detail})`);
  }
  if (!mod || typeof mod.createAnswerHost !== 'function') {
    expect.fail(`runtime_error: ${PRODUCTION_MODULE_PATH} (missing createAnswerHost export)`);
  }
  return mod.createAnswerHost;
}

function makeAnswerResponse(callId: string, notes: string): RawModelResponse {
  return { responseText: notes, calls: [{ id: callId, name: 'answer_work', argumentsJson: JSON.stringify({ answer: { notes } }) }] };
}

async function verifyReceiptChunk(ports: HostExecutorPorts, readRef: ReadRef, receipt: ReceiptRef, notes: string, signal: AbortSignal): Promise<void> {
  const read = await ports.inspector.inspectReceipt(readRef, receipt, signal);
  expect(read.kind).toBe('complete');
  if (read.kind === 'complete') {
    expect(read.disposition).toBe('accepted');
    expect(read.receipt).toBe(receipt);
    expect(JSON.parse(read.chunk)).toEqual({ notes });
  }
}

class FakeTestModelBoundary implements ModelInferenceBoundary {
  public callCount = 0;
  public promptHistory: ModelPromptInput[] = [];
  private queued: RawModelResponse[] = [];
  setQueuedResponses(responses: RawModelResponse[]): void { this.queued = [...responses]; }
  async generate(input: ModelPromptInput, signal: AbortSignal): Promise<ModelCompletionResult> {
    this.callCount++;
    this.promptHistory.push(input);
    if (signal.aborted) return { kind: 'cancelled' };
    const next = this.queued.shift();
    return next ? { kind: 'completed', response: next } : { kind: 'unavailable', detail: 'No queued model response' };
  }
}

interface StorageFixtureContext {
  root: string;
  storageConfig: HostJournalStorageConfig;
  workflowsDir: string;
  workRequest: HostWorkRequest;
  loadFactory: () => Promise<typeof import('./host-composition.js').createAnswerHost>;
  snapshotFiles: (dir?: string) => Promise<Record<string, string>>;
}

async function storageFixture(run: (f: StorageFixtureContext) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'workrail-host-storage-acceptance-'));
  const journalRootDir = join(root, 'answer-v1', 'sessions');
  const hostIndexRootDir = join(root, 'answer-v1', 'host-index');
  const workflowsDir = join(root, 'workflows');

  await Promise.all([
    mkdir(journalRootDir, { recursive: true }),
    mkdir(hostIndexRootDir, { recursive: true }),
    mkdir(workflowsDir, { recursive: true }),
  ]);

  const twoStepWorkflowDefinition = {
    id: 'two-step-test', name: 'Two Step Storage Acceptance Workflow',
    description: 'Actual two-step workflow for host storage intake probes', version: '1.0.0',
    steps: [
      { id: 'step-1', title: 'Step 1: First Observation', prompt: 'Record first observation.' },
      { id: 'step-2', title: 'Step 2: Second Observation', prompt: 'Record second observation.' },
    ],
  };
  await writeFile(join(workflowsDir, 'two-step-test.json'), JSON.stringify(twoStepWorkflowDefinition, null, 2), 'utf8');

  const snapshotFiles = async (dir = journalRootDir): Promise<Record<string, string>> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') return { [dir]: '<absent>' };
      throw err;
    }
    const result: Record<string, string> = { [dir]: '<directory>' };
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) Object.assign(result, await snapshotFiles(fullPath));
      else result[fullPath] = (await readFile(fullPath)).toString('base64');
    }
    return result;
  };

  try {
    await run({
      root, storageConfig: { journalRootDir, hostIndexRootDir }, workflowsDir,
      workRequest: { workflowId: 'two-step-test', goal: 'DI10 storage acceptance run', workspacePath: root },
      loadFactory: loadCandidateHostFactory, snapshotFiles,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. Positive Control: Pending recovery acquires new owner; completed is settled
// ---------------------------------------------------------------------------
it('positive control: pending recovery completes exact payloads; settled recovery preserves journal bytes', () => storageFixture(async f => {
  const createAnswerHost = await f.loadFactory();
  const fakeModel = new FakeTestModelBoundary();
  fakeModel.setQueuedResponses([makeAnswerResponse('c1', 'Step 1 real notes'), makeAnswerResponse('c2', 'Step 2 real notes')]);

  const signal = new AbortController().signal;
  const hostResult = await createAnswerHost({ storage: f.storageConfig, keyringPath: join(f.root, 'keys', 'keyring.json'), workflowStoragePath: f.workflowsDir, model: fakeModel }, signal);
  expect(hostResult.kind).toBe('created');
  if (hostResult.kind !== 'created') return;

  const scheduler = hostResult.scheduler;
  const enrollResult = await scheduler.enroll(f.workRequest, signal);
  expect(enrollResult.kind).toBe('enrolled');
  if (enrollResult.kind !== 'enrolled') return;

  const { runner: initialRunner, initialView, enrollment } = enrollResult;
  expect(initialView.kind).toBe('question');
  if (initialView.kind !== 'question') return;
  expect(initialView.retained).toHaveLength(0);

  const pointer = scheduler.hydrator.dehydrate(enrollment);
  expect(pointer.formatVersion).toBe(1);
  expect(typeof pointer.executionId).toBe('string');
  expect(typeof pointer.recoveryLocator).toBe('string');

  // Turn 1 on initial runner advances to successor step-2 question
  const turn1 = await initialRunner.runTurn(signal);
  expect(turn1.kind).toBe('advanced');
  if (turn1.kind !== 'advanced') return;
  expect(turn1.nextView.kind).toBe('question');
  if (turn1.nextView.kind !== 'question') return;
  expect(turn1.nextView.retained).toHaveLength(1);
  const receipt1 = turn1.receipt;
  expect(turn1.nextView.retained[0]!.receipt).toBe(receipt1);

  expect(fakeModel.callCount).toBe(1);
  expect(fakeModel.promptHistory[0]).toEqual({
    instruction: initialView.instruction, issues: initialView.issues, retainedSummaries: initialView.retained,
  });

  // Pending recovery acquires a NEW owner and returns a fresh runner.
  // Never assert unchanged journal bytes here (ownership record changes).
  const recoveredPending = await scheduler.recover(pointer, signal);
  expect(recoveredPending.kind).toBe('ready');
  if (recoveredPending.kind !== 'ready') return;
  expect(recoveredPending.owner.execution).toBe(enrollment.execution);

  // Never run initial runner after recovery: use recovered runner for fresh final turn
  const turn2 = await recoveredPending.runner.runTurn(signal);
  expect(turn2.kind).toBe('advanced');
  if (turn2.kind !== 'advanced') return;
  expect(turn2.nextView.kind).toBe('finished');
  if (turn2.nextView.kind !== 'finished') return;

  expect(turn2.nextView.execution.kind).toBe('completed');
  expect(turn2.nextView.taskOutcome).toBe('unknown');
  expect(turn2.nextView.retained).toHaveLength(2);
  expect(turn2.nextView.execution.kind).toBe('completed');
  expect(turn2.nextView.taskOutcome).toBe('unknown');
  const receipt2 = turn2.receipt;
  expect(receipt1).not.toBe(receipt2);
  expect(turn2.nextView.retained[0]!.receipt).toBe(receipt1);
  expect(turn2.nextView.retained[1]!.receipt).toBe(receipt2);

  expect(fakeModel.callCount).toBe(2);
  expect(fakeModel.promptHistory[1]).toEqual({
    instruction: turn1.nextView.instruction, issues: turn1.nextView.issues, retainedSummaries: turn1.nextView.retained,
  });

  // Inspect exact returned accepted receipts/payloads via diagnostic inspector
  const ports = scheduler.bindDiagnosticPorts(enrollment);
  await verifyReceiptChunk(ports, turn2.nextView.read, receipt1, 'Step 1 real notes', signal);
  await verifyReceiptChunk(ports, turn2.nextView.read, receipt2, 'Step 2 real notes', signal);

  // Completed session recovery returns settled with exact final receipt and view
  const snapBeforeSettled = await f.snapshotFiles();
  const recoveredSettled = await scheduler.recover(pointer, signal);
  expect(recoveredSettled.kind).toBe('settled');
  if (recoveredSettled.kind === 'settled') {
    expect(recoveredSettled.receipt).toBe(receipt2);
    expect(recoveredSettled.view.kind).toBe('finished');
    expect(recoveredSettled.view).toEqual(turn2.nextView);
  }
  const snapAfterSettled = await f.snapshotFiles();
  expect(snapAfterSettled).toEqual(snapBeforeSettled);
  expect(fakeModel.callCount).toBe(2);
}));

// ---------------------------------------------------------------------------
// 2. POINTER scope: Closed mutants derived from real enrolled pointer refused
// ---------------------------------------------------------------------------
it('POINTER scope: closed pointer mutants refused without journal mutation or model calls', () => storageFixture(async f => {
  const createAnswerHost = await f.loadFactory();
  const signal = new AbortController().signal;
  const fakeModel = new FakeTestModelBoundary();
  const hostResult = await createAnswerHost({ storage: f.storageConfig, keyringPath: join(f.root, 'keys', 'keyring.json'), workflowStoragePath: f.workflowsDir, model: fakeModel }, signal);
  expect(hostResult.kind).toBe('created');
  if (hostResult.kind !== 'created') return;

  const { scheduler } = hostResult;
  const enrollResult = await scheduler.enroll(f.workRequest, signal);
  expect(enrollResult.kind).toBe('enrolled');
  if (enrollResult.kind !== 'enrolled') return;

  // Derive mutants from actual valid hydrated/dehydrated pointer of enrolled session
  const validPointer = scheduler.hydrator.dehydrate(enrollResult.enrollment);
  expect(validPointer.formatVersion).toBe(1);

  const mutants: Array<{ label: string; value: unknown; expectedReason: 'corrupt' | 'unsupported_version' }> = [
    { label: 'primitive string', value: 'not_a_valid_pointer', expectedReason: 'corrupt' },
    { label: 'primitive null', value: null, expectedReason: 'corrupt' },
    { label: 'primitive number', value: 42, expectedReason: 'corrupt' },
    { label: 'array', value: [validPointer], expectedReason: 'corrupt' },
    { label: 'missing recoveryLocator', value: (({ recoveryLocator: _, ...r }) => r)(validPointer), expectedReason: 'corrupt' },
    { label: 'missing executionId', value: (({ executionId: _, ...r }) => r)(validPointer), expectedReason: 'corrupt' },
    { label: 'unsupported formatVersion 99', value: { ...validPointer, formatVersion: 99 }, expectedReason: 'unsupported_version' },
    { label: 'forbidden owner field', value: { ...validPointer, owner: 'forbidden_owner' }, expectedReason: 'corrupt' },
    { label: 'forbidden fence field', value: { ...validPointer, fence: 'forbidden_fence' }, expectedReason: 'corrupt' },
    { label: 'forbidden epoch field', value: { ...validPointer, epoch: 1 }, expectedReason: 'corrupt' },
    { label: 'forbidden lease field', value: { ...validPointer, lease: 'forbidden_lease' }, expectedReason: 'corrupt' },
  ];

  const snapBefore = await f.snapshotFiles();
  const modelCallsBefore = fakeModel.callCount;

  for (const mutant of mutants) {
    const hydrated = await scheduler.hydrator.hydrate(mutant.value, signal);
    expect(hydrated.kind).toBe('refused');
    if (hydrated.kind === 'refused') expect(hydrated.reason).toBe(mutant.expectedReason);

    const recovered = await scheduler.recover(mutant.value, signal);
    expect(recovered.kind).toBe('refused');
    if (recovered.kind === 'refused') expect(recovered.reason).toBe(mutant.expectedReason);
  }

  // Snapshot verifies no journal mutation (not a claim of zero filesystem I/O)
  const snapAfter = await f.snapshotFiles();
  expect(snapAfter).toEqual(snapBefore);
  expect(fakeModel.callCount).toBe(modelCallsBefore);
}));

// ---------------------------------------------------------------------------
// 3. CONFIGURED STORE scope: Storage obstruction preserves bytes and completes after removal
// ---------------------------------------------------------------------------
it('CONFIGURED STORE scope: storage obstruction preserves file bytes and recovers on clean config', () => storageFixture(async f => {
  const createAnswerHost = await f.loadFactory();
  const signal = new AbortController().signal;

  const blockingFile = join(f.root, 'file_blocking_journal_dir');
  const blockingContent = 'portable_filesystem_obstruction_payload';
  await writeFile(blockingFile, blockingContent, 'utf8');

  const obstructedStorage: HostJournalStorageConfig = {
    journalRootDir: join(blockingFile, 'sessions'),
    hostIndexRootDir: f.storageConfig.hostIndexRootDir,
  };

  const fakeModel = new FakeTestModelBoundary();
  fakeModel.setQueuedResponses([makeAnswerResponse('c1', 'Obs step 1'), makeAnswerResponse('c2', 'Obs step 2')]);

  const hostResult = await createAnswerHost({ storage: obstructedStorage, keyringPath: join(f.root, 'keys', 'keyring.json'), workflowStoragePath: f.workflowsDir, model: fakeModel }, signal);
  if (hostResult.kind === 'refused') {
    expect(hostResult.reason).toBe('storage_unavailable');
  } else {
    expect(hostResult.kind).toBe('created');
    if (hostResult.kind !== 'created') return;
    const enrollResult = await hostResult.scheduler.enroll(f.workRequest, signal);
    expect(enrollResult.kind).toBe('refused');
    if (enrollResult.kind === 'refused') expect(enrollResult.reason).toBe('storage_unavailable');
  }

  // Obstruction preserves file bytes and zero model calls
  expect(await readFile(blockingFile, 'utf8')).toBe(blockingContent);
  expect(fakeModel.callCount).toBe(0);

  // Remove ONLY own obstruction
  await rm(blockingFile, { force: true });

  // Correct config positive same-factory enroll and complete
  const validHostResult = await createAnswerHost({ storage: obstructedStorage, keyringPath: join(f.root, 'keys', 'keyring.json'), workflowStoragePath: f.workflowsDir, model: fakeModel }, signal);
  expect(validHostResult.kind).toBe('created');
  if (validHostResult.kind !== 'created') return;

  const validEnroll = await validHostResult.scheduler.enroll(f.workRequest, signal);
  expect(validEnroll.kind).toBe('enrolled');
  if (validEnroll.kind !== 'enrolled') return;

  const turn1 = await validEnroll.runner.runTurn(signal);
  expect(turn1.kind).toBe('advanced');
  const turn2 = await validEnroll.runner.runTurn(signal);
  expect(turn2.kind).toBe('advanced');
  if (turn1.kind !== 'advanced' || turn2.kind !== 'advanced') return;
  expect(turn2.nextView.kind).toBe('finished');
  if (turn2.nextView.kind !== 'finished') return;
  expect(turn2.nextView.execution.kind).toBe('completed');
  expect(turn2.nextView.taskOutcome).toBe('unknown');
  expect(turn2.receipt).not.toBe(turn1.receipt);
  expect(turn2.nextView.retained.map(r => r.receipt)).toEqual([turn1.receipt, turn2.receipt]);
  const ports = validHostResult.scheduler.bindDiagnosticPorts(validEnroll.enrollment);
  await verifyReceiptChunk(ports, turn2.nextView.read, turn1.receipt, 'Obs step 1', signal);
  await verifyReceiptChunk(ports, turn2.nextView.read, turn2.receipt, 'Obs step 2', signal);
  expect(fakeModel.callCount).toBe(2);
}));

// ---------------------------------------------------------------------------
// 4. AUTHORITATIVE STORE scope (missing): Loss of journal refused with no empty fallback
// ---------------------------------------------------------------------------
it('AUTHORITATIVE STORE scope (missing): loss of session journal refused with no empty fallback', () => storageFixture(async f => {
  const createAnswerHost = await f.loadFactory();
  const signal = new AbortController().signal;
  const fakeModel = new FakeTestModelBoundary();
  fakeModel.setQueuedResponses([makeAnswerResponse('c1', 'Step 1 accepted')]);

  const hostResult = await createAnswerHost({ storage: f.storageConfig, keyringPath: join(f.root, 'keys', 'keyring.json'), workflowStoragePath: f.workflowsDir, model: fakeModel }, signal);
  expect(hostResult.kind).toBe('created');
  if (hostResult.kind !== 'created') return;

  const enrollResult = await hostResult.scheduler.enroll(f.workRequest, signal);
  expect(enrollResult.kind).toBe('enrolled');
  if (enrollResult.kind !== 'enrolled') return;

  // Perform actual first accepted turn
  const turn1 = await enrollResult.runner.runTurn(signal);
  expect(turn1.kind).toBe('advanced');
  if (turn1.kind !== 'advanced') return;
  expect(fakeModel.callCount).toBe(1);

  // Get pointer from enrolled session
  const pointer = hostResult.scheduler.hydrator.dehydrate(enrollResult.enrollment);

  // Wipe own synthetic root
  await rm(f.storageConfig.journalRootDir, { recursive: true, force: true });
  await mkdir(f.storageConfig.journalRootDir, { recursive: true });

  // Recompose new factory before recover
  const recomposedFactory = await f.loadFactory();
  const recomposedHost = await recomposedFactory({ storage: f.storageConfig, keyringPath: join(f.root, 'keys', 'keyring.json'), workflowStoragePath: f.workflowsDir, model: fakeModel }, signal);
  expect(recomposedHost.kind).toBe('created');
  if (recomposedHost.kind !== 'created') return;

  const snapBefore = await f.snapshotFiles();
  const modelCallsBefore = fakeModel.callCount;

  // Recover on missing journal: explicit missing, strictly no empty fallback, no inference
  const recoverResult = await recomposedHost.scheduler.recover(pointer, signal);
  expect(recoverResult.kind).toBe('refused');
  if (recoverResult.kind === 'refused') expect(recoverResult.reason).toBe('missing');

  expect(fakeModel.callCount).toBe(modelCallsBefore);
  const snapAfter = await f.snapshotFiles();
  expect(snapAfter).toEqual(snapBefore);
}));

// ---------------------------------------------------------------------------
// 5. INDEX LOSS scope: Direct pointer recovery succeeds after host index wipe
// ---------------------------------------------------------------------------
it('INDEX LOSS scope: direct pointer recovery after index loss completes original and fresh payloads', () => storageFixture(async f => {
  const createAnswerHost = await f.loadFactory();
  const signal = new AbortController().signal;
  const fakeModel = new FakeTestModelBoundary();
  fakeModel.setQueuedResponses([makeAnswerResponse('c1', 'Step 1 original note'), makeAnswerResponse('c2', 'Step 2 fresh note')]);

  const hostResult = await createAnswerHost({ storage: f.storageConfig, keyringPath: join(f.root, 'keys', 'keyring.json'), workflowStoragePath: f.workflowsDir, model: fakeModel }, signal);
  expect(hostResult.kind).toBe('created');
  if (hostResult.kind !== 'created') return;

  const enrollResult = await hostResult.scheduler.enroll(f.workRequest, signal);
  expect(enrollResult.kind).toBe('enrolled');
  if (enrollResult.kind !== 'enrolled') return;

  // Turn 1: progress to step 2 with first accepted receipt
  const turn1 = await enrollResult.runner.runTurn(signal);
  expect(turn1.kind).toBe('advanced');
  if (turn1.kind !== 'advanced') return;
  const receipt1 = turn1.receipt;

  const pointer = hostResult.scheduler.hydrator.dehydrate(enrollResult.enrollment);

  // Wipe host index root dir completely while leaving journal root dir intact
  await rm(f.storageConfig.hostIndexRootDir, { recursive: true, force: true });
  await mkdir(f.storageConfig.hostIndexRootDir, { recursive: true });

  // Recompose host against same storage roots
  const recomposedFactory = await f.loadFactory();
  const recomposedHost = await recomposedFactory({ storage: f.storageConfig, keyringPath: join(f.root, 'keys', 'keyring.json'), workflowStoragePath: f.workflowsDir, model: fakeModel }, signal);
  expect(recomposedHost.kind).toBe('created');
  if (recomposedHost.kind !== 'created') return;

  // Direct pointer recovery succeeds independently of host index
  const recoverResult = await recomposedHost.scheduler.recover(pointer, signal);
  expect(recoverResult.kind).toBe('ready');
  if (recoverResult.kind !== 'ready') return;

  // Complete step 2 with recovered runner
  const turn2 = await recoverResult.runner.runTurn(signal);
  expect(turn2.kind).toBe('advanced');
  if (turn2.kind !== 'advanced') return;
  expect(turn2.nextView.kind).toBe('finished');
  if (turn2.nextView.kind !== 'finished') return;

  expect(turn2.nextView.execution.kind).toBe('completed');
  expect(turn2.nextView.taskOutcome).toBe('unknown');
  const receipt2 = turn2.receipt;
  expect(receipt1).not.toBe(receipt2);
  expect(turn2.nextView.retained).toHaveLength(2);
  expect(turn2.nextView.retained[0]!.receipt).toBe(receipt1);
  expect(turn2.nextView.retained[1]!.receipt).toBe(receipt2);

  // Inspect exact original retained and fresh payloads
  const ports = recomposedHost.scheduler.bindDiagnosticPorts(recoverResult.enrollment);
  await verifyReceiptChunk(ports, turn2.nextView.read, receipt1, 'Step 1 original note', signal);
  await verifyReceiptChunk(ports, turn2.nextView.read, receipt2, 'Step 2 fresh note', signal);

  expect(fakeModel.callCount).toBe(2);
}));
