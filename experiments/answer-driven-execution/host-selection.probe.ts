/** Candidate host response selection acceptance probes for answer-driven execution.
 * Covers:
 * - Positive control: Real no-fault host progresses actual two-step workflow to completion,
 *   recomposes against storage, and recovers retained evidence.
 * - DI3 Case A: before_prepare_commit fail_io prevents engine transaction and contributions,
 *   retains captured response, and recomposed recovery prepares and dispatches original answer.
 * - DI3 Case B: after_prepare_commit simulate_uncertain yields unconfirmed stage, prevents
 *   engine transaction and contributions, and recomposed recovery replays and dispatches
 *   original prepared answer.
 * - DI3 Public Runner: Parameterized before_prepare_commit fail_io and after_prepare_commit
 *   simulate_uncertain public-runner-only recovery without diagnostic pre-dispatch.
 * - DI6 Case 1: Two answer_work calls in single model response; first applies to step 1,
 *   second never queued for successor, and fresh second response finishes step 2.
 * - DI6 Case 2: First selected invalid answer yields retained rejection without falling
 *   through to later valid answer in same response, and fresh response completes.
 * - DI6 Case 3: Duplicate tool-call IDs refuse at capture before prepare or dispatch,
 *   preserving storage, while distinct IDs valid control succeeds.
 *
 * Loads the production host module; absence is an explicit failure.
 * Per probe contract, module absence fails explicitly with 'runtime_unavailable: src/answer-v1/host.ts'.
 * Import errors in an existing module propagate as runtime_error. Tests never skip or pass.
 */
import 'reflect-metadata';
import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
} from '../../src/answer-v1/contracts/host-composition.js';
import type {
  ExecutionRef,
  RawModelResponse,
} from '../../src/answer-v1/contracts/invocation-contract.js';

import type { WorkView } from '../../src/answer-v1/contracts/answer-contract.js';

function expectPrompt(input: ModelPromptInput, view: Extract<WorkView, { kind: 'question' }>): void {
  expect(input).toEqual({ instruction: view.instruction, answerFormat: view.answerFormat, issues: view.issues, retainedSummaries: view.retained });
}

const PRODUCTION_MODULE_PATH = 'src/answer-v1/host.ts';

/** Loads the production module factory. Fails via explicit assertion when absent. */
async function loadCandidateHostFactory(): Promise<typeof import('../../src/answer-v1/contracts/host-composition.js').createAnswerHost> {
  const absoluteSourcePath = resolve(process.cwd(), PRODUCTION_MODULE_PATH);
  try {
    await stat(absoluteSourcePath);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      expect.fail(`runtime_unavailable: ${PRODUCTION_MODULE_PATH} (module file does not exist at ${absoluteSourcePath})`);
    }
    throw err;
  }

  let mod: { createAnswerHost?: typeof import('../../src/answer-v1/contracts/host-composition.js').createAnswerHost };
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

/** Test fault seam interceptor to induce controlled failures at prepare boundaries. */
class TestJournalFaultSeam implements DurableJournalFaultSeam {
  public failBeforePrepareCommit = false;
  public simulateUncertainAfterPrepareCommit = false;

  public interceptedBeforePrepareCommit = 0;
  public interceptedAfterPrepareCommit = 0;
  public interceptedBeforeEngineTransaction = 0;
  public interceptedAfterEngineCommit = 0;

  clearFaults(): void {
    this.failBeforePrepareCommit = false;
    this.simulateUncertainAfterPrepareCommit = false;
  }

  async intercept(
    boundary: JournalFaultBoundary,
    execution: ExecutionRef,
    signal: AbortSignal,
  ): Promise<JournalFaultAction> {
    if (boundary === 'before_prepare_commit') {
      this.interceptedBeforePrepareCommit++;
      if (this.failBeforePrepareCommit) {
        return {
          kind: 'fail_io',
          message: 'Simulated durable storage fault before prepare commit',
        };
      }
    } else if (boundary === 'after_prepare_commit') {
      this.interceptedAfterPrepareCommit++;
      if (this.simulateUncertainAfterPrepareCommit) {
        return {
          kind: 'simulate_uncertain',
          message: 'Simulated timeout/uncertainty after prepare commit',
        };
      }
    } else if (boundary === 'before_engine_transaction') {
      this.interceptedBeforeEngineTransaction++;
    } else if (boundary === 'after_engine_commit') {
      this.interceptedAfterEngineCommit++;
    }
    return { kind: 'proceed' };
  }
}

interface HostFixtureContext {
  root: string;
  storageConfig: HostJournalStorageConfig;
  workflowsDir: string;
  loadFactory: () => Promise<typeof import('../../src/answer-v1/contracts/host-composition.js').createAnswerHost>;
  snapshotFiles: () => Promise<Record<string, string>>;
}

/** Real temporary filesystem fixture with genuine storage directories and workflow definitions. */
async function hostFixture(run: (f: HostFixtureContext) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'workrail-host-selection-acceptance-'));
  const journalRootDir = join(root, 'answer-v1', 'sessions');
  const hostIndexRootDir = join(root, 'answer-v1', 'host-index');
  const workflowsDir = join(root, 'workflows');

  await mkdir(journalRootDir, { recursive: true });
  await mkdir(hostIndexRootDir, { recursive: true });
  await mkdir(workflowsDir, { recursive: true });

  const twoStepWorkflowDefinition = {
    id: 'two-step-selection-test',
    name: 'Two Step Selection Acceptance Test Workflow',
    description: 'Actual two-step workflow for response selection and prepare acceptance probes',
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
    join(workflowsDir, 'two-step-selection-test.json'),
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
        argumentsJson: JSON.stringify({ answer: { notes: 'Step 1 control observation' } }),
      }],
    },
    {
      responseText: 'Step 2 response',
      calls: [{
        id: 'call_2',
        name: 'answer_work',
        argumentsJson: JSON.stringify({ answer: { notes: 'Step 2 control observation' } }),
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
    workflowId: 'two-step-selection-test',
    goal: 'Selection positive control test run',
    workspacePath: f.root,
  };

  const enrollResult = await scheduler.enroll(workRequest, signal);
  expect(enrollResult.kind).toBe('enrolled');
  if (enrollResult.kind !== 'enrolled') return;

  const { runner, initialView, enrollment } = enrollResult;
  expect(initialView.kind).toBe('question');
  expect(initialView.retained).toHaveLength(0);

  // Turn 1
  const outcome1 = await runner.runTurn(signal);
  expect(outcome1.kind).toBe('advanced');
  if (outcome1.kind !== 'advanced') return;
  expect(fakeModel.callCount).toBe(1);
  expect(outcome1.nextView.kind).toBe('question');
  expect(outcome1.nextView.retained).toHaveLength(1);

  // Turn 2
  const outcome2 = await runner.runTurn(signal);
  expect(outcome2.kind).toBe('advanced');
  if (outcome2.kind !== 'advanced') return;
  expect(fakeModel.callCount).toBe(2);
  expect(outcome2.nextView.kind).toBe('finished');
  if (outcome2.nextView.kind !== 'finished') return;
  expect(outcome2.nextView.execution.kind).toBe('completed');
  expect(outcome2.nextView.taskOutcome).toBe('unknown');
  expect(outcome2.nextView.retained).toHaveLength(2);

  const receipt1 = outcome2.nextView.retained[0]!.receipt;
  const receipt2 = outcome2.nextView.retained[1]!.receipt;
  expect(receipt1).not.toBe(receipt2);

  const ports = scheduler.bindDiagnosticPorts(enrollment);
  const read1 = await ports.inspector.inspectReceipt(outcome2.nextView.read, receipt1, signal);
  const read2 = await ports.inspector.inspectReceipt(outcome2.nextView.read, receipt2, signal);
  expect(read1.kind).toBe('complete');
  if (read1.kind === 'complete') {
    expect(read1.disposition).toBe('accepted');
    expect(read1.receipt).toBe(receipt1);
    expect(JSON.parse(read1.chunk)).toEqual({ notes: 'Step 1 control observation' });
  }
  expect(read2.kind).toBe('complete');
  if (read2.kind === 'complete') {
    expect(read2.disposition).toBe('accepted');
    expect(read2.receipt).toBe(receipt2);
    expect(JSON.parse(read2.chunk)).toEqual({ notes: 'Step 2 control observation' });
  }

  // Recompose host against storage and verify settled finished recovery
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

  const recHydrate = await recomposedResult.scheduler.hydrator.hydrate(JSON.parse(JSON.stringify(pointer)), signal);
  expect(recHydrate.kind).toBe('hydrated');
  if (recHydrate.kind !== 'hydrated') return;

  const recomposedPorts = recomposedResult.scheduler.bindDiagnosticPorts(recHydrate.enrollment);
  const recRead1 = await recomposedPorts.inspector.inspectReceipt(recovered.view.read, receipt1, signal);
  const recRead2 = await recomposedPorts.inspector.inspectReceipt(recovered.view.read, receipt2, signal);
  expect(recRead1.kind).toBe('complete');
  if (recRead1.kind === 'complete') {
    expect(recRead1.disposition).toBe('accepted');
    expect(recRead1.receipt).toBe(receipt1);
    expect(JSON.parse(recRead1.chunk)).toEqual({ notes: 'Step 1 control observation' });
  }
  expect(recRead2.kind).toBe('complete');
  if (recRead2.kind === 'complete') {
    expect(recRead2.disposition).toBe('accepted');
    expect(recRead2.receipt).toBe(receipt2);
    expect(JSON.parse(recRead2.chunk)).toEqual({ notes: 'Step 2 control observation' });
  }
}));

// ---------------------------------------------------------------------------
// 2. DI3 Case A: before_prepare_commit fail_io prevents dispatch and recovers
// ---------------------------------------------------------------------------

it('DI3 Case A: before_prepare_commit fail_io prevents dispatch, retains captured response, and recomposed recovery prepares and dispatches original answer', () => hostFixture(async f => {
  const createAnswerHost = await f.loadFactory();

  const faultSeam = new TestJournalFaultSeam();
  faultSeam.failBeforePrepareCommit = true;

  const fakeModel = new FakeTestModelBoundary();
  fakeModel.setQueuedResponses([
    {
      responseText: 'Step 1 response before prepare fault',
      calls: [{
        id: 'call_step1_prepare_fail',
        name: 'answer_work',
        argumentsJson: JSON.stringify({ answer: { notes: 'Step 1 before_prepare_commit observation' } }),
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
    workflowId: 'two-step-selection-test',
    goal: 'DI3 Case A prepare failure probe',
    workspacePath: f.root,
  };

  const enrollResult = await scheduler.enroll(workRequest, signal);
  expect(enrollResult.kind).toBe('enrolled');
  if (enrollResult.kind !== 'enrolled') return;

  const { runner, initialView, enrollment, owner } = enrollResult;
  expect(initialView.kind).toBe('question');
  if (initialView.kind !== 'question') return;

  // 1. Run turn under injected fail_io before prepare commit
  const outcome = await runner.runTurn(signal);
  expect(
    outcome.kind === 'unconfirmed' ||
    (outcome.kind === 'refused' && ['prepare_refused', 'storage_unavailable'].includes(outcome.reason)),
  ).toBe(true);
  if (outcome.kind === 'unconfirmed') {
    expect(outcome.uncertainty.stage).toBe('prepare');
  }

  // 2. Assert boundary was hit and no engine transaction was authorized
  expect(faultSeam.interceptedBeforePrepareCommit).toBeGreaterThanOrEqual(1);
  expect(faultSeam.interceptedBeforeEngineTransaction).toBe(0);
  expect(faultSeam.interceptedAfterEngineCommit).toBe(0);

  // 3. Assert zero unexpected extra model calls (exactly 1 model call occurred)
  expect(fakeModel.callCount).toBe(1);

  // 4. Assert zero contributions committed while unconfirmed
  const ports = scheduler.bindDiagnosticPorts(enrollment);
  const inspectBefore = await ports.inspector.inspect(initialView.read, signal);
  expect(inspectBefore.kind).toBe('question');
  if (inspectBefore.kind === 'question') {
    expect(inspectBefore.retained).toHaveLength(0);
  }

  // 5. Clear fault and recompose host
  faultSeam.clearFaults();
  const pointer = scheduler.hydrator.dehydrate(enrollment);
  const recomposedResult = await createAnswerHost(config, signal);
  expect(recomposedResult.kind).toBe('created');
  if (recomposedResult.kind !== 'created') return;

  // 6. Scheduler recovery acquires fresh owner fence without model inference
  const callsBeforeRecover = fakeModel.callCount;
  const recoverResult = await recomposedResult.scheduler.recover(pointer, signal);
  expect(recoverResult.kind).toBe('ready');
  if (recoverResult.kind !== 'ready') return;
  expect(fakeModel.callCount).toBe(callsBeforeRecover);

  const { enrollment: recoveredEnrollment, owner: freshOwner } = recoverResult;
  expect(recoveredEnrollment.execution).toBe(enrollment.execution);
  expect(freshOwner.execution).toBe(enrollment.execution);

  const recPorts = recomposedResult.scheduler.bindDiagnosticPorts(recoveredEnrollment);

  // 7. Journal recovery observes durable captured response with uncommitted prepare
  const journalRec = await recPorts.journal.recover(recoveredEnrollment, freshOwner, signal);
  expect(journalRec.kind).toBe('prepare_response');
  if (journalRec.kind !== 'prepare_response') return;

  const capturedResponse = journalRec.response;
  if (outcome.kind === 'unconfirmed' && outcome.uncertainty.stage === 'prepare') {
    expect(outcome.uncertainty.execution).toBe(enrollment.execution);
    expect(outcome.uncertainty.delivery).toBe(capturedResponse.delivery);
    expect(outcome.uncertainty.response).toBe(capturedResponse.response);
  }

  // Compare repeated captured response identity across recovery before prepare
  const journalRecRepeat = await recPorts.journal.recover(recoveredEnrollment, freshOwner, signal);
  expect(journalRecRepeat.kind).toBe('prepare_response');
  if (journalRecRepeat.kind !== 'prepare_response') return;
  expect(journalRecRepeat.response.execution).toBe(capturedResponse.execution);
  expect(journalRecRepeat.response.delivery).toBe(capturedResponse.delivery);
  expect(journalRecRepeat.response.response).toBe(capturedResponse.response);
  expect(journalRecRepeat.response).toEqual(capturedResponse);

  // 8. Prepare captured response yields exact original DomainAnswer, initialView.reply, and execution
  const prepareResult = await recPorts.journal.prepare(capturedResponse, freshOwner, signal);
  expect(prepareResult.kind).toBe('prepared');
  if (prepareResult.kind !== 'prepared') return;

  expect(prepareResult.answer.toolCallId).toBe('call_step1_prepare_fail');
  expect(prepareResult.answer.reply).toBe(initialView.reply);
  expect(prepareResult.answer.execution).toBe(enrollment.execution);
  expect(prepareResult.answer.response).toBe(capturedResponse.response);
  expect(prepareResult.answer.delivery).toBe(capturedResponse.delivery);
  expect(prepareResult.answer.answer).toEqual({
    kind: 'notes',
    notes: 'Step 1 before_prepare_commit observation',
  });

  // 9. Rightful dispatch advances to step 2 question view
  const dispatch1 = await recPorts.dispatcher.dispatch(prepareResult.answer, freshOwner, signal);
  expect(dispatch1.kind).toBe('recorded');
  if (dispatch1.kind !== 'recorded') return;
  expect(dispatch1.disposition).toBe('accepted');
  expect(dispatch1.view.kind).toBe('question');
  if (dispatch1.view.kind !== 'question') return;
  const step2View = dispatch1.view;

  // 10. Assert no inference until intended successor
  expect(fakeModel.callCount).toBe(1);

  // 11. Fresh second model response finishes workflow with two exact notes
  fakeModel.setQueuedResponses([
    {
      responseText: 'Step 2 response',
      calls: [{
        id: 'call_step2_after_fail',
        name: 'answer_work',
        argumentsJson: JSON.stringify({ answer: { notes: 'Step 2 final observation' } }),
      }],
    },
  ]);

  const del2 = await recPorts.journal.appendDelivery(step2View.reply, freshOwner, signal);
  expect(del2.kind).toBe('delivered');
  if (del2.kind !== 'delivered') return;

  const modelRes2 = await fakeModel.generate({
    instruction: step2View.instruction, answerFormat: step2View.answerFormat,
    issues: step2View.issues,
    retainedSummaries: step2View.retained,
  }, signal);
  expect(modelRes2.kind).toBe('completed');
  if (modelRes2.kind !== 'completed') return;
  expect(fakeModel.callCount).toBe(2);

  const cap2 = await recPorts.journal.captureResponse(del2.delivery, modelRes2.response, freshOwner, signal);
  expect(cap2.kind).toBe('captured');
  if (cap2.kind !== 'captured') return;

  const prep2 = await recPorts.journal.prepare(cap2.response, freshOwner, signal);
  expect(prep2.kind).toBe('prepared');
  if (prep2.kind !== 'prepared') return;

  const dispatch2 = await recPorts.dispatcher.dispatch(prep2.answer, freshOwner, signal);
  expect(dispatch2.kind).toBe('recorded');
  if (dispatch2.kind !== 'recorded') return;
  expect(dispatch2.disposition).toBe('accepted');
  expect(dispatch2.view.kind).toBe('finished');
  if (dispatch2.view.kind !== 'finished') return;
  expect(dispatch2.view.execution.kind).toBe('completed');
  expect(dispatch2.view.taskOutcome).toBe('unknown');

  // Exact distinct final receipt list
  expect(dispatch2.view.retained).toHaveLength(2);
  const finalReceipt1 = dispatch1.receipt;
  const finalReceipt2 = dispatch2.receipt;
  expect(finalReceipt1).not.toBe(finalReceipt2);
  expect(dispatch2.view.retained.map(r => r.receipt)).toEqual([finalReceipt1, finalReceipt2]);
  expect(new Set(dispatch2.view.retained.map(r => r.receipt)).size).toBe(2);

  const r1 = await recPorts.inspector.inspectReceipt(dispatch2.view.read, finalReceipt1, signal);
  const r2 = await recPorts.inspector.inspectReceipt(dispatch2.view.read, finalReceipt2, signal);
  expect(r1.kind).toBe('complete');
  if (r1.kind === 'complete') {
    expect(r1.disposition).toBe('accepted');
    expect(r1.receipt).toBe(finalReceipt1);
    expect(JSON.parse(r1.chunk)).toEqual({ notes: 'Step 1 before_prepare_commit observation' });
  }
  expect(r2.kind).toBe('complete');
  if (r2.kind === 'complete') {
    expect(r2.disposition).toBe('accepted');
    expect(r2.receipt).toBe(finalReceipt2);
    expect(JSON.parse(r2.chunk)).toEqual({ notes: 'Step 2 final observation' });
  }
  expect(fakeModel.callCount).toBe(2);
}));

// ---------------------------------------------------------------------------
// 3. DI3 Case B: after_prepare_commit simulate_uncertain yields unconfirmed
// ---------------------------------------------------------------------------

it('DI3 Case B: after_prepare_commit simulate_uncertain yields unconfirmed stage, prevents dispatch, and recomposed recovery replays and dispatches original prepared answer', () => hostFixture(async f => {
  const createAnswerHost = await f.loadFactory();

  const faultSeam = new TestJournalFaultSeam();
  faultSeam.simulateUncertainAfterPrepareCommit = true;

  const fakeModel = new FakeTestModelBoundary();
  fakeModel.setQueuedResponses([
    {
      responseText: 'Step 1 response for uncertain prepare',
      calls: [{
        id: 'call_step1_uncertain_prepare',
        name: 'answer_work',
        argumentsJson: JSON.stringify({ answer: { notes: 'Step 1 after_prepare_commit observation' } }),
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
    workflowId: 'two-step-selection-test',
    goal: 'DI3 Case B uncertain prepare probe',
    workspacePath: f.root,
  };

  const enrollResult = await scheduler.enroll(workRequest, signal);
  expect(enrollResult.kind).toBe('enrolled');
  if (enrollResult.kind !== 'enrolled') return;

  const { runner, initialView, enrollment, owner } = enrollResult;
  expect(initialView.kind).toBe('question');
  if (initialView.kind !== 'question') return;

  // 1. Run turn under simulated uncertainty immediately after prepare commit
  const outcome = await runner.runTurn(signal);
  expect(outcome.kind).toBe('unconfirmed');
  if (outcome.kind === 'unconfirmed') {
    expect(outcome.uncertainty.stage).toBe('prepare');
  }

  // 2. Assert boundary hit and no engine transaction was authorized
  expect(faultSeam.interceptedAfterPrepareCommit).toBeGreaterThanOrEqual(1);
  expect(faultSeam.interceptedBeforeEngineTransaction).toBe(0);
  expect(faultSeam.interceptedAfterEngineCommit).toBe(0);

  // 3. Assert zero unexpected extra model calls
  expect(fakeModel.callCount).toBe(1);

  // 4. Assert zero contributions committed while unconfirmed
  const ports = scheduler.bindDiagnosticPorts(enrollment);
  const inspectBefore = await ports.inspector.inspect(initialView.read, signal);
  expect(inspectBefore.kind).toBe('question');
  if (inspectBefore.kind === 'question') {
    expect(inspectBefore.retained).toHaveLength(0);
  }

  // 5. Clear fault seam and recompose host
  faultSeam.clearFaults();
  const pointer = scheduler.hydrator.dehydrate(enrollment);
  const recomposedResult = await createAnswerHost(config, signal);
  expect(recomposedResult.kind).toBe('created');
  if (recomposedResult.kind !== 'created') return;

  // 6. Scheduler recovery acquires fresh owner fence without model inference
  const callsBeforeRecover = fakeModel.callCount;
  const recoverResult = await recomposedResult.scheduler.recover(pointer, signal);
  expect(recoverResult.kind).toBe('ready');
  if (recoverResult.kind !== 'ready') return;
  expect(fakeModel.callCount).toBe(callsBeforeRecover);

  const { enrollment: recoveredEnrollment, owner: freshOwner } = recoverResult;
  expect(recoveredEnrollment.execution).toBe(enrollment.execution);
  expect(freshOwner.execution).toBe(enrollment.execution);

  const recPorts = recomposedResult.scheduler.bindDiagnosticPorts(recoveredEnrollment);

  // 7. Journal recovery observes durable committed prepared answer; returns replay
  const journalRec = await recPorts.journal.recover(recoveredEnrollment, freshOwner, signal);
  expect(journalRec.kind).toBe('replay');
  if (journalRec.kind !== 'replay') return;

  const preparedAnswer = journalRec.answer;
  if (outcome.kind === 'unconfirmed' && outcome.uncertainty.stage === 'prepare') {
    expect(outcome.uncertainty.execution).toBe(enrollment.execution);
    expect(outcome.uncertainty.delivery).toBe(preparedAnswer.delivery);
    expect(outcome.uncertainty.response).toBe(preparedAnswer.response);
  }
  expect(preparedAnswer.toolCallId).toBe('call_step1_uncertain_prepare');
  expect(preparedAnswer.reply).toBe(initialView.reply);
  expect(preparedAnswer.execution).toBe(enrollment.execution);
  expect(preparedAnswer.answer).toEqual({
    kind: 'notes',
    notes: 'Step 1 after_prepare_commit observation',
  });

  // Compare repeated recovered PreparedAnswer full binding before dispatch
  const journalRecRepeat = await recPorts.journal.recover(recoveredEnrollment, freshOwner, signal);
  expect(journalRecRepeat.kind).toBe('replay');
  if (journalRecRepeat.kind !== 'replay') return;
  expect(journalRecRepeat.answer.invocation).toBe(preparedAnswer.invocation);
  expect(journalRecRepeat.answer.execution).toBe(preparedAnswer.execution);
  expect(journalRecRepeat.answer.delivery).toBe(preparedAnswer.delivery);
  expect(journalRecRepeat.answer.response).toBe(preparedAnswer.response);
  expect(journalRecRepeat.answer.toolCallId).toBe(preparedAnswer.toolCallId);
  expect(journalRecRepeat.answer.reply).toBe(preparedAnswer.reply);
  expect(journalRecRepeat.answer.answer).toEqual(preparedAnswer.answer);
  expect(journalRecRepeat.answer).toEqual(preparedAnswer);

  // 8. Rightful dispatch of the prepared answer advances to step 2
  const dispatch1 = await recPorts.dispatcher.dispatch(preparedAnswer, freshOwner, signal);
  expect(dispatch1.kind).toBe('recorded');
  if (dispatch1.kind !== 'recorded') return;
  expect(dispatch1.disposition).toBe('accepted');
  expect(dispatch1.view.kind).toBe('question');
  if (dispatch1.view.kind !== 'question') return;
  const step2View = dispatch1.view;

  // 9. Assert no inference until intended successor
  expect(fakeModel.callCount).toBe(1);

  // 10. Fresh second model response finishes workflow
  fakeModel.setQueuedResponses([
    {
      responseText: 'Step 2 response',
      calls: [{
        id: 'call_step2_after_uncertain',
        name: 'answer_work',
        argumentsJson: JSON.stringify({ answer: { notes: 'Step 2 post-uncertain observation' } }),
      }],
    },
  ]);

  const del2 = await recPorts.journal.appendDelivery(step2View.reply, freshOwner, signal);
  expect(del2.kind).toBe('delivered');
  if (del2.kind !== 'delivered') return;

  const modelRes2 = await fakeModel.generate({
    instruction: step2View.instruction, answerFormat: step2View.answerFormat,
    issues: step2View.issues,
    retainedSummaries: step2View.retained,
  }, signal);
  expect(modelRes2.kind).toBe('completed');
  if (modelRes2.kind !== 'completed') return;
  expect(fakeModel.callCount).toBe(2);

  const cap2 = await recPorts.journal.captureResponse(del2.delivery, modelRes2.response, freshOwner, signal);
  expect(cap2.kind).toBe('captured');
  if (cap2.kind !== 'captured') return;

  const prep2 = await recPorts.journal.prepare(cap2.response, freshOwner, signal);
  expect(prep2.kind).toBe('prepared');
  if (prep2.kind !== 'prepared') return;

  const dispatch2 = await recPorts.dispatcher.dispatch(prep2.answer, freshOwner, signal);
  expect(dispatch2.kind).toBe('recorded');
  if (dispatch2.kind !== 'recorded') return;
  expect(dispatch2.disposition).toBe('accepted');
  expect(dispatch2.view.kind).toBe('finished');
  if (dispatch2.view.kind !== 'finished') return;
  expect(dispatch2.view.execution.kind).toBe('completed');
  expect(dispatch2.view.taskOutcome).toBe('unknown');

  // Exact distinct final receipt list
  expect(dispatch2.view.retained).toHaveLength(2);
  const finalReceipt1 = dispatch1.receipt;
  const finalReceipt2 = dispatch2.receipt;
  expect(finalReceipt1).not.toBe(finalReceipt2);
  expect(dispatch2.view.retained.map(r => r.receipt)).toEqual([finalReceipt1, finalReceipt2]);
  expect(new Set(dispatch2.view.retained.map(r => r.receipt)).size).toBe(2);

  const r1 = await recPorts.inspector.inspectReceipt(dispatch2.view.read, finalReceipt1, signal);
  const r2 = await recPorts.inspector.inspectReceipt(dispatch2.view.read, finalReceipt2, signal);
  expect(r1.kind).toBe('complete');
  if (r1.kind === 'complete') {
    expect(r1.disposition).toBe('accepted');
    expect(r1.receipt).toBe(finalReceipt1);
    expect(JSON.parse(r1.chunk)).toEqual({ notes: 'Step 1 after_prepare_commit observation' });
  }
  expect(r2.kind).toBe('complete');
  if (r2.kind === 'complete') {
    expect(r2.disposition).toBe('accepted');
    expect(r2.receipt).toBe(finalReceipt2);
    expect(JSON.parse(r2.chunk)).toEqual({ notes: 'Step 2 post-uncertain observation' });
  }
  expect(fakeModel.callCount).toBe(2);
}));

// ---------------------------------------------------------------------------
// 4. DI6 Case 1: Two answer_work calls with distinct IDs in single response
// ---------------------------------------------------------------------------

it('DI6 Case 1: two answer_work calls in single model response; first applies to step 1, second never queued for successor, and fresh response finishes step 2', () => hostFixture(async f => {
  const createAnswerHost = await f.loadFactory();

  const fakeModel = new FakeTestModelBoundary();
  fakeModel.setQueuedResponses([
    {
      responseText: 'Single model response emitting two distinct answer calls',
      calls: [
        {
          id: 'call_step1_first_valid',
          name: 'answer_work',
          argumentsJson: JSON.stringify({ answer: { notes: 'Step 1 first valid note payload' } }),
        },
        {
          id: 'call_step1_second_batched',
          name: 'answer_work',
          argumentsJson: JSON.stringify({ answer: { notes: 'Batched second note payload - must NEVER be applied' } }),
        },
      ],
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
    workflowId: 'two-step-selection-test',
    goal: 'DI6 Case 1 multi-answer selection probe',
    workspacePath: f.root,
  };

  const enrollResult = await scheduler.enroll(workRequest, signal);
  expect(enrollResult.kind).toBe('enrolled');
  if (enrollResult.kind !== 'enrolled') return;

  const { runner, initialView, enrollment } = enrollResult;
  expect(initialView.kind).toBe('question');
  if (initialView.kind !== 'question') return;

  // 1. Run turn 1: only first answer call applies
  const outcome1 = await runner.runTurn(signal);
  expect(outcome1.kind).toBe('advanced');
  if (outcome1.kind !== 'advanced') return;
  expect(outcome1.nextView.kind).toBe('question');
  if (outcome1.nextView.kind !== 'question') return;
  expect(outcome1.nextView.retained).toHaveLength(1);

  // 2. Inspect actual first retained payload
  const ports = scheduler.bindDiagnosticPorts(enrollment);
  const read1 = await ports.inspector.inspectReceipt(outcome1.nextView.read, outcome1.nextView.retained[0]!.receipt, signal);
  expect(read1.kind).toBe('complete');
  if (read1.kind === 'complete') {
    expect(read1.disposition).toBe('accepted');
    expect(JSON.parse(read1.chunk)).toEqual({ notes: 'Step 1 first valid note payload' });
  }

  // 3. Inspect pending second prompt, assert model call count is 1, and assert first task instruction
  expect(outcome1.nextView.instruction).toBe('Record second observation.');
  expect(fakeModel.callCount).toBe(1);
  expect(fakeModel.promptHistory).toHaveLength(1);
  expectPrompt(fakeModel.promptHistory[0]!, initialView);
  expect(fakeModel.promptHistory[0]!.instruction).toBe('Record first observation.');

  // 4. Recompose host and recover session
  const pointer = scheduler.hydrator.dehydrate(enrollment);
  const recomposedResult = await createAnswerHost(config, signal);
  expect(recomposedResult.kind).toBe('created');
  if (recomposedResult.kind !== 'created') return;

  const recovered = await recomposedResult.scheduler.recover(pointer, signal);
  expect(recovered.kind).toBe('ready');
  if (recovered.kind !== 'ready') return;

  // 5. Queue fresh second model response for step 2 (proving batched call 2 was never queued)
  fakeModel.setQueuedResponses([
    {
      responseText: 'Step 2 fresh model response',
      calls: [{
        id: 'call_step2_fresh',
        name: 'answer_work',
        argumentsJson: JSON.stringify({ answer: { notes: 'Fresh step 2 observation' } }),
      }],
    },
  ]);

  // 6. Run turn 2 on recovered runner
  const outcome2 = await recovered.runner.runTurn(signal);
  expect(outcome2.kind).toBe('advanced');
  if (outcome2.kind !== 'advanced') return;
  expect(outcome2.nextView.kind).toBe('finished');
  if (outcome2.nextView.kind !== 'finished') return;
  expect(outcome2.nextView.execution.kind).toBe('completed');
  expect(outcome2.nextView.taskOutcome).toBe('unknown');
  expect(outcome2.nextView.retained).toHaveLength(2);

  // Assert actual fakeModel.promptHistory instructions correspond to first and successor tasks
  expect(fakeModel.callCount).toBe(2);
  expect(fakeModel.promptHistory).toHaveLength(2);
  expectPrompt(fakeModel.promptHistory[1]!, outcome1.nextView);
  expect(fakeModel.promptHistory[1]!.instruction).toBe('Record second observation.');

  // 7. Assert final retained receipts: first + fresh, distinct, never second batched
  const finalReceipt1 = outcome1.receipt;
  const finalReceipt2 = outcome2.receipt;
  expect(finalReceipt1).not.toBe(finalReceipt2);
  expect(outcome2.nextView.retained.map(r => r.receipt)).toEqual([finalReceipt1, finalReceipt2]);
  expect(new Set(outcome2.nextView.retained.map(r => r.receipt)).size).toBe(2);

  const recPorts = recomposedResult.scheduler.bindDiagnosticPorts(recovered.enrollment);
  const finalRead1 = await recPorts.inspector.inspectReceipt(outcome2.nextView.read, finalReceipt1, signal);
  const finalRead2 = await recPorts.inspector.inspectReceipt(outcome2.nextView.read, finalReceipt2, signal);
  expect(finalRead1.kind).toBe('complete');
  if (finalRead1.kind === 'complete') {
    expect(finalRead1.disposition).toBe('accepted');
    expect(finalRead1.receipt).toBe(finalReceipt1);
    expect(JSON.parse(finalRead1.chunk)).toEqual({ notes: 'Step 1 first valid note payload' });
  }
  expect(finalRead2.kind).toBe('complete');
  if (finalRead2.kind === 'complete') {
    expect(finalRead2.disposition).toBe('accepted');
    expect(finalRead2.receipt).toBe(finalReceipt2);
    expect(JSON.parse(finalRead2.chunk)).toEqual({ notes: 'Fresh step 2 observation' });
  }
}));

// ---------------------------------------------------------------------------
// 5. DI6 Case 2: First selected invalid answer does not fall through
// ---------------------------------------------------------------------------

it('DI6 Case 2: first selected invalid answer yields retained rejection without falling through to later valid answer in same response, and fresh response completes', () => hostFixture(async f => {
  const createAnswerHost = await f.loadFactory();

  const fakeModel = new FakeTestModelBoundary();
  fakeModel.setQueuedResponses([
    {
      responseText: 'First call invalid schema, second call valid notes',
      calls: [
        {
          id: 'call_step1_invalid',
          name: 'answer_work',
          argumentsJson: JSON.stringify({ answer: { notes: 12345 } }),
        },
        {
          id: 'call_step1_valid_later',
          name: 'answer_work',
          argumentsJson: JSON.stringify({ answer: { notes: 'Later valid notes - must not fall through' } }),
        },
      ],
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
    workflowId: 'two-step-selection-test',
    goal: 'DI6 Case 2 invalid selection fall-through prevention probe',
    workspacePath: f.root,
  };

  const enrollResult = await scheduler.enroll(workRequest, signal);
  expect(enrollResult.kind).toBe('enrolled');
  if (enrollResult.kind !== 'enrolled') return;

  const { runner, initialView, enrollment } = enrollResult;
  expect(initialView.kind).toBe('question');
  if (initialView.kind !== 'question') return;

  // 1. Run turn 1: first call is invalid -> must yield rejected outcome without fall-through
  const outcome1 = await runner.runTurn(signal);
  expect(outcome1.kind).toBe('rejected');
  if (outcome1.kind !== 'rejected') return;

  // 2. Correction view is still at step 1
  expect(outcome1.correctionView.kind).toBe('question');
  if (outcome1.correctionView.kind !== 'question') return;
  expect(outcome1.correctionView.instruction).toBe(initialView.instruction);
  expect(outcome1.correctionView.issues.length).toBeGreaterThan(0);
  for (const issue of outcome1.correctionView.issues) {
    expect(['field', 'gate']).toContain(issue.kind);
    expect((issue.kind === 'field' ? issue.reason : issue.rationale).trim().length).toBeGreaterThan(0);
  }
  expect(outcome1.correctionView.retained).toHaveLength(1);
  expect(outcome1.receipt).toBe(outcome1.correctionView.retained[0]!.receipt);

  // 3. Inspect rejected receipt disposition and exact invalid payload using declared encoding
  const ports = scheduler.bindDiagnosticPorts(enrollment);
  const rejectRead = await ports.inspector.inspectReceipt(outcome1.correctionView.read, outcome1.receipt, signal);
  expect(rejectRead.kind).toBe('complete');
  if (rejectRead.kind === 'complete') {
    expect(rejectRead.disposition).toBe('rejected');
    expect(rejectRead.receipt).toBe(outcome1.receipt);
    expect(rejectRead.encoding).toBe('canonical_json');
    expect(JSON.parse(rejectRead.chunk)).toEqual({ notes: 12345 });
  }

  // 4. Assert first task prompt instruction and call count strictly 1
  expect(fakeModel.callCount).toBe(1);
  expect(fakeModel.promptHistory).toHaveLength(1);
  expectPrompt(fakeModel.promptHistory[0]!, initialView);
  expect(fakeModel.promptHistory[0]!.instruction).toBe('Record first observation.');

  // 5. Provide fresh valid model response for step 1 correction, and fresh response for step 2
  fakeModel.setQueuedResponses([
    {
      responseText: 'Corrected step 1 response',
      calls: [{
        id: 'call_step1_corrected',
        name: 'answer_work',
        argumentsJson: JSON.stringify({ answer: { notes: 'Corrected step 1 observation' } }),
      }],
    },
    {
      responseText: 'Step 2 valid response',
      calls: [{
        id: 'call_step2_valid',
        name: 'answer_work',
        argumentsJson: JSON.stringify({ answer: { notes: 'Step 2 final observation' } }),
      }],
    },
  ]);

  // 6. Turn 2 advances step 1 correction to step 2; assert correction task prompt instruction
  const outcome2 = await runner.runTurn(signal);
  expect(outcome2.kind).toBe('advanced');
  if (outcome2.kind !== 'advanced') return;
  expect(outcome2.nextView.kind).toBe('question');
  if (outcome2.nextView.kind !== 'question') return;
  expect(fakeModel.callCount).toBe(2);
  expect(fakeModel.promptHistory).toHaveLength(2);
  expectPrompt(fakeModel.promptHistory[1]!, outcome1.correctionView);
  expect(fakeModel.promptHistory[1]!.instruction).toBe('Record first observation.');

  // 7. Turn 3 advances step 2 to finished; assert successor task prompt instruction
  const outcome3 = await runner.runTurn(signal);
  expect(outcome3.kind).toBe('advanced');
  if (outcome3.kind !== 'advanced') return;
  expect(outcome3.nextView.kind).toBe('finished');
  if (outcome3.nextView.kind !== 'finished') return;
  expect(outcome3.nextView.execution.kind).toBe('completed');
  expect(outcome3.nextView.taskOutcome).toBe('unknown');
  expect(fakeModel.callCount).toBe(3);
  expect(fakeModel.promptHistory).toHaveLength(3);
  expectPrompt(fakeModel.promptHistory[2]!, outcome2.nextView);
  expect(fakeModel.promptHistory[2]!.instruction).toBe('Record second observation.');

  // 8. Final retained list must equal exactly rejection + corrected + final receipt, distinct
  expect(outcome3.nextView.retained).toHaveLength(3);
  const finalReceiptList = outcome3.nextView.retained.map(r => r.receipt);
  expect(finalReceiptList).toEqual([outcome1.receipt, outcome2.receipt, outcome3.receipt]);
  expect(new Set(finalReceiptList).size).toBe(3);
  expect(outcome1.receipt).not.toBe(outcome2.receipt);
  expect(outcome2.receipt).not.toBe(outcome3.receipt);
  expect(outcome1.receipt).not.toBe(outcome3.receipt);

  // Rejected original remains rejected with exact invalid selected payload
  const finalRejectRead = await ports.inspector.inspectReceipt(outcome3.nextView.read, outcome1.receipt, signal);
  expect(finalRejectRead.kind).toBe('complete');
  if (finalRejectRead.kind === 'complete') {
    expect(finalRejectRead.disposition).toBe('rejected');
    expect(finalRejectRead.receipt).toBe(outcome1.receipt);
    expect(finalRejectRead.encoding).toBe('canonical_json');
    expect(JSON.parse(finalRejectRead.chunk)).toEqual({ notes: 12345 });
  }

  // Corrected step 1 receipt is accepted
  const finalCorrectedRead = await ports.inspector.inspectReceipt(outcome3.nextView.read, outcome2.receipt, signal);
  expect(finalCorrectedRead.kind).toBe('complete');
  if (finalCorrectedRead.kind === 'complete') {
    expect(finalCorrectedRead.disposition).toBe('accepted');
    expect(finalCorrectedRead.receipt).toBe(outcome2.receipt);
    expect(JSON.parse(finalCorrectedRead.chunk)).toEqual({ notes: 'Corrected step 1 observation' });
  }

  // Successor step 2 receipt is accepted
  const finalStep2Read = await ports.inspector.inspectReceipt(outcome3.nextView.read, outcome3.receipt, signal);
  expect(finalStep2Read.kind).toBe('complete');
  if (finalStep2Read.kind === 'complete') {
    expect(finalStep2Read.disposition).toBe('accepted');
    expect(finalStep2Read.receipt).toBe(outcome3.receipt);
    expect(JSON.parse(finalStep2Read.chunk)).toEqual({ notes: 'Step 2 final observation' });
  }
}));

// ---------------------------------------------------------------------------
// 6. DI6 Case 3: Duplicate tool-call IDs refuse before prepare or dispatch
// ---------------------------------------------------------------------------

it('DI6 Case 3: duplicate tool-call IDs refuse at capture before prepare or dispatch, while distinct IDs valid control succeeds', () => hostFixture(async f => {
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
    workflowId: 'two-step-selection-test',
    goal: 'DI6 Case 3 duplicate ID refusal probe',
    workspacePath: f.root,
  };

  const enrollResult = await scheduler.enroll(workRequest, signal);
  expect(enrollResult.kind).toBe('enrolled');
  if (enrollResult.kind !== 'enrolled') return;

  const { initialView, enrollment, owner } = enrollResult;
  expect(initialView.kind).toBe('question');
  if (initialView.kind !== 'question') return;

  const ports = scheduler.bindDiagnosticPorts(enrollment);

  // 1. Append delivery D1
  const delResult = await ports.journal.appendDelivery(initialView.reply, owner, signal);
  expect(delResult.kind).toBe('delivered');
  if (delResult.kind !== 'delivered') return;
  const deliveryD1 = delResult.delivery;

  // 2. Snapshot storage files before duplicate ID attempt
  const snapshotBefore = await f.snapshotFiles();
  expect(Object.keys(snapshotBefore).length).toBeGreaterThan(0);

  // 3. Capture model response containing duplicate tool call IDs
  const duplicateCallsPayload: RawModelResponse = {
    responseText: 'Duplicate tool call IDs in single response',
    calls: [
      {
        id: 'duplicate_call_id_1',
        name: 'answer_work',
        argumentsJson: JSON.stringify({ answer: { notes: 'First call with duplicate ID' } }),
      },
      {
        id: 'duplicate_call_id_1',
        name: 'answer_work',
        argumentsJson: JSON.stringify({ answer: { notes: 'Second call with duplicate ID' } }),
      },
    ],
  };

  const capResult = await ports.journal.captureResponse(deliveryD1, duplicateCallsPayload, owner, signal);
  expect(capResult.kind).toBe('refused');
  if (capResult.kind === 'refused') {
    expect(capResult.reason).toBe('duplicate_tool_call_ids');
  }

  // 4. Storage snapshot is identical: refusal before prepare/dispatch writes no journal state
  expect(await f.snapshotFiles()).toEqual(snapshotBefore);

  // 5. Positive control: valid payload with distinct tool call IDs succeeds on same delivery
  const validControlPayload: RawModelResponse = {
    responseText: 'Valid control with distinct IDs',
    calls: [{
      id: 'distinct_call_id_1',
      name: 'answer_work',
      argumentsJson: JSON.stringify({ answer: { notes: 'Valid control observation' } }),
    }],
  };

  const validCap = await ports.journal.captureResponse(deliveryD1, validControlPayload, owner, signal);
  expect(validCap.kind).toBe('captured');
  if (validCap.kind !== 'captured') return;

  const validPrep = await ports.journal.prepare(validCap.response, owner, signal);
  expect(validPrep.kind).toBe('prepared');
  if (validPrep.kind !== 'prepared') return;
  expect(validPrep.answer.toolCallId).toBe('distinct_call_id_1');
  expect(validPrep.answer.answer).toEqual({ kind: 'notes', notes: 'Valid control observation' });

  const validDispatch = await ports.dispatcher.dispatch(validPrep.answer, owner, signal);
  expect(validDispatch.kind).toBe('recorded');
  if (validDispatch.kind !== 'recorded') return;
  expect(validDispatch.disposition).toBe('accepted');
  expect(validDispatch.view.kind).toBe('question');
  expect(validDispatch.view.retained.map(item => item.receipt)).toEqual([validDispatch.receipt]);
  const validRead = await ports.inspector.inspectReceipt(validDispatch.view.read, validDispatch.receipt, signal);
  expect(validRead.kind).toBe('complete');
  if (validRead.kind !== 'complete') return;
  expect(validRead.receipt).toBe(validDispatch.receipt);
  expect(validRead.disposition).toBe('accepted');
  expect(JSON.parse(validRead.chunk)).toEqual({ notes: 'Valid control observation' });
}));

// ---------------------------------------------------------------------------
// 7. DI3 Parameterized Public-Runner-Only Interrupted Prepare Recovery
// ---------------------------------------------------------------------------

const di3PublicRunnerCases = [
  { boundary: 'before_prepare_commit' as const, fault: 'fail_io' as const },
  { boundary: 'after_prepare_commit' as const, fault: 'simulate_uncertain' as const },
];

for (const { boundary, fault } of di3PublicRunnerCases) {
  it(`DI3 public runner: ${boundary} ${fault} stops turn without engine commit, recovered runner finishes retained response without new inference, and successor completes`, () => hostFixture(async f => {
    const createAnswerHost = await f.loadFactory();
    const faultSeam = new TestJournalFaultSeam();
    if (boundary === 'before_prepare_commit') faultSeam.failBeforePrepareCommit = true;
    else faultSeam.simulateUncertainAfterPrepareCommit = true;

    const fakeModel = new FakeTestModelBoundary();
    fakeModel.setQueuedResponses([{
      responseText: 'Step 1 response under fault',
      calls: [{ id: 'call_step1_fault', name: 'answer_work', argumentsJson: JSON.stringify({ answer: { notes: 'Step 1 observation' } }) }],
    }]);

    const signal = new AbortController().signal;
    const hostResult = await createAnswerHost({ storage: f.storageConfig, keyringPath: join(f.root, 'keys', 'keyring.json'), workflowStoragePath: f.workflowsDir, model: fakeModel, faultSeam }, signal);
    expect(hostResult.kind).toBe('created');
    if (hostResult.kind !== 'created') return;

    const scheduler = hostResult.scheduler;
    const enrollResult = await scheduler.enroll({ workflowId: 'two-step-selection-test', goal: `DI3 runner ${boundary} ${fault} probe`, workspacePath: f.root }, signal);
    expect(enrollResult.kind).toBe('enrolled');
    if (enrollResult.kind !== 'enrolled') return;

    const { runner, initialView, enrollment } = enrollResult;
    expect(initialView.kind).toBe('question');
    if (initialView.kind !== 'question') return;

    // 1. Original turn stops with no engine commit or additional inference
    const outcome = await runner.runTurn(signal);
    if (boundary === 'before_prepare_commit') {
      expect(outcome.kind === 'unconfirmed' || (outcome.kind === 'refused' && ['prepare_refused', 'storage_unavailable'].includes(outcome.reason))).toBe(true);
      if (outcome.kind === 'unconfirmed') expect(outcome.uncertainty.stage).toBe('prepare');
      expect(faultSeam.interceptedBeforePrepareCommit).toBeGreaterThanOrEqual(1);
    } else {
      expect(outcome.kind).toBe('unconfirmed');
      if (outcome.kind === 'unconfirmed') expect(outcome.uncertainty.stage).toBe('prepare');
      expect(faultSeam.interceptedAfterPrepareCommit).toBeGreaterThanOrEqual(1);
    }
    expect(faultSeam.interceptedBeforeEngineTransaction).toBe(0);
    expect(faultSeam.interceptedAfterEngineCommit).toBe(0);
    expect(fakeModel.callCount).toBe(1);

    // 2. Clear fault and recover via scheduler.recover without diagnostic recovery
    faultSeam.clearFaults();
    const pointer = scheduler.hydrator.dehydrate(enrollment);
    const recomposedResult = await createAnswerHost({ storage: f.storageConfig, keyringPath: join(f.root, 'keys', 'keyring.json'), workflowStoragePath: f.workflowsDir, model: fakeModel, faultSeam }, signal);
    expect(recomposedResult.kind).toBe('created');
    if (recomposedResult.kind !== 'created') return;

    const recoverResult = await recomposedResult.scheduler.recover(pointer, signal);
    expect(recoverResult.kind).toBe('ready');
    if (recoverResult.kind !== 'ready') return;
    const { runner: recoveredRunner, enrollment: recoveredEnrollment } = recoverResult;
    expect(fakeModel.callCount).toBe(1);

    fakeModel.setQueuedResponses([{
      responseText: 'Step 2 response',
      calls: [{ id: 'call_step2_successor', name: 'answer_work', argumentsJson: JSON.stringify({ answer: { notes: 'Step 2 observation' } }) }],
    }]);

    // 3. Recovered runner.runTurn replays/finishes original retained response without new inference
    const turn1Outcome = await recoveredRunner.runTurn(signal);
    expect(turn1Outcome.kind).toBe('advanced');
    if (turn1Outcome.kind !== 'advanced') return;
    const step1Receipt = turn1Outcome.receipt;
    expect(fakeModel.callCount).toBe(1);

    expect(turn1Outcome.nextView.kind).toBe('question');
    if (turn1Outcome.nextView.kind !== 'question') return;
    const question2View = turn1Outcome.nextView;
    expect(question2View.instruction).toBe('Record second observation.');
    expect(question2View.retained).toHaveLength(1);
    expect(question2View.retained[0]!.receipt).toBe(step1Receipt);

    // 4. Next turn fresh successor completes
    const turn2Outcome = await recoveredRunner.runTurn(signal);
    expect(turn2Outcome.kind).toBe('advanced');
    if (turn2Outcome.kind !== 'advanced') return;
    const step2Receipt = turn2Outcome.receipt;
    expect(step2Receipt).not.toBe(step1Receipt);
    expect(fakeModel.callCount).toBe(2);

    expect(turn2Outcome.nextView.kind).toBe('finished');
    if (turn2Outcome.nextView.kind !== 'finished') return;
    const finalView = turn2Outcome.nextView;
    expect(finalView.execution.kind).toBe('completed');
    expect(finalView.taskOutcome).toBe('unknown');
    expect(finalView.retained.map(r => r.receipt)).toEqual([step1Receipt, step2Receipt]);

    // 5. Verify actual model prompt history: original reply/task, successor task, no extra calls, no owner/reply
    expect(fakeModel.promptHistory).toHaveLength(2);
    expectPrompt(fakeModel.promptHistory[0]!, initialView);
    expect(fakeModel.promptHistory[0]!.instruction).toBe('Record first observation.');
    expectPrompt(fakeModel.promptHistory[1]!, question2View);
    expect(fakeModel.promptHistory[1]!.instruction).toBe('Record second observation.');
    expect('reply' in fakeModel.promptHistory[0]!).toBe(false);
    expect('owner' in fakeModel.promptHistory[0]!).toBe(false);
    expect('reply' in fakeModel.promptHistory[1]!).toBe(false);
    expect('owner' in fakeModel.promptHistory[1]!).toBe(false);

    // 6. No diagnostic journal recovery/dispatch before execution finishes; inspect exact 2 accepted payloads/returned receipts after
    const recPorts = recomposedResult.scheduler.bindDiagnosticPorts(recoveredEnrollment);
    const r1 = await recPorts.inspector.inspectReceipt(finalView.read, step1Receipt, signal);
    const r2 = await recPorts.inspector.inspectReceipt(finalView.read, step2Receipt, signal);
    expect(r1.kind).toBe('complete');
    if (r1.kind === 'complete') {
      expect(r1.disposition).toBe('accepted');
      expect(r1.receipt).toBe(step1Receipt);
      expect(JSON.parse(r1.chunk)).toEqual({ notes: 'Step 1 observation' });
    }
    expect(r2.kind).toBe('complete');
    if (r2.kind === 'complete') {
      expect(r2.disposition).toBe('accepted');
      expect(r2.receipt).toBe(step2Receipt);
      expect(JSON.parse(r2.chunk)).toEqual({ notes: 'Step 2 observation' });
    }
  }));
}
