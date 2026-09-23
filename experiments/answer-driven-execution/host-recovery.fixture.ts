/** Real multi-process acceptance fixture for answer-driven host recovery.
 * Covers:
 * - harness_control: Subprocess lifecycle, atomic barrier, SIGKILL interruption, and fresh reader rehydration.
 * - DI2: Delivery durable, no captured response; atomic redelivery (D1 -> D2), capture refusal of abandoned D1
 *        (invalid_delivery), fresh capture/prepare/dispatch on D2, and second-step advancement to completion.
 * - di2_runner: Public-runner-only recovery for durable delivery without captured response;
 *               fresh reader calls scheduler.recover(pointer) and recovered.runner.runTurn twice
 *               with queued fresh first and second responses, no diagnostic pre-recovery,
 *               advances with exact two distinct receipts, parsed notes, and modelCallCount 2.
 * - DI5: Engine commits, before caller receives result; fault seam after_engine_commit barrier blocks for
 *        SIGKILL, fresh reader recovers original accepted receipt and exact first payload, byte-identical
 *        journal across repeated recovery, no inference before successor delivery, exact two distinct notes.
 * - DI9: Stop commits before recovered dispatch; scheduler recovery returns stopped with exact reason/detail,
 *        inspector reads stopped state, zero inference/dispatch, no recovered execution.
 * - di9_unstopped: Valid unstopped prepared invocation control; replays prepared response once on restart,
 *                  verifies recovered PreparedAnswer against barrier original reply/invocation/response IDs
 *                  (DI4 original payload/opportunity mapping), completes successor with exact receipts and
 *                  single reader inference call.
 * - di4_runner: Public-runner-only recovery for prepared-before-dispatch interruption; fresh reader calls
 *               scheduler.recover(pointer) and recovered.runner.runTurn without diagnostic recovery,
 *               dispatches retained original without model call, completes successor with single reader
 *               inference call, exact distinct receipts, and verified retained payloads.
 * - di5_runner: Public-runner-only recovery for after-engine-commit interruption; fresh reader calls
 *               scheduler.recover(pointer) and recovered.runner.runTurn without diagnostic recovery,
 *               delivers fresh successor without repeating first model inference, exact final two notes.
 *
 * Real candidate factory 'src/answer-v1/host.ts' is absent. ENOENT is classified as runtime_unavailable.
 * Import errors in an existing module propagate as runtime_error. Tests never skip or pass absent runtime.
 */
import 'reflect-metadata';
import { expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type {
  AnswerHostConfig,
  DurableJournalFaultSeam,
  HostJournalStorageConfig,
  HostWorkRequest,
  JournalFaultAction,
  JournalFaultBoundary,
  ModelCompletionResult,
  ModelInferenceBoundary,
  ModelPromptInput,
  PersistedHostPointer,
} from './host-composition.js';
import type {
  DeliveryRef,
  ExecutionRef,
  RawModelResponse,
} from './invocation-contract.js';

const PRODUCTION_MODULE_PATH = 'src/answer-v1/host.ts';

/** Loads the production module factory. Fails via explicit assertion when absent. */
async function loadCandidateHostFactory(): Promise<typeof import('./host-composition.js').createAnswerHost> {
  const absoluteSourcePath = resolve(process.cwd(), PRODUCTION_MODULE_PATH);
  try {
    await fsp.stat(absoluteSourcePath);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      expect.fail(`runtime_unavailable: ${PRODUCTION_MODULE_PATH} (module file does not exist at ${absoluteSourcePath})`);
    }
    throw err;
  }

  let mod: { createAnswerHost?: typeof import('./host-composition.js').createAnswerHost };
  try {
    mod = await import(/* @vite-ignore */ absoluteSourcePath);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.stack ?? err.message : String(err);
    expect.fail(`runtime_error: ${PRODUCTION_MODULE_PATH} (${detail})`);
  }
  if (!mod || typeof mod.createAnswerHost !== 'function') {
    expect.fail(`runtime_error: ${PRODUCTION_MODULE_PATH} (missing createAnswerHost export)`);
  }
  return mod.createAnswerHost;
}

/** Injected fake model boundary for testing. Engine and journal remain real. */
class FakeTestModelBoundary implements ModelInferenceBoundary {
  public callCount = 0;
  public promptHistory: ModelPromptInput[] = [];
  private queuedResponses: RawModelResponse[] = [];

  setQueuedResponses(responses: RawModelResponse[]): void {
    this.queuedResponses = [...responses];
  }

  async generate(input: ModelPromptInput, signal: AbortSignal): Promise<ModelCompletionResult> {
    this.callCount++;
    this.promptHistory.push(input);

    if (signal.aborted) {
      return { kind: 'cancelled' };
    }

    const nextResponse = this.queuedResponses.shift();
    if (nextResponse) {
      return { kind: 'completed', response: nextResponse };
    }

    return {
      kind: 'unavailable',
      detail: 'No queued model response available in test fixture; fallback forbidden',
    };
  }
}

const firstNotes = 'First step substantive observation notes.';
const secondNotes = 'Second step substantive observation notes.';

const firstResponse: RawModelResponse = {
  responseText: 'Step 1 response',
  calls: [{
    id: 'call_1',
    name: 'answer_work',
    argumentsJson: JSON.stringify({ answer: { notes: firstNotes } }),
  }],
};

const secondResponse: RawModelResponse = {
  responseText: 'Step 2 response',
  calls: [{
    id: 'call_2',
    name: 'answer_work',
    argumentsJson: JSON.stringify({ answer: { notes: secondNotes } }),
  }],
};

async function setupWorkflow(workflowsDir: string): Promise<string> {
  await fsp.mkdir(workflowsDir, { recursive: true });
  const twoStepWorkflowDefinition = {
    id: 'two-step-test',
    name: 'Two Step Acceptance Test Workflow',
    description: 'Actual two-step workflow for host recovery acceptance probes',
    version: '1.0.0',
    steps: [
      {
        id: 'step-1',
        title: 'Step 1: First Observation',
        prompt: 'Record first observation.',
      },
      {
        id: 'step-2',
        title: 'Step 2: Second Observation',
        prompt: 'Record second observation.',
      },
    ],
  };
  const workflowPath = join(workflowsDir, 'two-step-test.json');
  await fsp.writeFile(workflowPath, JSON.stringify(twoStepWorkflowDefinition, null, 2), 'utf8');
  return workflowPath;
}

async function snapshotFiles(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  if (!fs.existsSync(dir)) return result;
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(result, await snapshotFiles(full));
    } else {
      result[full] = (await fsp.readFile(full)).toString('base64');
    }
  }
  return result;
}

function writeBarrierAndBlock(barrierPath: string, payload: Record<string, unknown>): void {
  const tmpBarrier = `${barrierPath}.tmp`;
  fs.writeFileSync(tmpBarrier, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmpBarrier, barrierPath);

  // Synchronously block until killed by SIGKILL from parent
  const sab = new SharedArrayBuffer(4);
  const int32 = new Int32Array(sab);
  while (true) {
    Atomics.wait(int32, 0, 0, 1000);
  }
}

async function verifyRetainedReceiptsAndRecordObservation(params: {
  root: string;
  caseType: string;
  runNonce: string;
  writerPid: number;
  scheduler: import('./host-composition.js').TrustedAnswerScheduler;
  enrollment: import('./invocation-contract.js').HostEnrollment;
  finalView: Extract<import('./answer-contract.js').WorkView, { kind: 'finished' }>;
  step1Receipt: import('./answer-contract.js').ReceiptRef;
  step2Receipt: import('./answer-contract.js').ReceiptRef;
  modelCallCount: number;
  signal: AbortSignal;
}): Promise<void> {
  const { root, caseType, runNonce, writerPid, scheduler, enrollment, finalView, step1Receipt, step2Receipt, modelCallCount, signal } = params;
  const ports = scheduler.bindDiagnosticPorts(enrollment);
  const read1 = await ports.inspector.inspectReceipt(finalView.read, step1Receipt, signal);
  const read2 = await ports.inspector.inspectReceipt(finalView.read, step2Receipt, signal);
  expect(read1.kind).toBe('complete');
  expect(read2.kind).toBe('complete');
  if (read1.kind !== 'complete' || read2.kind !== 'complete') return;
  expect(read1.disposition).toBe('accepted');
  expect(read2.disposition).toBe('accepted');
  expect(read1.receipt).toBe(step1Receipt);
  expect(read2.receipt).toBe(step2Receipt);

  const parsed1 = JSON.parse(read1.chunk) as { notes: string };
  const parsed2 = JSON.parse(read2.chunk) as { notes: string };
  expect(parsed1).toEqual({ notes: firstNotes });
  expect(parsed2).toEqual({ notes: secondNotes });

  const obs = {
    caseType,
    phase: 'read',
    runNonce,
    readerPid: process.pid,
    writerPid,
    success: true,
    retainedReceiptCount: 2,
    receipts: [
      { id: step1Receipt, disposition: read1.disposition },
      { id: step2Receipt, disposition: read2.disposition },
    ],
    distinctReceipts: step1Receipt !== step2Receipt,
    modelCallCount,
    finalExecution: finalView.execution.kind,
    finalTaskOutcome: finalView.taskOutcome,
    materializedNotes: [parsed1.notes, parsed2.notes],
  };
  await fsp.writeFile(join(root, 'reader-observation.json'), JSON.stringify(obs, null, 2), 'utf8');
}

it('exercises host process recovery with real child processes and durable barriers', async () => {
  const root = process.env.WORKRAIL_RESTART_ROOT;
  const phase = process.env.WORKRAIL_RESTART_PHASE;
  const caseType = process.env.WORKRAIL_RESTART_CASE;
  const runNonce = process.env.WORKRAIL_RESTART_NONCE;

  if (!root || !['write', 'read'].includes(phase ?? '') || !caseType || !runNonce) {
    throw new Error('Use host-recovery.py to run this fixture in isolated subprocesses with required env');
  }

  // -------------------------------------------------------------------------
  // Case 0: Harness-only control exercising lifecycle independent of candidate
  // -------------------------------------------------------------------------
  if (caseType === 'harness_control') {
    if (phase === 'write') {
      const storageDir = join(root, 'storage');
      await fsp.mkdir(storageDir, { recursive: true });
      const payloadBytes = Buffer.from('harness control substantive data', 'utf8');
      await fsp.writeFile(join(storageDir, 'barrier.txt'), payloadBytes);
      writeBarrierAndBlock(join(root, 'barrier.json'), {
        ready: true,
        caseType: 'harness_control',
        phase: 'write',
        runNonce,
        writerPid: process.pid,
        recordedAt: Date.now(),
      });
    } else if (phase === 'read') {
      const barrierPath = join(root, 'barrier.json');
      if (!fs.existsSync(barrierPath)) {
        throw new Error(`Barrier missing in harness_control reader: ${barrierPath}`);
      }
      const barrier = JSON.parse(await fsp.readFile(barrierPath, 'utf8'));
      expect(barrier.ready).toBe(true);
      expect(barrier.caseType).toBe('harness_control');
      expect(barrier.phase).toBe('write');
      expect(barrier.runNonce).toBe(runNonce);
      expect(typeof barrier.writerPid).toBe('number');
      expect(process.pid).not.toBe(barrier.writerPid); // reader PID must differ from writer PID

      const storageFile = join(root, 'storage', 'barrier.txt');
      expect(fs.existsSync(storageFile)).toBe(true);
      const actualBytes = await fsp.readFile(storageFile);
      expect(actualBytes.toString('utf8')).toBe('harness control substantive data');

      const obs = {
        caseType: 'harness_control',
        phase: 'read',
        runNonce,
        readerPid: process.pid,
        writerPid: barrier.writerPid,
        success: true,
        barrierObserved: true,
        storageIntact: true,
        storageBytesMatched: true,
      };
      await fsp.writeFile(join(root, 'reader-observation.json'), JSON.stringify(obs, null, 2), 'utf8');
    }
    return;
  }

  // -------------------------------------------------------------------------
  // Case 1: DI2 and di2_runner - Delivery durable, no captured response
  // -------------------------------------------------------------------------
  if (caseType === 'di2' || caseType === 'di2_runner') {
    if (phase === 'write') {
      const createAnswerHost = await loadCandidateHostFactory();
      const workflowsDir = join(root, 'workflows');
      await setupWorkflow(workflowsDir);
      const journalRootDir = join(root, 'data', 'answer-v1', 'sessions');
      const hostIndexRootDir = join(root, 'data', 'answer-v1', 'host-index');
      await fsp.mkdir(journalRootDir, { recursive: true });
      await fsp.mkdir(hostIndexRootDir, { recursive: true });
      const storageConfig: HostJournalStorageConfig = { journalRootDir, hostIndexRootDir };

      const fakeModel = new FakeTestModelBoundary();
      const config: AnswerHostConfig = {
        storage: storageConfig,
        keyringPath: join(root, 'keys', 'keyring.json'), workflowStoragePath: workflowsDir,
        model: fakeModel,
      };

      const signal = new AbortController().signal;
      const hostResult = await createAnswerHost(config, signal);
      expect(hostResult.kind).toBe('created');
      if (hostResult.kind !== 'created') return;

      const scheduler = hostResult.scheduler;
      const workRequest: HostWorkRequest = {
        workflowId: 'two-step-test',
        goal: `${caseType} acceptance probe`,
        workspacePath: root,
      };

      const enrollResult = await scheduler.enroll(workRequest, signal);
      expect(enrollResult.kind).toBe('enrolled');
      if (enrollResult.kind !== 'enrolled') return;

      const { enrollment, initialView, owner } = enrollResult;
      expect(initialView.kind).toBe('question');
      if (initialView.kind !== 'question') return;

      // Serializes ONLY versioned pointer strictly with formatVersion, executionId, recoveryLocator
      const pointer: PersistedHostPointer = scheduler.hydrator.dehydrate(enrollment);
      expect(pointer.formatVersion).toBe(1);
      expect(typeof pointer.executionId).toBe('string');
      expect(typeof pointer.recoveryLocator).toBe('string');
      expect('owner' in pointer).toBe(false);
      expect('fence' in pointer).toBe(false);
      expect('epoch' in pointer).toBe(false);
      expect('lease' in pointer).toBe(false);
      const allowedPointerKeys = new Set(['formatVersion', 'executionId', 'recoveryLocator']);
      for (const k of Object.keys(pointer)) {
        expect(allowedPointerKeys.has(k), `Pointer key ${k} forbidden`).toBe(true);
      }

      await fsp.writeFile(join(root, 'pointer.json'), JSON.stringify(pointer, null, 2), 'utf8');

      const ports = scheduler.bindDiagnosticPorts(enrollment);
      const deliveryResult = await ports.journal.appendDelivery(initialView.reply, owner, signal);
      expect(deliveryResult.kind).toBe('delivered');
      if (deliveryResult.kind !== 'delivered') return;
      const d1 = deliveryResult.delivery;

      writeBarrierAndBlock(join(root, 'barrier.json'), {
        ready: true,
        caseType,
        phase: 'write',
        runNonce,
        writerPid: process.pid,
        d1,
        recordedAt: Date.now(),
      });
    } else if (phase === 'read' && caseType === 'di2') {
      const createAnswerHost = await loadCandidateHostFactory();
      const workflowsDir = join(root, 'workflows');
      const journalRootDir = join(root, 'data', 'answer-v1', 'sessions');
      const hostIndexRootDir = join(root, 'data', 'answer-v1', 'host-index');
      const storageConfig: HostJournalStorageConfig = { journalRootDir, hostIndexRootDir };

      const barrierPath = join(root, 'barrier.json');
      if (!fs.existsSync(barrierPath)) throw new Error('Barrier file missing in reader');
      const barrier = JSON.parse(await fsp.readFile(barrierPath, 'utf8'));
      expect(barrier.caseType).toBe('di2');
      expect(barrier.phase).toBe('write');
      expect(barrier.runNonce).toBe(runNonce);
      expect(typeof barrier.writerPid).toBe('number');
      expect(process.pid).not.toBe(barrier.writerPid);

      // barrier.d1 is untrusted comparison-only string
      const expectedOldDelivery: string = barrier.d1;

      const pointerRaw = JSON.parse(await fsp.readFile(join(root, 'pointer.json'), 'utf8'));

      const fakeModel = new FakeTestModelBoundary();
      fakeModel.setQueuedResponses([secondResponse]);

      const config: AnswerHostConfig = {
        storage: storageConfig,
        keyringPath: join(root, 'keys', 'keyring.json'), workflowStoragePath: workflowsDir,
        model: fakeModel,
      };

      const signal = new AbortController().signal;
      const hostResult = await createAnswerHost(config, signal);
      expect(hostResult.kind).toBe('created');
      if (hostResult.kind !== 'created') return;
      const scheduler = hostResult.scheduler;

      // Reader hydrates pointer
      const hydrateResult = await scheduler.hydrator.hydrate(pointerRaw, signal);
      expect(hydrateResult.kind).toBe('hydrated');
      if (hydrateResult.kind !== 'hydrated') return;
      const enrollment = hydrateResult.enrollment;
      const ports = scheduler.bindDiagnosticPorts(enrollment);

      // scheduler.recover acquires fresh fence
      const recoverResult = await scheduler.recover(pointerRaw, signal);
      expect(recoverResult.kind).toBe('ready');
      if (recoverResult.kind !== 'ready') return;
      const { runner, owner: freshOwner } = recoverResult;

      // journal.recover returns redeliver with original D1
      const journalRecovery = await ports.journal.recover(enrollment, freshOwner, signal);
      expect(journalRecovery.kind).toBe('redeliver');
      if (journalRecovery.kind !== 'redeliver') return;

      // Get branded D1 from journalRecovery.oldDelivery after equality check against untrusted barrier
      const d1: DeliveryRef = journalRecovery.oldDelivery;
      expect(d1).toBe(expectedOldDelivery);

      const questionView = journalRecovery.view;
      expect(questionView.kind).toBe('question');
      expect(questionView.retained.length).toBe(0); // pending question with zero contributions verified

      // Atomically redeliver -> D2 (D2 distinct from D1)
      const redeliverResult = await ports.journal.redeliver(d1, questionView.reply, freshOwner, signal);
      expect(redeliverResult.kind).toBe('delivered');
      if (redeliverResult.kind !== 'delivered') return;
      const d2: DeliveryRef = redeliverResult.delivery;
      expect(d2).not.toBe(d1);

      // Attempting capture of abandoned D1 under current owner refuses invalid_delivery and preserves snapshot
      const journalBeforeAbandoned = await snapshotFiles(journalRootDir);
      const abandonedCapture = await ports.journal.captureResponse(d1, firstResponse, freshOwner, signal);
      expect(abandonedCapture.kind).toBe('refused');
      if (abandonedCapture.kind === 'refused') {
        expect(abandonedCapture.reason).toBe('invalid_delivery');
      }
      const journalAfterAbandoned = await snapshotFiles(journalRootDir);
      expect(journalAfterAbandoned).toEqual(journalBeforeAbandoned);

      // Fresh D2 captured/prepared/dispatched
      const freshCapture = await ports.journal.captureResponse(d2, firstResponse, freshOwner, signal);
      expect(freshCapture.kind).toBe('captured');
      if (freshCapture.kind !== 'captured') return;

      const prepareResult = await ports.journal.prepare(freshCapture.response, freshOwner, signal);
      expect(prepareResult.kind).toBe('prepared');
      if (prepareResult.kind !== 'prepared') return;

      const dispatchResult = await ports.dispatcher.dispatch(prepareResult.answer, freshOwner, signal);
      expect(dispatchResult.kind).toBe('recorded');
      if (dispatchResult.kind !== 'recorded') return;
      expect(dispatchResult.disposition).toBe('accepted');
      const step1Receipt = dispatchResult.receipt;

      // Fresh second-step completion yields exact original notes and second notes, two distinct receipts
      const step2Outcome = await runner.runTurn(signal);
      expect(step2Outcome.kind).toBe('advanced');
      if (step2Outcome.kind !== 'advanced') return;
      const step2Receipt = step2Outcome.receipt;

      expect(step1Receipt).not.toBe(step2Receipt);

      expect(step2Outcome.nextView.kind).toBe('finished');
      if (step2Outcome.nextView.kind !== 'finished') return;
      const finalView = step2Outcome.nextView;
      expect(finalView.execution.kind).toBe('completed');
      expect(finalView.taskOutcome).toBe('unknown');
      expect(finalView.retained.length).toBe(2);

      const read1 = await ports.inspector.inspectReceipt(finalView.read, step1Receipt, signal);
      expect(read1.kind).toBe('complete');
      if (read1.kind !== 'complete') return;
      expect(read1.disposition).toBe('accepted');
      expect(read1.receipt).toBe(step1Receipt);
      const parsed1 = JSON.parse(read1.chunk) as { notes: string };
      expect(parsed1).toEqual({ notes: firstNotes });
      const actualNote1 = parsed1.notes;

      const read2 = await ports.inspector.inspectReceipt(finalView.read, step2Receipt, signal);
      expect(read2.kind).toBe('complete');
      if (read2.kind !== 'complete') return;
      expect(read2.disposition).toBe('accepted');
      expect(read2.receipt).toBe(step2Receipt);
      const parsed2 = JSON.parse(read2.chunk) as { notes: string };
      expect(parsed2).toEqual({ notes: secondNotes });
      const actualNote2 = parsed2.notes;

      const obs = {
        caseType: 'di2',
        phase: 'read',
        runNonce,
        readerPid: process.pid,
        writerPid: barrier.writerPid,
        success: true,
        retainedReceiptCount: 2,
        receipts: [
          { id: step1Receipt, disposition: read1.disposition },
          { id: step2Receipt, disposition: read2.disposition },
        ],
        distinctReceipts: step1Receipt !== step2Receipt,
        abandonedD1Refused: abandonedCapture.kind === 'refused' && abandonedCapture.reason === 'invalid_delivery',
        abandonedPreservedSnapshot: true,
        finalExecution: finalView.execution.kind,
        finalTaskOutcome: finalView.taskOutcome,
        materializedNotes: [actualNote1, actualNote2],
      };
      await fsp.writeFile(join(root, 'reader-observation.json'), JSON.stringify(obs, null, 2), 'utf8');
    } else if (phase === 'read' && caseType === 'di2_runner') {
      const createAnswerHost = await loadCandidateHostFactory();
      const workflowsDir = join(root, 'workflows');
      const storageConfig: HostJournalStorageConfig = {
        journalRootDir: join(root, 'data', 'answer-v1', 'sessions'),
        hostIndexRootDir: join(root, 'data', 'answer-v1', 'host-index'),
      };

      const barrierPath = join(root, 'barrier.json');
      if (!fs.existsSync(barrierPath)) throw new Error('Barrier file missing in reader');
      const barrier = JSON.parse(await fsp.readFile(barrierPath, 'utf8'));
      expect(barrier.caseType).toBe('di2_runner');
      expect(barrier.phase).toBe('write');
      expect(barrier.runNonce).toBe(runNonce);
      expect(typeof barrier.writerPid).toBe('number');
      expect(process.pid).not.toBe(barrier.writerPid);

      const pointerRaw = JSON.parse(await fsp.readFile(join(root, 'pointer.json'), 'utf8'));
      const fakeModel = new FakeTestModelBoundary();
      fakeModel.setQueuedResponses([firstResponse, secondResponse]);

      const signal = new AbortController().signal;
      const hostResult = await createAnswerHost({ storage: storageConfig, keyringPath: join(root, 'keys', 'keyring.json'), workflowStoragePath: workflowsDir, model: fakeModel }, signal);
      expect(hostResult.kind).toBe('created');
      if (hostResult.kind !== 'created') return;
      const scheduler = hostResult.scheduler;

      // Recover via scheduler.recover only; no diagnostic binding/recover/dispatch before completion
      const recoverResult = await scheduler.recover(pointerRaw, signal);
      expect(recoverResult.kind).toBe('ready');
      if (recoverResult.kind !== 'ready') return;
      const { enrollment, runner } = recoverResult;
      expect(fakeModel.callCount).toBe(0);

      // Turn 1 redelivers D2, captures, prepares, and dispatches
      const step1Outcome = await runner.runTurn(signal);
      expect(step1Outcome.kind).toBe('advanced');
      if (step1Outcome.kind !== 'advanced') return;
      const step1Receipt = step1Outcome.receipt;
      expect(fakeModel.callCount).toBe(1);

      expect(step1Outcome.nextView.kind).toBe('question');
      if (step1Outcome.nextView.kind !== 'question') return;
      const question2View = step1Outcome.nextView;
      expect(question2View.instruction).toBe('Record second observation.');
      expect(question2View.retained.length).toBe(1);
      expect(question2View.retained[0].receipt).toBe(step1Receipt);

      // Turn 2 completes successor
      const step2Outcome = await runner.runTurn(signal);
      expect(step2Outcome.kind).toBe('advanced');
      if (step2Outcome.kind !== 'advanced') return;
      const step2Receipt = step2Outcome.receipt;
      expect(step2Receipt).not.toBe(step1Receipt);
      expect(fakeModel.callCount).toBe(2);

      const finalView = step2Outcome.nextView;
      expect(finalView.kind).toBe('finished');
      if (finalView.kind !== 'finished') return;
      expect(finalView.execution.kind).toBe('completed');
      expect(finalView.taskOutcome).toBe('unknown');
      expect(finalView.retained.map(item => item.receipt)).toEqual([step1Receipt, step2Receipt]);

      // Full model prompt history assertions
      expect(fakeModel.promptHistory).toEqual([
        { instruction: 'Record first observation.', issues: [], retainedSummaries: [] },
        { instruction: question2View.instruction, issues: question2View.issues, retainedSummaries: question2View.retained },
      ]);
      expect('reply' in fakeModel.promptHistory[0]!).toBe(false);
      expect('recovery' in fakeModel.promptHistory[0]!).toBe(false);
      expect('owner' in fakeModel.promptHistory[0]!).toBe(false);
      expect('reply' in fakeModel.promptHistory[1]!).toBe(false);
      expect('recovery' in fakeModel.promptHistory[1]!).toBe(false);
      expect('owner' in fakeModel.promptHistory[1]!).toBe(false);

      // Only inspect diagnostic receipts AFTER runner completed
      await verifyRetainedReceiptsAndRecordObservation({
        root, caseType: 'di2_runner', runNonce, writerPid: barrier.writerPid,
        scheduler, enrollment, finalView, step1Receipt, step2Receipt,
        modelCallCount: fakeModel.callCount, signal,
      });
    }
    return;
  }

  // -------------------------------------------------------------------------
  // Case 1.5: DI5 and di5_runner - Engine commits, before caller receives result
  // -------------------------------------------------------------------------
  if (caseType === 'di5' || caseType === 'di5_runner') {
    if (phase === 'write') {
      const createAnswerHost = await loadCandidateHostFactory();
      const workflowsDir = join(root, 'workflows');
      await setupWorkflow(workflowsDir);
      const journalRootDir = join(root, 'data', 'answer-v1', 'sessions');
      const hostIndexRootDir = join(root, 'data', 'answer-v1', 'host-index');
      await fsp.mkdir(journalRootDir, { recursive: true });
      await fsp.mkdir(hostIndexRootDir, { recursive: true });
      const storageConfig: HostJournalStorageConfig = { journalRootDir, hostIndexRootDir };

      const barrierPath = join(root, 'barrier.json');
      const faultSeam: DurableJournalFaultSeam = {
        async intercept(boundary: JournalFaultBoundary, execution: ExecutionRef, _signal: AbortSignal): Promise<JournalFaultAction> {
          if (boundary === 'after_engine_commit') {
            writeBarrierAndBlock(barrierPath, {
              ready: true,
              caseType,
              phase: 'write',
              runNonce,
              writerPid: process.pid,
              executionId: execution,
              recordedAt: Date.now(),
            });
          }
          return { kind: 'proceed' };
        },
      };

      const fakeModel = new FakeTestModelBoundary();
      fakeModel.setQueuedResponses([firstResponse]);

      const config: AnswerHostConfig = {
        storage: storageConfig,
        keyringPath: join(root, 'keys', 'keyring.json'), workflowStoragePath: workflowsDir,
        model: fakeModel,
        faultSeam,
      };

      const signal = new AbortController().signal;
      const hostResult = await createAnswerHost(config, signal);
      expect(hostResult.kind).toBe('created');
      if (hostResult.kind !== 'created') return;

      const scheduler = hostResult.scheduler;
      const workRequest: HostWorkRequest = {
        workflowId: 'two-step-test',
        goal: `${caseType} acceptance probe`,
        workspacePath: root,
      };

      const enrollResult = await scheduler.enroll(workRequest, signal);
      expect(enrollResult.kind).toBe('enrolled');
      if (enrollResult.kind !== 'enrolled') return;

      const { enrollment, runner } = enrollResult;

      const pointer: PersistedHostPointer = scheduler.hydrator.dehydrate(enrollment);
      expect(pointer.formatVersion).toBe(1);
      expect(typeof pointer.executionId).toBe('string');
      expect(typeof pointer.recoveryLocator).toBe('string');
      expect('owner' in pointer).toBe(false);
      expect('fence' in pointer).toBe(false);
      expect('epoch' in pointer).toBe(false);
      expect('lease' in pointer).toBe(false);
      const allowedPointerKeys = new Set(['formatVersion', 'executionId', 'recoveryLocator']);
      for (const k of Object.keys(pointer)) {
        expect(allowedPointerKeys.has(k), `Pointer key ${k} forbidden`).toBe(true);
      }
      await fsp.writeFile(join(root, 'pointer.json'), JSON.stringify(pointer, null, 2), 'utf8');

      // Runner uses one queued first response; barrier must actually be intercepted, no normal return after engine commit
      await runner.runTurn(signal);
      expect.fail('runner.runTurn must not return normally; after_engine_commit barrier should have blocked');
    } else if (phase === 'read' && caseType === 'di5') {
      const createAnswerHost = await loadCandidateHostFactory();
      const workflowsDir = join(root, 'workflows');
      const journalRootDir = join(root, 'data', 'answer-v1', 'sessions');
      const hostIndexRootDir = join(root, 'data', 'answer-v1', 'host-index');
      const storageConfig: HostJournalStorageConfig = { journalRootDir, hostIndexRootDir };

      const barrierPath = join(root, 'barrier.json');
      if (!fs.existsSync(barrierPath)) throw new Error('Barrier file missing in reader');
      const barrier = JSON.parse(await fsp.readFile(barrierPath, 'utf8'));
      expect(barrier.caseType).toBe('di5');
      expect(barrier.phase).toBe('write');
      expect(barrier.runNonce).toBe(runNonce);
      expect(typeof barrier.writerPid).toBe('number');
      expect(process.pid).not.toBe(barrier.writerPid);

      const pointerRaw = JSON.parse(await fsp.readFile(join(root, 'pointer.json'), 'utf8'));

      const fakeModel = new FakeTestModelBoundary();
      fakeModel.setQueuedResponses([secondResponse]);

      const config: AnswerHostConfig = {
        storage: storageConfig,
        keyringPath: join(root, 'keys', 'keyring.json'), workflowStoragePath: workflowsDir,
        model: fakeModel,
      };

      const signal = new AbortController().signal;
      const hostResult = await createAnswerHost(config, signal);
      expect(hostResult.kind).toBe('created');
      if (hostResult.kind !== 'created') return;
      const scheduler = hostResult.scheduler;

      // Fresh reader loads actual durable state via scheduler.recover
      const recoverResult = await scheduler.recover(pointerRaw, signal);
      expect(recoverResult.kind).toBe('ready');
      if (recoverResult.kind !== 'ready') return;
      const { enrollment, runner, owner: freshOwner } = recoverResult;
      expect(enrollment.execution).toBe(barrier.executionId);

      // Authoritative journal snapshot after ownership acquisition
      expect(Object.keys(await snapshotFiles(journalRootDir)).length).toBeGreaterThan(0);

      // Diagnostic journal.recover loads one original accepted receipt and exact first payload
      const ports = scheduler.bindDiagnosticPorts(enrollment);
      const journalRecovery = await ports.journal.recover(enrollment, freshOwner, signal);
      expect(journalRecovery.kind).toBe('deliver');
      if (journalRecovery.kind !== 'deliver') return;

      const questionView = journalRecovery.view;
      expect(questionView.kind).toBe('question');
      expect(questionView.retained.length).toBe(1);

      const step1Receipt = questionView.retained[0].receipt;
      const read1 = await ports.inspector.inspectReceipt(questionView.read, step1Receipt, signal);
      expect(read1.kind).toBe('complete');
      if (read1.kind !== 'complete') return;
      expect(read1.disposition).toBe('accepted');
      expect(read1.receipt).toBe(step1Receipt);
      const parsed1 = JSON.parse(read1.chunk) as { notes: string };
      expect(parsed1).toEqual({ notes: firstNotes });
      const actualNote1 = parsed1.notes;

      // First reconciliation may append its durable result; subsequent reads must be idempotent.
      const journalAfterFirstRecovery = await snapshotFiles(journalRootDir);
      // Repeated recovery retains exact same receipt and byte-identical authoritative journal
      const repeatedJournalRecovery = await ports.journal.recover(enrollment, freshOwner, signal);
      expect(repeatedJournalRecovery.kind).toBe('deliver');
      if (repeatedJournalRecovery.kind === 'deliver') {
        expect(repeatedJournalRecovery.view.retained.length).toBe(1);
        expect(repeatedJournalRecovery.view.retained[0].receipt).toBe(step1Receipt);
      }
      const journalAfterRepeatedRecovery = await snapshotFiles(journalRootDir);
      expect(journalAfterRepeatedRecovery).toEqual(journalAfterFirstRecovery);

      // No inference before new successor delivery
      expect(fakeModel.callCount).toBe(0);

      // Fresh successor answer then completes exact two distinct retained notes, no duplication
      const step2Outcome = await runner.runTurn(signal);
      expect(step2Outcome.kind).toBe('advanced');
      if (step2Outcome.kind !== 'advanced') return;
      const step2Receipt = step2Outcome.receipt;

      expect(step2Receipt).not.toBe(step1Receipt);
      expect(fakeModel.callCount).toBe(1);

      const finalView = step2Outcome.nextView;
      expect(finalView.kind).toBe('finished');
      if (finalView.kind !== 'finished') return;
      expect(finalView.execution.kind).toBe('completed');
      expect(finalView.taskOutcome).toBe('unknown');
      expect(finalView.retained.map(item => item.receipt)).toEqual([step1Receipt, step2Receipt]);
      expect(fakeModel.promptHistory).toEqual([{
        instruction: questionView.instruction,
        issues: questionView.issues,
        retainedSummaries: questionView.retained,
      }]);
      expect(questionView.instruction).toBe('Record second observation.');

      const retainedFirst = await ports.inspector.inspectReceipt(finalView.read, step1Receipt, signal);
      expect(retainedFirst.kind).toBe('complete');
      if (retainedFirst.kind !== 'complete') return;
      expect(retainedFirst.receipt).toBe(step1Receipt);
      expect(retainedFirst.disposition).toBe('accepted');
      expect(JSON.parse(retainedFirst.chunk)).toEqual({ notes: firstNotes });

      const read2 = await ports.inspector.inspectReceipt(finalView.read, step2Receipt, signal);
      expect(read2.kind).toBe('complete');
      if (read2.kind !== 'complete') return;
      expect(read2.disposition).toBe('accepted');
      expect(read2.receipt).toBe(step2Receipt);
      const parsed2 = JSON.parse(read2.chunk) as { notes: string };
      expect(parsed2).toEqual({ notes: secondNotes });
      const actualNote2 = parsed2.notes;

      const obs = {
        caseType: 'di5',
        phase: 'read',
        runNonce,
        readerPid: process.pid,
        writerPid: barrier.writerPid,
        success: true,
        initialRecoveredReceiptCount: 1,
        retainedReceiptCount: 2,
        receipts: [
          { id: step1Receipt, disposition: read1.disposition },
          { id: step2Receipt, disposition: read2.disposition },
        ],
        distinctReceipts: step1Receipt !== step2Receipt,
        repeatedRecoveryRetainedSameReceipt: true,
        journalUnchangedAcrossRecovery: true,
        modelCallCount: fakeModel.callCount,
        finalExecution: finalView.execution.kind,
        finalTaskOutcome: finalView.taskOutcome,
        materializedNotes: [actualNote1, actualNote2],
      };
      await fsp.writeFile(join(root, 'reader-observation.json'), JSON.stringify(obs, null, 2), 'utf8');
    } else if (phase === 'read' && caseType === 'di5_runner') {
      const createAnswerHost = await loadCandidateHostFactory();
      const workflowsDir = join(root, 'workflows');
      const journalRootDir = join(root, 'data', 'answer-v1', 'sessions');
      const hostIndexRootDir = join(root, 'data', 'answer-v1', 'host-index');
      const storageConfig: HostJournalStorageConfig = { journalRootDir, hostIndexRootDir };

      const barrierPath = join(root, 'barrier.json');
      if (!fs.existsSync(barrierPath)) throw new Error('Barrier file missing in reader');
      const barrier = JSON.parse(await fsp.readFile(barrierPath, 'utf8'));
      expect(barrier.caseType).toBe('di5_runner');
      expect(barrier.phase).toBe('write');
      expect(barrier.runNonce).toBe(runNonce);
      expect(typeof barrier.writerPid).toBe('number');
      expect(process.pid).not.toBe(barrier.writerPid);

      const pointerRaw = JSON.parse(await fsp.readFile(join(root, 'pointer.json'), 'utf8'));

      const fakeModel = new FakeTestModelBoundary();
      fakeModel.setQueuedResponses([secondResponse]);

      const config: AnswerHostConfig = {
        storage: storageConfig,
        keyringPath: join(root, 'keys', 'keyring.json'), workflowStoragePath: workflowsDir,
        model: fakeModel,
      };

      const signal = new AbortController().signal;
      const hostResult = await createAnswerHost(config, signal);
      expect(hostResult.kind).toBe('created');
      if (hostResult.kind !== 'created') return;
      const scheduler = hostResult.scheduler;

      // Recover via scheduler.recover only, NO bindDiagnosticPorts or journal.recover/dispatch before execution
      const recoverResult = await scheduler.recover(pointerRaw, signal);
      expect(recoverResult.kind).toBe('ready');
      if (recoverResult.kind !== 'ready') return;
      const { enrollment, runner } = recoverResult;
      expect(enrollment.execution).toBe(barrier.executionId);

      expect(fakeModel.callCount).toBe(0);

      // Fresh successor turn delivered without repeating first model inference
      const successorOutcome = await runner.runTurn(signal);
      expect(successorOutcome.kind).toBe('advanced');
      if (successorOutcome.kind !== 'advanced') return;
      const step2Receipt = successorOutcome.receipt;

      expect(fakeModel.callCount).toBe(1);

      const finalView = successorOutcome.nextView;
      expect(finalView.kind).toBe('finished');
      if (finalView.kind !== 'finished') return;
      expect(finalView.execution.kind).toBe('completed');
      expect(finalView.taskOutcome).toBe('unknown');
      expect(finalView.retained.length).toBe(2);

      const step1Receipt = finalView.retained[0].receipt;
      expect(step2Receipt).not.toBe(step1Receipt);
      expect(finalView.retained.map(item => item.receipt)).toEqual([step1Receipt, step2Receipt]);

      // Full model prompt object equality including retained summaries/correction issues, no capability leakage
      expect(fakeModel.promptHistory).toEqual([{
        instruction: 'Record second observation.',
        issues: [],
        retainedSummaries: [finalView.retained[0]],
      }]);
      expect('reply' in fakeModel.promptHistory[0]!).toBe(false);
      expect('recovery' in fakeModel.promptHistory[0]!).toBe(false);
      expect('owner' in fakeModel.promptHistory[0]!).toBe(false);

      // Only inspect diagnostic receipts AFTER runner completed to verify exact accepted retained IDs/payloads
      await verifyRetainedReceiptsAndRecordObservation({
        root,
        caseType: 'di5_runner',
        runNonce,
        writerPid: barrier.writerPid,
        scheduler,
        enrollment,
        finalView,
        step1Receipt,
        step2Receipt,
        modelCallCount: fakeModel.callCount,
        signal,
      });
    }
    return;
  }

  // -------------------------------------------------------------------------
  // Case 2: DI9 - Stop commits before recovered dispatch
  // -------------------------------------------------------------------------
  if (caseType === 'di9') {
    if (phase === 'write') {
      const createAnswerHost = await loadCandidateHostFactory();
      const workflowsDir = join(root, 'workflows');
      await setupWorkflow(workflowsDir);
      const journalRootDir = join(root, 'data', 'answer-v1', 'sessions');
      const hostIndexRootDir = join(root, 'data', 'answer-v1', 'host-index');
      await fsp.mkdir(journalRootDir, { recursive: true });
      await fsp.mkdir(hostIndexRootDir, { recursive: true });
      const storageConfig: HostJournalStorageConfig = { journalRootDir, hostIndexRootDir };

      const fakeModel = new FakeTestModelBoundary();
      const config: AnswerHostConfig = {
        storage: storageConfig,
        keyringPath: join(root, 'keys', 'keyring.json'), workflowStoragePath: workflowsDir,
        model: fakeModel,
      };

      const signal = new AbortController().signal;
      const hostResult = await createAnswerHost(config, signal);
      expect(hostResult.kind).toBe('created');
      if (hostResult.kind !== 'created') return;

      const scheduler = hostResult.scheduler;
      const workRequest: HostWorkRequest = {
        workflowId: 'two-step-test',
        goal: 'DI9 acceptance probe',
        workspacePath: root,
      };

      const enrollResult = await scheduler.enroll(workRequest, signal);
      expect(enrollResult.kind).toBe('enrolled');
      if (enrollResult.kind !== 'enrolled') return;

      const { enrollment, initialView, owner } = enrollResult;
      expect(initialView.kind).toBe('question');
      if (initialView.kind !== 'question') return;

      const pointer: PersistedHostPointer = scheduler.hydrator.dehydrate(enrollment);
      expect(pointer.formatVersion).toBe(1);
      const allowedPointerKeys = new Set(['formatVersion', 'executionId', 'recoveryLocator']);
      for (const k of Object.keys(pointer)) {
        expect(allowedPointerKeys.has(k), `Pointer key ${k} forbidden`).toBe(true);
      }
      await fsp.writeFile(join(root, 'pointer.json'), JSON.stringify(pointer, null, 2), 'utf8');

      const ports = scheduler.bindDiagnosticPorts(enrollment);
      const deliveryResult = await ports.journal.appendDelivery(initialView.reply, owner, signal);
      expect(deliveryResult.kind).toBe('delivered');
      if (deliveryResult.kind !== 'delivered') return;

      const captureResult = await ports.journal.captureResponse(deliveryResult.delivery, firstResponse, owner, signal);
      expect(captureResult.kind).toBe('captured');
      if (captureResult.kind !== 'captured') return;

      const prepareResult = await ports.journal.prepare(captureResult.response, owner, signal);
      expect(prepareResult.kind).toBe('prepared');
      if (prepareResult.kind !== 'prepared') return;

      // Commits stop before dispatch
      const stopResult = await ports.journal.commitStop(owner, 'cancelled', 'user abort requested', signal);
      expect(stopResult.kind).toBe('stopped');

      writeBarrierAndBlock(join(root, 'barrier.json'), {
        ready: true,
        caseType: 'di9',
        phase: 'write',
        runNonce,
        writerPid: process.pid,
        executionId: enrollment.execution,
        stopReason: 'cancelled',
        stopDetail: 'user abort requested',
        recordedAt: Date.now(),
      });
    } else if (phase === 'read') {
      const createAnswerHost = await loadCandidateHostFactory();
      const workflowsDir = join(root, 'workflows');
      const journalRootDir = join(root, 'data', 'answer-v1', 'sessions');
      const hostIndexRootDir = join(root, 'data', 'answer-v1', 'host-index');
      const storageConfig: HostJournalStorageConfig = { journalRootDir, hostIndexRootDir };

      const barrierPath = join(root, 'barrier.json');
      if (!fs.existsSync(barrierPath)) throw new Error('Barrier file missing in reader');
      const barrier = JSON.parse(await fsp.readFile(barrierPath, 'utf8'));
      expect(barrier.caseType).toBe('di9');
      expect(barrier.phase).toBe('write');
      expect(barrier.runNonce).toBe(runNonce);
      expect(typeof barrier.writerPid).toBe('number');
      expect(process.pid).not.toBe(barrier.writerPid);

      const pointerRaw = JSON.parse(await fsp.readFile(join(root, 'pointer.json'), 'utf8'));

      const fakeModel = new FakeTestModelBoundary();
      const config: AnswerHostConfig = {
        storage: storageConfig,
        keyringPath: join(root, 'keys', 'keyring.json'), workflowStoragePath: workflowsDir,
        model: fakeModel,
      };

      const signal = new AbortController().signal;
      const hostResult = await createAnswerHost(config, signal);
      expect(hostResult.kind).toBe('created');
      if (hostResult.kind !== 'created') return;
      const scheduler = hostResult.scheduler;

      // Nonempty authoritative journal snapshot before recovery must remain identical after recovery+inspection
      const journalBeforeRecovery = await snapshotFiles(journalRootDir);
      expect(Object.keys(journalBeforeRecovery).length).toBeGreaterThan(0);

      // scheduler.recover returns stopped with exact reason/detail without requiring owner re-acquisition
      const recoverResult = await scheduler.recover(pointerRaw, signal);
      expect(recoverResult.kind).toBe('stopped');
      if (recoverResult.kind !== 'stopped') return;

      expect(recoverResult.reason).toBe('cancelled');
      expect(recoverResult.detail).toBe('user abort requested');
      expect(recoverResult.execution).toBe(barrier.executionId);
      expect('runner' in recoverResult).toBe(false);
      expect('owner' in recoverResult).toBe(false);

      // Zero inference/dispatch
      expect(fakeModel.callCount).toBe(0);

      // Inspector reads retained evidence and stopped execution
      const hydrateResult = await scheduler.hydrator.hydrate(pointerRaw, signal);
      expect(hydrateResult.kind).toBe('hydrated');
      if (hydrateResult.kind !== 'hydrated') return;
      const enrollment = hydrateResult.enrollment;
      const ports = scheduler.bindDiagnosticPorts(enrollment);

      const inspection = await ports.inspector.inspect(recoverResult.read, signal);
      // Require finished + incomplete + cancelled + exact detail + taskOutcome unknown + zero retained accepted contributions
      expect(inspection.kind).toBe('finished');
      if (inspection.kind !== 'finished') return;
      expect(inspection.execution.kind).toBe('incomplete');
      if (inspection.execution.kind !== 'incomplete') return;
      expect(inspection.execution.reason).toBe('cancelled');
      expect(inspection.execution.detail).toBe('user abort requested');
      expect(inspection.taskOutcome).toBe('unknown');
      expect(inspection.retained.length).toBe(0);

      const journalAfterRecovery = await snapshotFiles(journalRootDir);
      expect(journalAfterRecovery).toEqual(journalBeforeRecovery);

      const obs = {
        caseType: 'di9',
        phase: 'read',
        runNonce,
        readerPid: process.pid,
        writerPid: barrier.writerPid,
        success: true,
        stopped: true,
        stopReason: recoverResult.reason,
        stopDetail: recoverResult.detail,
        modelCallCount: fakeModel.callCount,
        retainedAcceptedCount: inspection.retained.length,
        executionState: 'incomplete_cancelled',
        journalUnchangedAcrossRecovery: true,
        noRecoveredExecution: true,
      };
      await fsp.writeFile(join(root, 'reader-observation.json'), JSON.stringify(obs, null, 2), 'utf8');
    }
    return;
  }

  // -------------------------------------------------------------------------
  // Case 3: di9_unstopped and di4_runner - Prepared unstopped invocation
  // -------------------------------------------------------------------------
  if (caseType === 'di9_unstopped' || caseType === 'di4_runner') {
    if (phase === 'write') {
      const createAnswerHost = await loadCandidateHostFactory();
      const workflowsDir = join(root, 'workflows');
      await setupWorkflow(workflowsDir);
      const journalRootDir = join(root, 'data', 'answer-v1', 'sessions');
      const hostIndexRootDir = join(root, 'data', 'answer-v1', 'host-index');
      await fsp.mkdir(journalRootDir, { recursive: true });
      await fsp.mkdir(hostIndexRootDir, { recursive: true });
      const storageConfig: HostJournalStorageConfig = { journalRootDir, hostIndexRootDir };

      const fakeModel = new FakeTestModelBoundary();
      const config: AnswerHostConfig = {
        storage: storageConfig,
        keyringPath: join(root, 'keys', 'keyring.json'), workflowStoragePath: workflowsDir,
        model: fakeModel,
      };

      const signal = new AbortController().signal;
      const hostResult = await createAnswerHost(config, signal);
      expect(hostResult.kind).toBe('created');
      if (hostResult.kind !== 'created') return;

      const scheduler = hostResult.scheduler;
      const workRequest: HostWorkRequest = {
        workflowId: 'two-step-test',
        goal: `${caseType} probe`,
        workspacePath: root,
      };

      const enrollResult = await scheduler.enroll(workRequest, signal);
      expect(enrollResult.kind).toBe('enrolled');
      if (enrollResult.kind !== 'enrolled') return;

      const { enrollment, initialView, owner } = enrollResult;
      expect(initialView.kind).toBe('question');
      if (initialView.kind !== 'question') return;

      const pointer: PersistedHostPointer = scheduler.hydrator.dehydrate(enrollment);
      expect(pointer.formatVersion).toBe(1);
      expect(typeof pointer.executionId).toBe('string');
      expect(typeof pointer.recoveryLocator).toBe('string');
      expect('owner' in pointer).toBe(false);
      expect('fence' in pointer).toBe(false);
      expect('epoch' in pointer).toBe(false);
      expect('lease' in pointer).toBe(false);
      const allowedPointerKeys = new Set(['formatVersion', 'executionId', 'recoveryLocator']);
      for (const k of Object.keys(pointer)) {
        expect(allowedPointerKeys.has(k), `Pointer key ${k} forbidden`).toBe(true);
      }
      await fsp.writeFile(join(root, 'pointer.json'), JSON.stringify(pointer, null, 2), 'utf8');

      const ports = scheduler.bindDiagnosticPorts(enrollment);
      const deliveryResult = await ports.journal.appendDelivery(initialView.reply, owner, signal);
      expect(deliveryResult.kind).toBe('delivered');
      if (deliveryResult.kind !== 'delivered') return;

      const captureResult = await ports.journal.captureResponse(deliveryResult.delivery, firstResponse, owner, signal);
      expect(captureResult.kind).toBe('captured');
      if (captureResult.kind !== 'captured') return;

      const prepareResult = await ports.journal.prepare(captureResult.response, owner, signal);
      expect(prepareResult.kind).toBe('prepared');
      if (prepareResult.kind !== 'prepared') return;

      // Prepared but NOT stopped! Signals barrier with original IDs for comparison
      writeBarrierAndBlock(join(root, 'barrier.json'), {
        ready: true,
        caseType,
        phase: 'write',
        runNonce,
        writerPid: process.pid,
        executionId: enrollment.execution,
        originalReplyId: prepareResult.answer.reply,
        originalInvocationId: prepareResult.answer.invocation,
        originalResponseId: prepareResult.answer.response,
        recordedAt: Date.now(),
      });
    } else if (phase === 'read' && caseType === 'di9_unstopped') {
      const createAnswerHost = await loadCandidateHostFactory();
      const workflowsDir = join(root, 'workflows');
      const journalRootDir = join(root, 'data', 'answer-v1', 'sessions');
      const hostIndexRootDir = join(root, 'data', 'answer-v1', 'host-index');
      const storageConfig: HostJournalStorageConfig = { journalRootDir, hostIndexRootDir };

      const barrierPath = join(root, 'barrier.json');
      if (!fs.existsSync(barrierPath)) throw new Error('Barrier file missing in reader');
      const barrier = JSON.parse(await fsp.readFile(barrierPath, 'utf8'));
      expect(barrier.caseType).toBe('di9_unstopped');
      expect(barrier.phase).toBe('write');
      expect(barrier.runNonce).toBe(runNonce);
      expect(typeof barrier.writerPid).toBe('number');
      expect(process.pid).not.toBe(barrier.writerPid);

      // Raw barrier strings for comparison only (never cast into brands)
      const expectedOriginalReply: string = barrier.originalReplyId;
      const expectedOriginalInvocation: string = barrier.originalInvocationId;
      const expectedOriginalResponse: string = barrier.originalResponseId;

      const pointerRaw = JSON.parse(await fsp.readFile(join(root, 'pointer.json'), 'utf8'));

      const fakeModel = new FakeTestModelBoundary();
      fakeModel.setQueuedResponses([secondResponse]);

      const config: AnswerHostConfig = {
        storage: storageConfig,
        keyringPath: join(root, 'keys', 'keyring.json'), workflowStoragePath: workflowsDir,
        model: fakeModel,
      };

      const signal = new AbortController().signal;
      const hostResult = await createAnswerHost(config, signal);
      expect(hostResult.kind).toBe('created');
      if (hostResult.kind !== 'created') return;
      const scheduler = hostResult.scheduler;

      // Hydrate pointer
      const hydrateResult = await scheduler.hydrator.hydrate(pointerRaw, signal);
      expect(hydrateResult.kind).toBe('hydrated');
      if (hydrateResult.kind !== 'hydrated') return;
      const enrollment = hydrateResult.enrollment;
      const ports = scheduler.bindDiagnosticPorts(enrollment);

      // Zero model calls through recover/dispatch
      expect(fakeModel.callCount).toBe(0);

      // scheduler.recover returns ready
      const recoverResult = await scheduler.recover(pointerRaw, signal);
      expect(recoverResult.kind).toBe('ready');
      if (recoverResult.kind !== 'ready') return;
      const { runner, owner: freshOwner } = recoverResult;

      // journal.recover returns replay with original prepared response
      const journalRecovery = await ports.journal.recover(enrollment, freshOwner, signal);
      expect(journalRecovery.kind).toBe('replay');
      if (journalRecovery.kind !== 'replay') return;

      // Verify recovered PreparedAnswer exact original DomainAnswer plus execution binding
      const preparedAnswer = journalRecovery.answer;
      expect(preparedAnswer.answer).toEqual({ kind: 'notes', notes: firstNotes });
      expect(preparedAnswer.execution).toBe(enrollment.execution);
      // Reader compares recovered PreparedAnswer against barrier comparison-only IDs (DI4 payload/opportunity mapping)
      expect(preparedAnswer.reply).toBe(expectedOriginalReply);
      expect(preparedAnswer.invocation).toBe(expectedOriginalInvocation);
      expect(preparedAnswer.response).toBe(expectedOriginalResponse);

      // Replay original response once
      const dispatchResult = await ports.dispatcher.dispatch(preparedAnswer, freshOwner, signal);
      expect(dispatchResult.kind).toBe('recorded');
      if (dispatchResult.kind !== 'recorded') return;
      expect(dispatchResult.disposition).toBe('accepted');
      const step1Receipt = dispatchResult.receipt;

      // Model was still NOT called through recover or dispatch
      expect(fakeModel.callCount).toBe(0);

      // Complete successor with exact receipts; only second step calls model
      const step2Outcome = await runner.runTurn(signal);
      expect(step2Outcome.kind).toBe('advanced');
      if (step2Outcome.kind !== 'advanced') return;
      const step2Receipt = step2Outcome.receipt;

      expect(step1Receipt).not.toBe(step2Receipt);
      expect(fakeModel.callCount).toBe(1); // Exactly 1 call across whole reader!

      const finalView = step2Outcome.nextView;
      expect(finalView.kind).toBe('finished');
      if (finalView.kind !== 'finished') return;
      expect(finalView.execution.kind).toBe('completed');
      expect(finalView.taskOutcome).toBe('unknown');
      expect(finalView.retained.length).toBe(2);

      const read1 = await ports.inspector.inspectReceipt(finalView.read, step1Receipt, signal);
      const read2 = await ports.inspector.inspectReceipt(finalView.read, step2Receipt, signal);
      expect(read1.kind).toBe('complete');
      expect(read2.kind).toBe('complete');
      if (read1.kind !== 'complete' || read2.kind !== 'complete') return;
      expect(read1.disposition).toBe('accepted');
      expect(read2.disposition).toBe('accepted');
      expect(read1.receipt).toBe(step1Receipt);
      expect(read2.receipt).toBe(step2Receipt);

      const parsed1 = JSON.parse(read1.chunk) as { notes: string };
      const parsed2 = JSON.parse(read2.chunk) as { notes: string };
      expect(parsed1).toEqual({ notes: firstNotes });
      expect(parsed2).toEqual({ notes: secondNotes });
      const actualNote1 = parsed1.notes;
      const actualNote2 = parsed2.notes;

      const obs = {
        caseType: 'di9_unstopped',
        phase: 'read',
        runNonce,
        readerPid: process.pid,
        writerPid: barrier.writerPid,
        success: true,
        replayedOriginal: true,
        retainedReceiptCount: 2,
        receipts: [
          { id: step1Receipt, disposition: read1.disposition },
          { id: step2Receipt, disposition: read2.disposition },
        ],
        distinctReceipts: step1Receipt !== step2Receipt,
        modelCallCount: fakeModel.callCount,
        materializedNotes: [actualNote1, actualNote2],
        finalTaskOutcome: finalView.taskOutcome,
      };
      await fsp.writeFile(join(root, 'reader-observation.json'), JSON.stringify(obs, null, 2), 'utf8');
    } else if (phase === 'read' && caseType === 'di4_runner') {
      const createAnswerHost = await loadCandidateHostFactory();
      const workflowsDir = join(root, 'workflows');
      const journalRootDir = join(root, 'data', 'answer-v1', 'sessions');
      const hostIndexRootDir = join(root, 'data', 'answer-v1', 'host-index');
      const storageConfig: HostJournalStorageConfig = { journalRootDir, hostIndexRootDir };

      const barrierPath = join(root, 'barrier.json');
      if (!fs.existsSync(barrierPath)) throw new Error('Barrier file missing in reader');
      const barrier = JSON.parse(await fsp.readFile(barrierPath, 'utf8'));
      expect(barrier.caseType).toBe('di4_runner');
      expect(barrier.phase).toBe('write');
      expect(barrier.runNonce).toBe(runNonce);
      expect(typeof barrier.writerPid).toBe('number');
      expect(process.pid).not.toBe(barrier.writerPid);

      // Raw barrier strings for comparison only (never cast into brands)
      const expectedOriginalReply: string = barrier.originalReplyId;
      const expectedOriginalInvocation: string = barrier.originalInvocationId;
      const expectedOriginalResponse: string = barrier.originalResponseId;
      expect(typeof expectedOriginalReply).toBe('string');
      expect(typeof expectedOriginalInvocation).toBe('string');
      expect(typeof expectedOriginalResponse).toBe('string');

      const pointerRaw = JSON.parse(await fsp.readFile(join(root, 'pointer.json'), 'utf8'));

      const fakeModel = new FakeTestModelBoundary();
      fakeModel.setQueuedResponses([secondResponse]);

      const config: AnswerHostConfig = {
        storage: storageConfig,
        keyringPath: join(root, 'keys', 'keyring.json'), workflowStoragePath: workflowsDir,
        model: fakeModel,
      };

      const signal = new AbortController().signal;
      const hostResult = await createAnswerHost(config, signal);
      expect(hostResult.kind).toBe('created');
      if (hostResult.kind !== 'created') return;
      const scheduler = hostResult.scheduler;

      // Recover via scheduler.recover only, NO bindDiagnosticPorts or journal.recover/dispatch before execution
      const recoverResult = await scheduler.recover(pointerRaw, signal);
      expect(recoverResult.kind).toBe('ready');
      if (recoverResult.kind !== 'ready') return;
      const { enrollment, runner } = recoverResult;
      expect(enrollment.execution).toBe(barrier.executionId);

      // Model not called through recover
      expect(fakeModel.callCount).toBe(0);

      // For prepared-before-dispatch, runner should dispatch retained original without model call
      const step1Outcome = await runner.runTurn(signal);
      expect(step1Outcome.kind).toBe('advanced');
      if (step1Outcome.kind !== 'advanced') return;
      const step1Receipt = step1Outcome.receipt;

      expect(fakeModel.callCount).toBe(0); // Zero model calls on original dispatch!

      const step1NextView = step1Outcome.nextView;
      expect(step1NextView.kind).toBe('question');
      if (step1NextView.kind !== 'question') return;
      const question2View = step1NextView;
      expect(question2View.instruction).toBe('Record second observation.');
      expect(question2View.retained.length).toBe(1);
      expect(question2View.retained[0].receipt).toBe(step1Receipt);

      // Fresh successor call completes with single reader inference call
      const step2Outcome = await runner.runTurn(signal);
      expect(step2Outcome.kind).toBe('advanced');
      if (step2Outcome.kind !== 'advanced') return;
      const step2Receipt = step2Outcome.receipt;

      expect(step2Receipt).not.toBe(step1Receipt);
      expect(fakeModel.callCount).toBe(1); // Exactly 1 call across whole reader

      const finalView = step2Outcome.nextView;
      expect(finalView.kind).toBe('finished');
      if (finalView.kind !== 'finished') return;
      expect(finalView.execution.kind).toBe('completed');
      expect(finalView.taskOutcome).toBe('unknown');
      expect(finalView.retained.map(item => item.receipt)).toEqual([step1Receipt, step2Receipt]);

      // Full model prompt object equality including retained summaries/correction issues, no capability leakage
      expect(fakeModel.promptHistory).toEqual([{
        instruction: question2View.instruction,
        issues: question2View.issues,
        retainedSummaries: question2View.retained,
      }]);
      expect('reply' in fakeModel.promptHistory[0]!).toBe(false);
      expect('recovery' in fakeModel.promptHistory[0]!).toBe(false);
      expect('owner' in fakeModel.promptHistory[0]!).toBe(false);

      // Only inspect diagnostic receipts AFTER runner completed to verify exact accepted retained IDs/payloads
      await verifyRetainedReceiptsAndRecordObservation({
        root,
        caseType: 'di4_runner',
        runNonce,
        writerPid: barrier.writerPid,
        scheduler,
        enrollment,
        finalView,
        step1Receipt,
        step2Receipt,
        modelCallCount: fakeModel.callCount,
        signal,
      });
    }
    return;
  }

  throw new Error(`Unrecognized caseType: ${caseType}`);
});
