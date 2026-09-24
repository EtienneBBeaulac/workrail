/** Candidate host acceptance probes for answer-driven execution.
 * Covers:
 * - Positive control: Real no-fault host progresses actual two-step workflow to finished state,
 *   recomposes against storage, and recovers retained evidence.
 * - DI1: Delivery-before-inference (failure before delivery append issues zero model calls,
 *   authoritative files remain unchanged across refusal, and retry progresses with one contribution).
 * - DI7: Conflicting capture preservation (exact recapture before/after conflict, exact DomainAnswer,
 *   replay without advancing, changed-capture refusal after advancement, and final completion).
 *
 * Production module 'src/answer-v1/host.ts' does NOT exist yet.
 * Per probe contract, module absence fails explicitly with 'runtime_unavailable: src/answer-v1/host.ts'.
 * Import errors in an existing file propagate as runtime_error. Tests never skip or pass.
 */
import 'reflect-metadata';
import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type {
  AnswerHostConfig,
  CreateAnswerHostResult,
  DurableJournalFaultSeam,
  HostJournalStorageConfig,
  HostWorkRequest,
  JournalFaultAction,
  JournalFaultBoundary,
  ModelCompletionResult,
  ModelInferenceBoundary,
  ModelPromptInput,
  TurnOutcome,
} from './host-composition.js';
import type {
  ExecutionRef,
  HostExecutorPorts,
  RawModelResponse,
} from './invocation-contract.js';
import type {
  WorkView,
} from './answer-contract.js';

const PRODUCTION_MODULE_PATH = 'src/answer-v1/host.ts';

/** Loads the production module factory. Fails via explicit assertion when absent. */
async function loadCandidateHostFactory(): Promise<typeof import('./host-composition.js').createAnswerHost> {
  const absoluteSourcePath = resolve(process.cwd(), PRODUCTION_MODULE_PATH);
  try {
    await stat(absoluteSourcePath);
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

/** Injected fake model boundary for testing. Engine and journal remain real.
 * Returns unavailable if queued responses are exhausted; never fabricates fallback answers.
 */
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

/** Test fault seam interceptor to induce controlled failures at durable journal boundaries. */
class TestJournalFaultSeam implements DurableJournalFaultSeam {
  public failBeforeDelivery = false;
  public interceptedCalls = 0;

  async intercept(
    boundary: JournalFaultBoundary,
    execution: ExecutionRef,
    signal: AbortSignal,
  ): Promise<JournalFaultAction> {
    if (boundary === 'before_delivery_append') {
      this.interceptedCalls++;
      if (this.failBeforeDelivery) {
        return {
          kind: 'fail_io',
          message: 'Simulated durable storage fault before delivery append',
        };
      }
    }
    return { kind: 'proceed' };
  }
}

interface HostFixtureContext {
  root: string;
  storageConfig: HostJournalStorageConfig;
  workflowsDir: string;
  loadFactory: () => Promise<typeof import('./host-composition.js').createAnswerHost>;
  snapshotFiles: () => Promise<Record<string, string>>;
}

/** Real temporary filesystem fixture with genuine storage directories and workflow definitions. */
async function hostFixture(run: (f: HostFixtureContext) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'workrail-host-composition-acceptance-'));
  const journalRootDir = join(root, 'answer-v1', 'sessions');
  const hostIndexRootDir = join(root, 'answer-v1', 'host-index');
  const workflowsDir = join(root, 'workflows');

  await mkdir(journalRootDir, { recursive: true });
  await mkdir(hostIndexRootDir, { recursive: true });
  await mkdir(workflowsDir, { recursive: true });

  // Standard notes workflow without outputContract, conforming to notes workflow conventions
  const twoStepWorkflowDefinition = {
    id: 'two-step-test',
    name: 'Two Step Acceptance Test Workflow',
    description: 'Actual two-step workflow for host composition acceptance probes',
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

  await writeFile(
    join(workflowsDir, 'two-step-test.json'),
    JSON.stringify(twoStepWorkflowDefinition, null, 2),
    'utf8',
  );

  const snapshotFiles = async (dir = journalRootDir): Promise<Record<string, string>> => {
    const result: Record<string, string> = {};
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        Object.assign(result, await snapshotFiles(fullPath));
      } else {
        const content = await readFile(fullPath);
        result[fullPath] = content.toString('base64');
      }
    }
    return result;
  };

  try {
    await run({
      root,
      storageConfig: { journalRootDir, hostIndexRootDir },
      workflowsDir,
      loadFactory: loadCandidateHostFactory,
      snapshotFiles,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. Positive Control: Real no-fault host progresses actual two-step workflow
// ---------------------------------------------------------------------------

it('positive control: real no-fault host progresses actual two-step workflow to completion', () => hostFixture(async f => {
  const createAnswerHost = await f.loadFactory();

  const fakeModel = new FakeTestModelBoundary();
  fakeModel.setQueuedResponses([
    {
      responseText: 'Step 1 response',
      calls: [{
        id: 'call_1',
        name: 'answer_work',
        argumentsJson: JSON.stringify({ answer: { notes: 'Step 1 real observation' } }),
      }],
    },
    {
      responseText: 'Step 2 response',
      calls: [{
        id: 'call_2',
        name: 'answer_work',
        argumentsJson: JSON.stringify({ answer: { notes: 'Step 2 real observation' } }),
      }],
    },
  ]);

  const config: AnswerHostConfig = {
    storage: f.storageConfig,
    keyringPath: join(f.root, 'keys', 'keyring.json'), workflowStoragePath: f.workflowsDir,
    model: fakeModel,
  };

  const signal = new AbortController().signal;
  const hostResult = await createAnswerHost(config, signal);
  expect(hostResult.kind).toBe('created');
  if (hostResult.kind !== 'created') return;

  const scheduler = hostResult.scheduler;
  const workRequest: HostWorkRequest = {
    workflowId: 'two-step-test',
    goal: 'Positive control test run',
    workspacePath: f.root,
  };

  // 1. Enroll host session
  const enrollResult = await scheduler.enroll(workRequest, signal);
  expect(enrollResult.kind).toBe('enrolled');
  if (enrollResult.kind !== 'enrolled') return;

  const { runner, initialView, enrollment } = enrollResult;
  expect(initialView.kind).toBe('question');
  expect(initialView.retained).toHaveLength(0);

  // 2. Turn 1: Advance from step-1 to step-2
  const outcome1 = await runner.runTurn(signal);
  expect(outcome1.kind).toBe('advanced');
  if (outcome1.kind !== 'advanced') return;

  expect(fakeModel.callCount).toBe(1);
  expect(outcome1.nextView.kind).toBe('question');
  expect(outcome1.nextView.retained).toHaveLength(1);

  // 3. Turn 2: Advance from step-2 to finished
  const outcome2 = await runner.runTurn(signal);
  expect(outcome2.kind).toBe('advanced');
  expect(fakeModel.callCount).toBe(2);

  // 4. Narrow finalView without casting
  let finalView: Extract<WorkView, { kind: 'finished' }>;
  if (outcome2.kind === 'settled') {
    expect(outcome2.view.kind).toBe('finished');
    if (outcome2.view.kind !== 'finished') return;
    finalView = outcome2.view;
  } else if (outcome2.kind === 'advanced') {
    expect(outcome2.nextView.kind).toBe('finished');
    if (outcome2.nextView.kind !== 'finished') return;
    finalView = outcome2.nextView;
  } else {
    expect.fail(`Expected turn 2 outcome to be settled or advanced, got: ${outcome2.kind}`);
  }

  expect(finalView.kind).toBe('finished');
  expect(finalView.execution.kind).toBe('completed');
  expect(finalView.taskOutcome).toBe('unknown');
  expect(finalView.retained).toHaveLength(2);
  expect(new Set(finalView.retained.map(item => item.receipt)).size).toBe(2);

  // 5. Assert exact JSON payload through trusted HostInspectorPort
  const ports = scheduler.bindDiagnosticPorts(enrollment);
  const receipt1 = finalView.retained[0]!.receipt;
  const receipt2 = finalView.retained[1]!.receipt;

  const read1 = await ports.inspector.inspectReceipt(finalView.read, receipt1, signal);
  expect(read1.kind).toBe('complete');
  if (read1.kind === 'complete') {
    expect(read1.disposition).toBe('accepted');
    const parsed1 = JSON.parse(read1.chunk) as { notes?: string };
    expect(parsed1).toEqual({ notes: 'Step 1 real observation' });
    expect(read1.receipt).toBe(receipt1);
  }

  const read2 = await ports.inspector.inspectReceipt(finalView.read, receipt2, signal);
  expect(read2.kind).toBe('complete');
  if (read2.kind === 'complete') {
    expect(read2.disposition).toBe('accepted');
    const parsed2 = JSON.parse(read2.chunk) as { notes?: string };
    expect(parsed2).toEqual({ notes: 'Step 2 real observation' });
    expect(read2.receipt).toBe(receipt2);
  }

  // 6. Recompose host against same storage roots and recover session via persisted pointer
  const pointer = scheduler.hydrator.dehydrate(enrollment);
  const recomposedResult = await createAnswerHost(config, signal);
  expect(recomposedResult.kind).toBe('created');
  if (recomposedResult.kind !== 'created') return;

  const recovered = await recomposedResult.scheduler.recover(pointer, signal);
  expect(recovered.kind).toBe('settled');
  if (recovered.kind !== 'settled') return;

  expect(recovered.view.kind).toBe('finished');
  expect(recovered.view.execution.kind).toBe('completed');
  expect(recovered.view.taskOutcome).toBe('unknown');
  expect(recovered.view.retained).toHaveLength(2);

  const hydrated = await recomposedResult.scheduler.hydrator.hydrate(JSON.parse(JSON.stringify(pointer)), signal);
  expect(hydrated.kind).toBe('hydrated');
  if (hydrated.kind !== 'hydrated') return;
  const recomposedPorts = recomposedResult.scheduler.bindDiagnosticPorts(hydrated.enrollment);
  const recRead1 = await recomposedPorts.inspector.inspectReceipt(recovered.view.read, receipt1, signal);
  expect(recRead1.kind).toBe('complete');
  if (recRead1.kind === 'complete') {
    expect(recRead1.disposition).toBe('accepted');
    expect(JSON.parse(recRead1.chunk)).toEqual({ notes: 'Step 1 real observation' });
    expect(recRead1.receipt).toBe(receipt1);
  }
  const recRead2 = await recomposedPorts.inspector.inspectReceipt(recovered.view.read, receipt2, signal);
  expect(recRead2.kind).toBe('complete');
  if (recRead2.kind === 'complete') {
    expect(recRead2.disposition).toBe('accepted');
    expect(recRead2.receipt).toBe(receipt2);
    expect(JSON.parse(recRead2.chunk)).toEqual({ notes: 'Step 2 real observation' });
  }
  expect(fakeModel.callCount).toBe(2);
}));

// ---------------------------------------------------------------------------
// 2. DI1: Delivery-before-inference
// ---------------------------------------------------------------------------

it('DI1: failure before delivery append issues zero model calls, and valid retry produces one real retained contribution', () => hostFixture(async f => {
  const createAnswerHost = await f.loadFactory();

  const faultSeam = new TestJournalFaultSeam();
  faultSeam.failBeforeDelivery = true;

  const fakeModel = new FakeTestModelBoundary();
  fakeModel.setQueuedResponses([
    {
      responseText: 'Step 1 retried response',
      calls: [{
        id: 'call_retry_1',
        name: 'answer_work',
        argumentsJson: JSON.stringify({ answer: { notes: 'Retried step 1 observation' } }),
      }],
    },
  ]);

  const config: AnswerHostConfig = {
    storage: f.storageConfig,
    keyringPath: join(f.root, 'keys', 'keyring.json'), workflowStoragePath: f.workflowsDir,
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
    goal: 'DI1 delivery before inference probe',
    workspacePath: f.root,
  };

  const enrollResult = await scheduler.enroll(workRequest, signal);
  expect(enrollResult.kind).toBe('enrolled');
  if (enrollResult.kind !== 'enrolled') return;

  const { runner, initialView, enrollment } = enrollResult;
  expect(initialView.kind).toBe('question');
  if (initialView.kind !== 'question') return;

  // 1. Snapshot authoritative storage files before fault injection
  const snapshotBeforeFault = await f.snapshotFiles();
  expect(Object.keys(snapshotBeforeFault).length).toBeGreaterThan(0);

  // 2. Fault injected before delivery append: turn execution must fail
  const faultOutcome = await runner.runTurn(signal);
  expect(faultOutcome.kind).toBe('refused');
  if (faultOutcome.kind === 'refused') expect(faultOutcome.reason).toBe('delivery_refused');

  // 3. Assert fault seam was actually intercepted
  expect(faultSeam.interceptedCalls, 'Fault seam must be intercepted at before_delivery_append').toBeGreaterThanOrEqual(1);

  // 4. Assert authoritative file bytes remain strictly unchanged across failure-before-write refusal
  const snapshotAfterFault = await f.snapshotFiles();
  expect(snapshotAfterFault, 'Authoritative files must be byte-for-byte identical before and after refusal').toEqual(snapshotBeforeFault);

  // 5. Assert question is unchanged and zero contributions exist before retry
  const ports = scheduler.bindDiagnosticPorts(enrollment);
  const inspectBeforeRetry = await ports.inspector.inspect(initialView.read, signal);
  expect(inspectBeforeRetry.kind).toBe('question');
  if (inspectBeforeRetry.kind === 'question') {
    expect(inspectBeforeRetry.instruction).toBe(initialView.instruction);
    expect(inspectBeforeRetry.retained).toHaveLength(0);
  }

  // 6. CRITICAL INVARIANT: Zero model calls authorized before delivery append succeeds
  expect(fakeModel.callCount, 'DI1: No model inference authorized before delivery append succeeds').toBe(0);

  // 7. Clear fault seam and retry turn execution
  faultSeam.failBeforeDelivery = false;
  const retryOutcome = await runner.runTurn(signal);
  expect(retryOutcome.kind).toBe('advanced');
  if (retryOutcome.kind !== 'advanced') return;

  // 8. Valid retry produces exactly 1 model call and advances to step 2 with exactly 1 contribution
  expect(fakeModel.callCount, 'DI1: Valid retry issues exactly one model call').toBe(1);
  expect(retryOutcome.nextView.kind).toBe('question');
  expect(retryOutcome.nextView.retained).toHaveLength(1);

  // 9. Assert exact JSON payload through HostInspectorPort
  const receipt = retryOutcome.nextView.retained[0]!.receipt;
  const receiptData = await ports.inspector.inspectReceipt(retryOutcome.nextView.read, receipt, signal);
  expect(receiptData.kind).toBe('complete');
  if (receiptData.kind === 'complete') {
    expect(receiptData.disposition).toBe('accepted');
    const parsed = JSON.parse(receiptData.chunk) as { notes?: string };
    expect(parsed).toEqual({ notes: 'Retried step 1 observation' });
    expect(receiptData.receipt).toBe(receipt);
  }
}));

// ---------------------------------------------------------------------------
// 3. DI7: Conflicting capture preservation
// ---------------------------------------------------------------------------

it('DI7: conflicting capture preservation refuses changed payload, preserves original capture ref, and allows fresh successor completion', () => hostFixture(async f => {
  const createAnswerHost = await f.loadFactory();

  const fakeModel = new FakeTestModelBoundary();
  const config: AnswerHostConfig = {
    storage: f.storageConfig,
    keyringPath: join(f.root, 'keys', 'keyring.json'), workflowStoragePath: f.workflowsDir,
    model: fakeModel,
  };

  const signal = new AbortController().signal;
  const hostResult = await createAnswerHost(config, signal);
  expect(hostResult.kind).toBe('created');
  if (hostResult.kind !== 'created') return;

  const scheduler = hostResult.scheduler;
  const workRequest: HostWorkRequest = {
    workflowId: 'two-step-test',
    goal: 'DI7 conflicting capture probe',
    workspacePath: f.root,
  };

  const enrollResult = await scheduler.enroll(workRequest, signal);
  expect(enrollResult.kind).toBe('enrolled');
  if (enrollResult.kind !== 'enrolled') return;

  const { enrollment, initialView, owner } = enrollResult;
  expect(initialView.kind).toBe('question');
  if (initialView.kind !== 'question') return;

  const ports = scheduler.bindDiagnosticPorts(enrollment);

  // 1. Delivery D1 appended under current owner fence O1
  const delResult = await ports.journal.appendDelivery(initialView.reply, owner, signal);
  expect(delResult.kind).toBe('delivered');
  if (delResult.kind !== 'delivered') return;
  const deliveryD1 = delResult.delivery;

  // 2. First capture: valid raw payload 1 captured against D1
  const rawPayload1: RawModelResponse = {
    providerResponseId: 'provider_resp_original',
    responseText: 'Original model response',
    calls: [{
      id: 'call_d1_original',
      name: 'answer_work',
      argumentsJson: JSON.stringify({ answer: { notes: 'Authoritative original observation' } }),
    }],
  };

  const capture1 = await ports.journal.captureResponse(deliveryD1, rawPayload1, owner, signal);
  expect(capture1.kind).toBe('captured');
  if (capture1.kind !== 'captured') return;
  const originalCaptured = capture1.response;

  // 3. Exact recapture BEFORE conflict returns the exact same reference
  const recaptureBefore = await ports.journal.captureResponse(deliveryD1, rawPayload1, owner, signal);
  expect(recaptureBefore.kind).toBe('captured');
  if (recaptureBefore.kind === 'captured') {
    expect(recaptureBefore.response.response).toBe(originalCaptured.response);
    expect(recaptureBefore.response.delivery).toBe(deliveryD1);
  }

  // 4. Divergent capture with changed payload for same delivery D1 refuses as 'conflict'
  const rawPayload2Changed: RawModelResponse = {
    providerResponseId: 'provider_resp_divergent',
    responseText: 'Conflicting mutated response',
    calls: [{
      id: 'call_d1_conflict',
      name: 'answer_work',
      argumentsJson: JSON.stringify({ answer: { notes: 'Conflicting mutated observation' } }),
    }],
  };

  const beforeConflict = await f.snapshotFiles();
  expect(Object.keys(beforeConflict).length).toBeGreaterThan(0);
  const captureConflict = await ports.journal.captureResponse(deliveryD1, rawPayload2Changed, owner, signal);
  expect(await f.snapshotFiles()).toEqual(beforeConflict);
  expect(captureConflict.kind).toBe('refused');
  if (captureConflict.kind === 'refused') {
    expect(captureConflict.reason).toBe('conflict');
  }

  // 5. Exact recapture AFTER conflict returns the exact same original reference
  const recaptureAfter = await ports.journal.captureResponse(deliveryD1, rawPayload1, owner, signal);
  expect(recaptureAfter.kind).toBe('captured');
  if (recaptureAfter.kind === 'captured') {
    expect(recaptureAfter.response.response).toBe(originalCaptured.response);
    expect(recaptureAfter.response.delivery).toBe(deliveryD1);
  }

  // 6. Original captured response prepares and yields exact DomainAnswer matching payload1
  const prepareResult = await ports.journal.prepare(originalCaptured, owner, signal);
  expect(prepareResult.kind).toBe('prepared');
  if (prepareResult.kind !== 'prepared') return;

  expect(prepareResult.answer.delivery).toBe(deliveryD1);
  expect(prepareResult.answer.response).toBe(originalCaptured.response);
  expect(prepareResult.answer.answer).toEqual({
    kind: 'notes',
    notes: 'Authoritative original observation',
  });

  // 7. Dispatcher records commitment with accepted disposition
  const dispatchResult = await ports.dispatcher.dispatch(prepareResult.answer, owner, signal);
  expect(dispatchResult.kind).toBe('recorded');
  if (dispatchResult.kind !== 'recorded') return;
  expect(dispatchResult.disposition).toBe('accepted');
  expect(dispatchResult.view.kind).toBe('question');
  if (dispatchResult.view.kind !== 'question') return;
  const successorView = dispatchResult.view;

  // 8. Replay original prepared answer returns original receipt without advancing execution
  const beforeReplay = await ports.inspector.inspect(successorView.read, signal);
  const bytesBeforeReplay = await f.snapshotFiles();
  const replayResult = await ports.dispatcher.dispatch(prepareResult.answer, owner, signal);
  expect(replayResult.kind).toBe('replay');
  if (replayResult.kind === 'replay') {
    expect(replayResult.receipt).toBe(dispatchResult.receipt);
  }

  expect(await ports.inspector.inspect(successorView.read, signal)).toEqual(beforeReplay);
  expect(await f.snapshotFiles()).toEqual(bytesBeforeReplay);

  // 9. Inspect current question is identical before and after stale delivery attempt
  const inspectBeforeStale = await ports.inspector.inspect(successorView.read, signal);
  expect(inspectBeforeStale.kind).toBe('question');

  // Changed recapture after advancement remains a refusal; this alone is not cross-reply dispatch proof.
  const rawPayloadSuccessorStale: RawModelResponse = {
    providerResponseId: 'provider_resp_successor_stale',
    responseText: 'Attempted successor on D1',
    calls: [{
      id: 'call_step_2_stale_delivery',
      name: 'answer_work',
      argumentsJson: JSON.stringify({ answer: { notes: 'Successor notes on D1' } }),
    }],
  };

  const captureOnOldDelivery = await ports.journal.captureResponse(deliveryD1, rawPayloadSuccessorStale, owner, signal);
  expect(captureOnOldDelivery.kind).toBe('refused');
  if (captureOnOldDelivery.kind === 'refused') {
    expect(['invalid_delivery', 'conflict'].includes(captureOnOldDelivery.reason)).toBe(true);
  }

  const inspectAfterStale = await ports.inspector.inspect(successorView.read, signal);
  expect(inspectAfterStale).toEqual(inspectBeforeStale);

  // 10. Fresh delivery and response finishes second task, proving system does not refuse everything
  const del2Result = await ports.journal.appendDelivery(successorView.reply, owner, signal);
  expect(del2Result.kind).toBe('delivered');
  if (del2Result.kind !== 'delivered') return;
  const deliveryD2 = del2Result.delivery;

  const rawPayload2Valid: RawModelResponse = {
    providerResponseId: 'provider_resp_step2_valid',
    responseText: 'Step 2 valid response',
    calls: [{
      id: 'call_step_2_valid',
      name: 'answer_work',
      argumentsJson: JSON.stringify({ answer: { notes: 'Step 2 final observation' } }),
    }],
  };

  const capture2 = await ports.journal.captureResponse(deliveryD2, rawPayload2Valid, owner, signal);
  expect(capture2.kind).toBe('captured');
  if (capture2.kind !== 'captured') return;

  const prepare2 = await ports.journal.prepare(capture2.response, owner, signal);
  expect(prepare2.kind).toBe('prepared');
  if (prepare2.kind !== 'prepared') return;

  const dispatch2 = await ports.dispatcher.dispatch(prepare2.answer, owner, signal);
  expect(dispatch2.kind).toBe('recorded');
  if (dispatch2.kind !== 'recorded') return;
  expect(dispatch2.disposition).toBe('accepted');
  expect(dispatch2.view.kind).toBe('finished');
  if (dispatch2.view.kind === 'finished') {
    expect(dispatch2.view.execution.kind).toBe('completed');
    expect(dispatch2.view.taskOutcome).toBe('unknown');
    expect(dispatch2.view.retained).toHaveLength(2);
  }

  const successorReceipt = await ports.inspector.inspectReceipt(dispatch2.view.read, dispatch2.receipt, signal);
  expect(successorReceipt.kind).toBe('complete');
  if (successorReceipt.kind === 'complete') {
    expect(successorReceipt.receipt).toBe(dispatch2.receipt);
    expect(successorReceipt.disposition).toBe('accepted');
    expect(JSON.parse(successorReceipt.chunk)).toEqual({ notes: 'Step 2 final observation' });
  }

  // 11. Assert persisted receipt reflects ONLY original answer, never conflicting payload
  const inspectReceipt = await ports.inspector.inspectReceipt(dispatch2.view.read, dispatchResult.receipt, signal);
  expect(inspectReceipt.kind).toBe('complete');
  if (inspectReceipt.kind === 'complete') {
    expect(inspectReceipt.disposition).toBe('accepted');
    const parsed = JSON.parse(inspectReceipt.chunk) as { notes?: string };
    expect(parsed).toEqual({ notes: 'Authoritative original observation' });
    expect(inspectReceipt.receipt).toBe(dispatchResult.receipt);
  }
}));
