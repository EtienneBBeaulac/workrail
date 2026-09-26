/** Candidate host owner race acceptance probes for answer-driven execution.
 * Covers:
 * - Positive control: Real no-fault host progresses actual two-step notes workflow to completion
 *   with genuine single ownership, recomposes against storage, and recovers retained evidence.
 * - DI8 Case 1: Late old-owner journal write at before_delivery_append.
 *   Deterministic fault barrier pauses old runner before journal delivery append lock.
 *   Second scheduler recovers same execution, acquires replacement owner (same execution,
 *   monotonic bigint epoch ordering replacement > old), and completes rightful turn.
 *   Stale old runner resumes and returns stale_owner with zero writes to authoritative storage.
 * - DI8 Case 2: Late old-owner journal write at before_capture_append.
 *   Deterministic fault barrier pauses old runner before journal capture append lock.
 *   Replacement scheduler acquires replacement owner and performs rightful turn.
 *   Released old runner returns stale_owner with zero writes to authoritative storage.
 * - DI8 Case 3: Old prepared dispatcher paused before_engine_transaction.
 *   Deterministic fault barrier pauses old dispatcher at declared pre-lock seam before engine
 *   transaction. Replacement scheduler recovers same execution, performs rightful turn and
 *   commits to engine. Released old dispatcher returns stale_owner without modifying journal.
 *   Exactly one first accepted contribution exists. Replay/recovery has zero new inference.
 *   Successor receives fresh prompt with strict full object equality, and replacement runner
 *   finishes step 2 with exact two receipts/payloads.
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
  AnswerHostConfig,
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
  HostEnrollment,
  OwnerFence,
  RawModelResponse,
} from './invocation-contract.js';
import type {
  EvidenceReadResult,
  HostInspectorPort,
  ReceiptRef,
  WorkView,
} from './answer-contract.js';

function expectPrompt(input: ModelPromptInput, view: Extract<WorkView, { kind: 'question' }>): void {
  expect(input).toEqual({
    instruction: view.instruction, answerFormat: view.answerFormat,
    issues: view.issues,
    retainedSummaries: view.retained,
  });
}

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

class OperationTimedOut extends Error {}

/** Executes an async operation with a bounded deadline and abort propagation.
 * Cleans up timer and abort listener on completion; never hangs Vitest on pre-lock violation.
 */
async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  controller?: AbortController,
): Promise<T> {
  const signal = controller?.signal;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new OperationTimedOut(`Operation '${label}' timed out after ${timeoutMs}ms`));
      controller?.abort();
    }, timeoutMs);
  });
  const abortPromise = new Promise<never>((_, reject) => {
    if (signal?.aborted) {
      reject(new Error(`Operation '${label}' aborted`));
      return;
    }
    onAbort = () => reject(new Error(`Operation '${label}' aborted`));
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([promise, timeoutPromise, abortPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** A live operation keeps its owned directory: cleanup must not race late writes. */
class CleanupIncomplete extends Error {}
async function drainOldTurn(oldTurnPromise: Promise<TurnOutcome>, timeoutMs = 1000): Promise<void> {
  try {
    await withDeadline(oldTurnPromise.then(() => undefined, () => undefined), timeoutMs, 'drain old turn');
  } catch {
    throw new CleanupIncomplete('Old turn did not settle after cancellation; preserving temporary storage');
  }
}

/** Deterministic promise-based barrier with bounded deadlines and AbortSignal support.
 * Cleans up timers and abort listeners on completion to avoid unobserved rejected promises.
 */
class PromiseBarrier {
  public readonly id: string;
  private hasEntered = false;
  private enteredResolve!: () => void;
  public readonly enteredPromise: Promise<void>;

  private hasReleased = false;
  private releaseResolve!: () => void;
  public readonly releasePromise: Promise<void>;

  constructor(id: string) {
    this.id = id;
    this.enteredPromise = new Promise<void>((resolve) => {
      this.enteredResolve = resolve;
    });
    this.releasePromise = new Promise<void>((resolve) => {
      this.releaseResolve = resolve;
    });
  }

  notifyEntered(): void {
    if (!this.hasEntered) {
      this.hasEntered = true;
      this.enteredResolve();
    }
  }

  async waitEntered(timeoutMs = 5000, signal?: AbortSignal): Promise<void> {
    if (this.hasEntered) return;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Barrier '${this.id}' waitEntered timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    const abortPromise = new Promise<never>((_, reject) => {
      if (signal?.aborted) {
        reject(new Error(`Barrier '${this.id}' waitEntered aborted`));
        return;
      }
      onAbort = () => reject(new Error(`Barrier '${this.id}' waitEntered aborted`));
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    try {
      await Promise.race([this.enteredPromise, timeoutPromise, abortPromise]);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  release(): void {
    if (!this.hasReleased) {
      this.hasReleased = true;
      this.releaseResolve();
    }
  }

  async waitRelease(timeoutMs = 5000, signal?: AbortSignal): Promise<void> {
    if (this.hasReleased) return;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Barrier '${this.id}' waitRelease timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    const abortPromise = new Promise<never>((_, reject) => {
      if (signal?.aborted) {
        reject(new Error(`Barrier '${this.id}' waitRelease aborted`));
        return;
      }
      onAbort = () => reject(new Error(`Barrier '${this.id}' waitRelease aborted`));
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    try {
      await Promise.race([this.releasePromise, timeoutPromise, abortPromise]);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }
}

/** Test fault seam interceptor to induce controlled barrier pauses at declared journal boundaries. */
class TestJournalFaultSeam implements DurableJournalFaultSeam {
  public interceptedCounts = new Map<JournalFaultBoundary, number>();
  private barriers = new Map<JournalFaultBoundary, PromiseBarrier>();

  setBarrier(boundary: JournalFaultBoundary, barrier: PromiseBarrier): void {
    this.barriers.set(boundary, barrier);
  }

  clearBarrier(boundary: JournalFaultBoundary): void {
    this.barriers.delete(boundary);
  }

  async intercept(
    boundary: JournalFaultBoundary,
    execution: ExecutionRef,
    signal: AbortSignal,
  ): Promise<JournalFaultAction> {
    const count = this.interceptedCounts.get(boundary) ?? 0;
    this.interceptedCounts.set(boundary, count + 1);

    const barrier = this.barriers.get(boundary);
    if (barrier) {
      barrier.notifyEntered();
      await barrier.waitRelease(15000, signal);
      return { kind: 'proceed' };
    }
    return { kind: 'proceed' };
  }
}

interface HostFixtureContext {
  root: string;
  storageConfig: HostJournalStorageConfig;
  workflowsDir: string;
  loadFactory: () => Promise<typeof import('./host-composition.js').createAnswerHost>;
  snapshotFiles: (dir?: string) => Promise<Record<string, string>>;
}

/** Real temporary filesystem fixture with genuine storage directories and workflow definitions. */
async function hostOwnerRacesFixture(run: (f: HostFixtureContext) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'workrail-host-owner-races-'));
  const journalRootDir = join(root, 'answer-v1', 'sessions');
  const hostIndexRootDir = join(root, 'answer-v1', 'host-index');
  const workflowsDir = join(root, 'workflows');

  await mkdir(journalRootDir, { recursive: true });
  await mkdir(hostIndexRootDir, { recursive: true });
  await mkdir(workflowsDir, { recursive: true });

  // Real notes workflow omitting outputContract (wr.contracts.notes does not exist)
  const twoStepWorkflowDefinition = {
    id: 'two-step-test',
    name: 'Two Step Acceptance Test Workflow',
    description: 'Actual two-step workflow for host owner race acceptance probes',
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
    const result: Record<string, string> = { [dir]: '<directory>' };
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

  let cleanupSafe = true;
  try {
    await run({
      root,
      storageConfig: { journalRootDir, hostIndexRootDir },
      workflowsDir,
      loadFactory: loadCandidateHostFactory,
      snapshotFiles,
    });
  } catch (error) {
    if (error instanceof CleanupIncomplete || error instanceof OperationTimedOut) {
      cleanupSafe = false;
      error.message += `: ${root}`;
    }
    throw error;
  } finally {
    if (cleanupSafe) await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. Positive Control: Real no-fault host progresses actual two-step workflow
// ---------------------------------------------------------------------------

it('positive control: real no-fault host progresses actual two-step workflow with genuine ownership', () => hostOwnerRacesFixture(async f => {
  const createAnswerHost = await f.loadFactory();

  const fakeModel = new FakeTestModelBoundary();
  fakeModel.setQueuedResponses([
    {
      responseText: 'Step 1 positive control response',
      calls: [{
        id: 'call_positive_1',
        name: 'answer_work',
        argumentsJson: JSON.stringify({ answer: { notes: 'Step 1 positive control observation' } }),
      }],
    },
    {
      responseText: 'Step 2 positive control response',
      calls: [{
        id: 'call_positive_2',
        name: 'answer_work',
        argumentsJson: JSON.stringify({ answer: { notes: 'Step 2 positive control observation' } }),
      }],
    },
  ]);

  const config: AnswerHostConfig = {
    storage: f.storageConfig,
    keyringPath: join(f.root, 'keys', 'keyring.json'), workflowStoragePath: f.workflowsDir,
    model: fakeModel,
  };

  const controller = new AbortController();
  const signal = controller.signal;
  const hostResult = await createAnswerHost(config, signal);
  expect(hostResult.kind).toBe('created');
  if (hostResult.kind !== 'created') return;

  const scheduler = hostResult.scheduler;
  const workRequest: HostWorkRequest = {
    workflowId: 'two-step-test',
    goal: 'Positive control owner test run',
    workspacePath: f.root,
  };

  // 1. Enroll host session
  const enrollResult = await scheduler.enroll(workRequest, signal);
  expect(enrollResult.kind).toBe('enrolled');
  if (enrollResult.kind !== 'enrolled') return;

  const { runner, initialView, enrollment, owner } = enrollResult;
  expect(initialView.kind).toBe('question');
  if (initialView.kind !== 'question') return;
  expect(initialView.retained).toHaveLength(0);
  expect(owner.execution).toBe(enrollment.execution);

  // 2. Turn 1: Advance from step-1 to step-2
  const outcome1 = await runner.runTurn(signal);
  expect(outcome1.kind).toBe('advanced');
  if (outcome1.kind !== 'advanced') return;

  expect(fakeModel.callCount).toBe(1);
  expect(outcome1.nextView.kind).toBe('question');
  if (outcome1.nextView.kind !== 'question') return;
  expect(outcome1.nextView.retained).toHaveLength(1);
  const receipt1 = outcome1.receipt;
  expect(outcome1.nextView.retained[0]!.receipt).toBe(receipt1);
  expectPrompt(fakeModel.promptHistory[0]!, initialView);

  // 3. Turn 2: Advance from step-2 to finished
  const outcome2 = await runner.runTurn(signal);
  expect(outcome2.kind).toBe('advanced');
  if (outcome2.kind !== 'advanced') return;

  expect(fakeModel.callCount).toBe(2);
  expect(fakeModel.promptHistory).toHaveLength(2);
  expectPrompt(fakeModel.promptHistory[1]!, outcome1.nextView);

  // 4. Narrow finalView without casting or unreachable settled branch
  const finalView = outcome2.nextView;
  expect(finalView.kind).toBe('finished');
  if (finalView.kind !== 'finished') return;

  expect(finalView.execution.kind).toBe('completed');
  expect(finalView.taskOutcome).toBe('unknown');
  expect(finalView.retained).toHaveLength(2);

  const receipt2 = outcome2.receipt;
  expect(receipt1).not.toBe(receipt2);
  expect(finalView.retained[0]!.receipt).toBe(receipt1);
  expect(finalView.retained[1]!.receipt).toBe(receipt2);

  // 5. Assert exact JSON payload through trusted HostInspectorPort
  const ports = scheduler.bindDiagnosticPorts(enrollment);

  const read1 = await ports.inspector.inspectReceipt(finalView.read, receipt1, signal);
  expect(read1.kind).toBe('complete');
  if (read1.kind === 'complete') {
    expect(read1.disposition).toBe('accepted');
    const parsed1 = JSON.parse(read1.chunk) as { notes?: string };
    expect(parsed1).toEqual({ notes: 'Step 1 positive control observation' });
    expect(read1.receipt).toBe(receipt1);
  }

  const read2 = await ports.inspector.inspectReceipt(finalView.read, receipt2, signal);
  expect(read2.kind).toBe('complete');
  if (read2.kind === 'complete') {
    expect(read2.disposition).toBe('accepted');
    const parsed2 = JSON.parse(read2.chunk) as { notes?: string };
    expect(parsed2).toEqual({ notes: 'Step 2 positive control observation' });
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

  expect(recovered.receipt).toBe(receipt2);
  expect(recovered.view.kind).toBe('finished');
  expect(recovered.view.execution.kind).toBe('completed');
  expect(recovered.view.taskOutcome).toBe('unknown');
  expect(recovered.view.retained).toHaveLength(2);
  expect(recovered.view.retained[0]!.receipt).toBe(receipt1);
  expect(recovered.view.retained[1]!.receipt).toBe(receipt2);
}));

async function verifyReplacementSuccessor(
  runner: import('./host-composition.js').BoundTurnRunner,
  pending: Extract<WorkView, { kind: 'question' }>,
  firstReceipt: import('./answer-contract.js').ReceiptRef,
  ports: import('./invocation-contract.js').HostExecutorPorts,
  model: FakeTestModelBoundary,
  controller: AbortController,
  expectedCalls: number,
  firstNotes: string,
  secondNotes: string,
): Promise<void> {
  model.setQueuedResponses([{ responseText: 'Fresh successor', calls: [{
    id: 'fresh_successor', name: 'answer_work',
    argumentsJson: JSON.stringify({ answer: { notes: secondNotes } }),
  }] }]);
  const result = await withDeadline(runner.runTurn(controller.signal), 5000, 'successor', controller);
  expect(result.kind).toBe('advanced');
  if (result.kind !== 'advanced') return;
  expect(result.nextView.kind).toBe('finished');
  if (result.nextView.kind !== 'finished') return;
  expect(result.nextView.execution.kind).toBe('completed');
  expect(result.nextView.taskOutcome).toBe('unknown');
  expect(result.nextView.retained.map(item => item.receipt)).toEqual([firstReceipt, result.receipt]);
  expect(firstReceipt).not.toBe(result.receipt);
  expect(model.callCount).toBe(expectedCalls);
  expectPrompt(model.promptHistory[expectedCalls - 1]!, pending);
  expect(pending.instruction).toBe('Record second observation.');
  for (const [receipt, notes] of [[firstReceipt, firstNotes], [result.receipt, secondNotes]] as const) {
    const read = await ports.inspector.inspectReceipt(result.nextView.read, receipt, controller.signal);
    expect(read.kind).toBe('complete');
    if (read.kind !== 'complete') return;
    expect(read.receipt).toBe(receipt);
    expect(read.disposition).toBe('accepted');
    expect(JSON.parse(read.chunk)).toEqual({ notes });
  }
}

// ---------------------------------------------------------------------------
// 2. DI8 Case 1: Late old-owner journal write at before_delivery_append
// ---------------------------------------------------------------------------

it('DI8 Case 1: late old-owner journal write at before_delivery_append paused pre-lock yields stale_owner with zero storage writes', () => hostOwnerRacesFixture(async f => {
  const createAnswerHost = await f.loadFactory();

  const fakeModel = new FakeTestModelBoundary();
  fakeModel.setQueuedResponses([
    {
      responseText: 'Step 1 replacement response',
      calls: [{
        id: 'call_rep_delivery_1',
        name: 'answer_work',
        argumentsJson: JSON.stringify({ answer: { notes: 'Step 1 replacement delivery note' } }),
      }],
    },
    {
      responseText: 'Step 2 replacement response',
      calls: [{
        id: 'call_rep_delivery_2',
        name: 'answer_work',
        argumentsJson: JSON.stringify({ answer: { notes: 'Step 2 replacement delivery note' } }),
      }],
    },
  ]);

  const faultSeam = new TestJournalFaultSeam();
  const deliveryBarrier = new PromiseBarrier('barrier_before_delivery_append');
  faultSeam.setBarrier('before_delivery_append', deliveryBarrier);

  const config: AnswerHostConfig = {
    storage: f.storageConfig,
    keyringPath: join(f.root, 'keys', 'keyring.json'), workflowStoragePath: f.workflowsDir,
    model: fakeModel,
    faultSeam,
  };

  const controller = new AbortController();
  const signal = controller.signal;
  const hostResult1 = await createAnswerHost(config, signal);
  expect(hostResult1.kind).toBe('created');
  if (hostResult1.kind !== 'created') return;

  const scheduler1 = hostResult1.scheduler;
  const enrollResult = await scheduler1.enroll({
    workflowId: 'two-step-test',
    goal: 'DI8 late delivery append race',
    workspacePath: f.root,
  }, signal);
  expect(enrollResult.kind).toBe('enrolled');
  if (enrollResult.kind !== 'enrolled') return;

  const oldEnrollment = enrollResult.enrollment;
  const oldOwner = enrollResult.owner;
  const oldRunner = enrollResult.runner;
  const initialView = enrollResult.initialView;
  expect(initialView.kind).toBe('question');

  const oldController = new AbortController();
  const forwardAbort = () => oldController.abort();
  signal.addEventListener('abort', forwardAbort, { once: true });

  // Launch old runner turn 1 asynchronously; will pause at before_delivery_append pre-lock
  const oldTurnPromise = oldRunner.runTurn(oldController.signal);
  // Attach rejection handler immediately without hiding normal awaited result
  oldTurnPromise.catch(() => {});
  let primaryFailure: unknown;

  try {
    // Wait until old runner enters before_delivery_append barrier
    await deliveryBarrier.waitEntered(5000, signal);

    // Dehydrate pointer for second scheduler recovery of SAME execution
    const pointer = scheduler1.hydrator.dehydrate(oldEnrollment);

    // Create second scheduler against same storage roots
    const hostResult2 = await createAnswerHost(config, signal);
    expect(hostResult2.kind).toBe('created');
    if (hostResult2.kind !== 'created') return;
    const scheduler2 = hostResult2.scheduler;

    // Second scheduler recovers same execution; acquires replacement ownership with bounded deadline
    const recoverResult = await withDeadline(scheduler2.recover(pointer, signal), 5000, 'scheduler2 recover', controller);
    expect(recoverResult.kind).toBe('ready');
    if (recoverResult.kind !== 'ready') return;

    const replacementRunner = recoverResult.runner;
    const replacementOwner = recoverResult.owner;
    const replacementEnrollment = recoverResult.enrollment;

    // Assert same execution owner identity: monotonic epoch ordering replacement > old
    expect(replacementOwner.execution).toBe(oldOwner.execution);
    expect(replacementOwner.epoch > oldOwner.epoch).toBe(true);
    expect(replacementEnrollment.execution).toBe(oldEnrollment.execution);

    // Baseline snapshot of authoritative session journal (nonempty)

    // Second scheduler performs rightful operation
    // Temporarily clear barrier on faultSeam so replacement runner proceeds without pausing
    faultSeam.clearBarrier('before_delivery_append');

    const replacementOutcome = await withDeadline(replacementRunner.runTurn(signal), 5000, 'replacement runTurn', controller);
    expect(replacementOutcome.kind).toBe('advanced');
    if (replacementOutcome.kind !== 'advanced') return;
    expect(replacementOutcome.nextView.kind).toBe('question');
    if (replacementOutcome.nextView.kind !== 'question') return;
    expect(replacementOutcome.nextView.retained).toHaveLength(1);

    // Inspect exact rightful receipt and note
    const replacementReceipt = replacementOutcome.receipt;
    expect(replacementOutcome.nextView.retained[0]!.receipt).toBe(replacementReceipt);

    const ports2 = scheduler2.bindDiagnosticPorts(replacementEnrollment);
    const readRep = await ports2.inspector.inspectReceipt(
      replacementOutcome.nextView.read,
      replacementReceipt,
      signal,
    );
    expect(readRep.kind).toBe('complete');
    if (readRep.kind === 'complete') {
      expect(readRep.disposition).toBe('accepted');
      const parsed = JSON.parse(readRep.chunk) as { notes?: string };
      expect(parsed).toEqual({ notes: 'Step 1 replacement delivery note' });
      expect(readRep.receipt).toBe(replacementReceipt);
    }

    // Old and replacement operations both reach the seam
    expect(faultSeam.interceptedCounts.get('before_delivery_append')).toBe(2);

    // Authoritative journal snapshot after rightful replacement advance (nonempty)
    const postReplacementSnapshot = await f.snapshotFiles(f.storageConfig.journalRootDir);
    expect(Object.values(postReplacementSnapshot).some(value => value !== '<directory>')).toBe(true);

    // Now release old runner from barrier
    deliveryBarrier.release();

    // Old runner resumes attempting delivery append under stale owner (bounded stale settle)
    const oldOutcome = await withDeadline(oldTurnPromise, 5000, 'old runner stale settle', controller);
    expect(oldOutcome.kind).toBe('stale_owner');

    // First delivery case: exactly 1 model inference (replacement only; old runner was paused before delivery)
    // Verify old model does not run post-refusal
    expect(fakeModel.callCount).toBe(1);
    expect(fakeModel.promptHistory).toHaveLength(1);

    // Authoritative journal bytes must remain strictly identical: zero writes by stale owner
    const postOldSnapshot = await f.snapshotFiles(f.storageConfig.journalRootDir);
    expect(postOldSnapshot).toEqual(postReplacementSnapshot);
    await verifyReplacementSuccessor(replacementRunner, replacementOutcome.nextView,
      replacementReceipt, ports2, fakeModel, controller, 2,
      'Step 1 replacement delivery note', 'Step 2 replacement delivery note');
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    deliveryBarrier.release();
    controller.abort();
    oldController.abort();
    signal.removeEventListener('abort', forwardAbort);
    try {
      await drainOldTurn(oldTurnPromise);
    } catch (cleanupError) {
      if (cleanupError instanceof Error) cleanupError.cause = primaryFailure;
      throw cleanupError;
    }
  }
}));

// ---------------------------------------------------------------------------
// 3. DI8 Case 2: Late old-owner journal write at before_capture_append
// ---------------------------------------------------------------------------

it('DI8 Case 2: late old-owner journal write at before_capture_append paused pre-lock yields stale_owner with zero storage writes', () => hostOwnerRacesFixture(async f => {
  const createAnswerHost = await f.loadFactory();

  const fakeModel = new FakeTestModelBoundary();
  fakeModel.setQueuedResponses([
    {
      responseText: 'Step 1 old response to be abandoned',
      calls: [{
        id: 'call_old_capture_1',
        name: 'answer_work',
        argumentsJson: JSON.stringify({ answer: { notes: 'Old capture note - must be rejected' } }),
      }],
    },
    {
      responseText: 'Step 1 replacement response',
      calls: [{
        id: 'call_rep_capture_1',
        name: 'answer_work',
        argumentsJson: JSON.stringify({ answer: { notes: 'Step 1 replacement capture note' } }),
      }],
    },
  ]);

  const faultSeam = new TestJournalFaultSeam();
  const captureBarrier = new PromiseBarrier('barrier_before_capture_append');
  faultSeam.setBarrier('before_capture_append', captureBarrier);

  const config: AnswerHostConfig = {
    storage: f.storageConfig,
    keyringPath: join(f.root, 'keys', 'keyring.json'), workflowStoragePath: f.workflowsDir,
    model: fakeModel,
    faultSeam,
  };

  const controller = new AbortController();
  const signal = controller.signal;
  const hostResult1 = await createAnswerHost(config, signal);
  expect(hostResult1.kind).toBe('created');
  if (hostResult1.kind !== 'created') return;

  const scheduler1 = hostResult1.scheduler;
  const enrollResult = await scheduler1.enroll({
    workflowId: 'two-step-test',
    goal: 'DI8 late capture append race',
    workspacePath: f.root,
  }, signal);
  expect(enrollResult.kind).toBe('enrolled');
  if (enrollResult.kind !== 'enrolled') return;

  const oldEnrollment = enrollResult.enrollment;
  const oldOwner = enrollResult.owner;
  const oldRunner = enrollResult.runner;

  const oldController = new AbortController();
  const forwardAbort = () => oldController.abort();
  signal.addEventListener('abort', forwardAbort, { once: true });

  // Launch old runner turn 1 asynchronously; will pause at before_capture_append pre-lock
  const oldTurnPromise = oldRunner.runTurn(oldController.signal);
  // Attach rejection handler immediately without hiding normal awaited result
  oldTurnPromise.catch(() => {});
  let primaryFailure: unknown;

  try {
    // Wait until old runner enters before_capture_append barrier
    await captureBarrier.waitEntered(5000, signal);

    // Dehydrate pointer for second scheduler recovery of SAME execution
    const pointer = scheduler1.hydrator.dehydrate(oldEnrollment);

    // Create second scheduler against same storage roots
    const hostResult2 = await createAnswerHost(config, signal);
    expect(hostResult2.kind).toBe('created');
    if (hostResult2.kind !== 'created') return;
    const scheduler2 = hostResult2.scheduler;

    // Second scheduler recovers same execution; acquires replacement ownership with bounded deadline
    const recoverResult = await withDeadline(scheduler2.recover(pointer, signal), 5000, 'scheduler2 recover', controller);
    expect(recoverResult.kind).toBe('ready');
    if (recoverResult.kind !== 'ready') return;

    const replacementRunner = recoverResult.runner;
    const replacementOwner = recoverResult.owner;

    // Assert same execution owner identity: monotonic epoch ordering replacement > old
    expect(replacementOwner.execution).toBe(oldOwner.execution);
    expect(replacementOwner.epoch > oldOwner.epoch).toBe(true);
    expect(recoverResult.enrollment.execution).toBe(oldEnrollment.execution);

    // Baseline snapshot of authoritative session journal (nonempty)

    // Second scheduler performs rightful operation
    faultSeam.clearBarrier('before_capture_append');

    const replacementOutcome = await withDeadline(replacementRunner.runTurn(signal), 5000, 'replacement runTurn', controller);
    expect(replacementOutcome.kind).toBe('advanced');
    if (replacementOutcome.kind !== 'advanced') return;
    expect(replacementOutcome.nextView.kind).toBe('question');
    if (replacementOutcome.nextView.kind !== 'question') return;
    expect(replacementOutcome.nextView.retained).toHaveLength(1);

    // Inspect exact rightful receipt and note
    const replacementReceipt = replacementOutcome.receipt;
    expect(replacementOutcome.nextView.retained[0]!.receipt).toBe(replacementReceipt);

    const ports2 = scheduler2.bindDiagnosticPorts(recoverResult.enrollment);
    const readRep = await ports2.inspector.inspectReceipt(
      replacementOutcome.nextView.read,
      replacementReceipt,
      signal,
    );
    expect(readRep.kind).toBe('complete');
    if (readRep.kind === 'complete') {
      expect(readRep.disposition).toBe('accepted');
      const parsed = JSON.parse(readRep.chunk) as { notes?: string };
      expect(parsed).toEqual({ notes: 'Step 1 replacement capture note' });
      expect(readRep.receipt).toBe(replacementReceipt);
    }

    // Old and replacement operations both reach the seam
    expect(faultSeam.interceptedCounts.get('before_capture_append')).toBe(2);

    // Authoritative journal snapshot after rightful replacement advance (nonempty)
    const postReplacementSnapshot = await f.snapshotFiles(f.storageConfig.journalRootDir);
    expect(Object.values(postReplacementSnapshot).some(value => value !== '<directory>')).toBe(true);

    // Release old runner from barrier
    captureBarrier.release();

    // Old runner resumes attempting capture append under stale owner (bounded stale settle)
    const oldOutcome = await withDeadline(oldTurnPromise, 5000, 'old runner stale settle', controller);
    expect(oldOutcome.kind).toBe('stale_owner');

    // Capture case: exactly 2 model inferences (old abandoned + replacement); explicit check after old settles
    // Verify old model does not run post-refusal
    expect(fakeModel.callCount).toBe(2);
    expect(fakeModel.promptHistory).toHaveLength(2);

    // Authoritative journal bytes must remain strictly identical: zero writes by stale owner
    const postOldSnapshot = await f.snapshotFiles(f.storageConfig.journalRootDir);
    expect(postOldSnapshot).toEqual(postReplacementSnapshot);
    await verifyReplacementSuccessor(replacementRunner, replacementOutcome.nextView,
      replacementReceipt, ports2, fakeModel, controller, 3,
      'Step 1 replacement capture note', 'Step 2 replacement capture note');
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    captureBarrier.release();
    controller.abort();
    oldController.abort();
    signal.removeEventListener('abort', forwardAbort);
    try {
      await drainOldTurn(oldTurnPromise);
    } catch (cleanupError) {
      if (cleanupError instanceof Error) cleanupError.cause = primaryFailure;
      throw cleanupError;
    }
  }
}));

// ---------------------------------------------------------------------------
// 4. DI8 Case 3: Old prepared dispatcher paused before_engine_transaction
// ---------------------------------------------------------------------------

it('DI8 Case 3: old prepared dispatcher paused before_engine_transaction pre-lock yields stale_owner, unchanged journal, exactly one first contribution, fresh prompt, and exact final payloads', () => hostOwnerRacesFixture(async f => {
  const createAnswerHost = await f.loadFactory();

  const fakeModel = new FakeTestModelBoundary();
  fakeModel.setQueuedResponses([
    {
      responseText: 'Step 1 response',
      calls: [{
        id: 'call_engine_step1',
        name: 'answer_work',
        argumentsJson: JSON.stringify({ answer: { notes: 'Step 1 observation for engine race' } }),
      }],
    },
    {
      responseText: 'Step 2 response',
      calls: [{
        id: 'call_engine_step2',
        name: 'answer_work',
        argumentsJson: JSON.stringify({ answer: { notes: 'Step 2 observation for engine race' } }),
      }],
    },
  ]);

  const faultSeam = new TestJournalFaultSeam();
  // Seam before_engine_transaction is declared pre-lock, preventing deadlock while paused
  const engineBarrier = new PromiseBarrier('barrier_before_engine_transaction');
  faultSeam.setBarrier('before_engine_transaction', engineBarrier);

  const config: AnswerHostConfig = {
    storage: f.storageConfig,
    keyringPath: join(f.root, 'keys', 'keyring.json'), workflowStoragePath: f.workflowsDir,
    model: fakeModel,
    faultSeam,
  };

  const controller = new AbortController();
  const signal = controller.signal;
  const hostResult1 = await createAnswerHost(config, signal);
  expect(hostResult1.kind).toBe('created');
  if (hostResult1.kind !== 'created') return;

  const scheduler1 = hostResult1.scheduler;
  const enrollResult = await scheduler1.enroll({
    workflowId: 'two-step-test',
    goal: 'DI8 engine transaction race',
    workspacePath: f.root,
  }, signal);
  expect(enrollResult.kind).toBe('enrolled');
  if (enrollResult.kind !== 'enrolled') return;

  const oldEnrollment = enrollResult.enrollment;
  const oldOwner = enrollResult.owner;
  const oldRunner = enrollResult.runner;
  const initialView = enrollResult.initialView;
  expect(initialView.kind).toBe('question');

  const oldController = new AbortController();
  const forwardAbort = () => oldController.abort();
  signal.addEventListener('abort', forwardAbort, { once: true });

  // Launch old runner turn 1 asynchronously; will pause at before_engine_transaction pre-lock
  const oldTurnPromise = oldRunner.runTurn(oldController.signal);
  // Attach rejection handler immediately without hiding normal awaited result
  oldTurnPromise.catch(() => {});
  let primaryFailure: unknown;

  try {
    // Wait until old runner reaches before_engine_transaction barrier
    await engineBarrier.waitEntered(5000, signal);

    // Dehydrate pointer for second scheduler recovery of SAME execution
    const pointer = scheduler1.hydrator.dehydrate(oldEnrollment);

    // Create second scheduler against same storage roots
    const hostResult2 = await createAnswerHost(config, signal);
    expect(hostResult2.kind).toBe('created');
    if (hostResult2.kind !== 'created') return;
    const scheduler2 = hostResult2.scheduler;

    // Second scheduler recovers same execution; acquires replacement ownership with bounded deadline
    const recoverResult = await withDeadline(scheduler2.recover(pointer, signal), 5000, 'scheduler2 recover', controller);
    expect(recoverResult.kind).toBe('ready');
    if (recoverResult.kind !== 'ready') return;

    const replacementRunner = recoverResult.runner;
    const replacementOwner = recoverResult.owner;
    const replacementEnrollment = recoverResult.enrollment;

    // Assert same execution owner identity: monotonic epoch ordering replacement > old
    expect(replacementOwner.execution).toBe(oldOwner.execution);
    expect(replacementOwner.epoch > oldOwner.epoch).toBe(true);
    expect(replacementEnrollment.execution).toBe(oldEnrollment.execution);

    // Baseline snapshot of authoritative session journal (nonempty)

    // Clear faultSeam barrier before replacement runner commits to engine
    faultSeam.clearBarrier('before_engine_transaction');

    // Replacement scheduler performs rightful work and commits to engine
    const replacementOutcome = await withDeadline(replacementRunner.runTurn(signal), 5000, 'replacement runTurn', controller);
    expect(replacementOutcome.kind).toBe('advanced');
    if (replacementOutcome.kind !== 'advanced') return;
    expect(replacementOutcome.nextView.kind).toBe('question');
    if (replacementOutcome.nextView.kind !== 'question') return;

    // Exactly one first accepted contribution
    expect(replacementOutcome.nextView.retained).toHaveLength(1);
    const firstReceipt = replacementOutcome.receipt;
    expect(replacementOutcome.nextView.retained[0]!.receipt).toBe(firstReceipt);

    // Old and replacement operations both reach the seam
    expect(faultSeam.interceptedCounts.get('before_engine_transaction')).toBe(2);

    // Snapshot authoritative session journal after replacement commit (nonempty)
    const postReplacementSnapshot = await f.snapshotFiles(f.storageConfig.journalRootDir);
    expect(Object.values(postReplacementSnapshot).some(value => value !== '<directory>')).toBe(true);

    // Now release old prepared dispatcher from barrier
    engineBarrier.release();

    // Old runner enters engine transaction with stale owner; must refuse without duplicate commit (bounded stale settle)
    const oldOutcome = await withDeadline(oldTurnPromise, 5000, 'old runner stale settle', controller);
    expect(oldOutcome.kind).toBe('stale_owner');

    // Authoritative journal bytes must remain unchanged across stale owner refusal
    const postOldSnapshot = await f.snapshotFiles(f.storageConfig.journalRootDir);
    expect(postOldSnapshot).toEqual(postReplacementSnapshot);

    // Invariant: Exactly one first accepted contribution exists
    expect(replacementOutcome.nextView.retained).toHaveLength(1);
    expect(replacementOutcome.nextView.retained[0]!.receipt).toBe(firstReceipt);

    // Recovery/replay must have zero new inference; old runner already called model once
    expect(fakeModel.callCount).toBe(1);
    expect(fakeModel.promptHistory).toHaveLength(1);

    // Replacement runner executes turn 2 to completion with bounded deadline
    const outcome2 = await withDeadline(replacementRunner.runTurn(signal), 5000, 'replacement turn 2', controller);
    expect(outcome2.kind).toBe('advanced');
    if (outcome2.kind !== 'advanced') return;

    // Successor turn 2 receives fresh prompt with strict full object equality after runner turn 2
    expect(fakeModel.callCount).toBe(2);
    expect(fakeModel.promptHistory).toHaveLength(2);
    expectPrompt(fakeModel.promptHistory[1]!, replacementOutcome.nextView);

    // Narrow finalView without unreachable settled branch
    const finalView = outcome2.nextView;
    expect(finalView.kind).toBe('finished');
    if (finalView.kind !== 'finished') return;

    expect(finalView.execution.kind).toBe('completed');
    expect(finalView.taskOutcome).toBe('unknown');

    // Final exact two receipts
    expect(finalView.retained).toHaveLength(2);
    const secondReceipt = outcome2.receipt;
    expect(finalView.retained[0]!.receipt).toBe(firstReceipt);
    expect(finalView.retained[1]!.receipt).toBe(secondReceipt);
    expect(firstReceipt).not.toBe(secondReceipt);

    // Assert exact two payloads through trusted inspector
    const ports = scheduler2.bindDiagnosticPorts(replacementEnrollment);
    const read1 = await ports.inspector.inspectReceipt(finalView.read, firstReceipt, signal);
    expect(read1.kind).toBe('complete');
    if (read1.kind === 'complete') {
      expect(read1.disposition).toBe('accepted');
      const parsed1 = JSON.parse(read1.chunk) as { notes?: string };
      expect(parsed1).toEqual({ notes: 'Step 1 observation for engine race' });
      expect(read1.receipt).toBe(firstReceipt);
    }

    const read2 = await ports.inspector.inspectReceipt(finalView.read, secondReceipt, signal);
    expect(read2.kind).toBe('complete');
    if (read2.kind === 'complete') {
      expect(read2.disposition).toBe('accepted');
      const parsed2 = JSON.parse(read2.chunk) as { notes?: string };
      expect(parsed2).toEqual({ notes: 'Step 2 observation for engine race' });
      expect(read2.receipt).toBe(secondReceipt);
    }
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    engineBarrier.release();
    controller.abort();
    oldController.abort();
    signal.removeEventListener('abort', forwardAbort);
    try {
      await drainOldTurn(oldTurnPromise);
    } catch (cleanupError) {
      if (cleanupError instanceof Error) cleanupError.cause = primaryFailure;
      throw cleanupError;
    }
  }
}));


it('barrier lifecycle control: release, cancellation, deadline and failed drain remain observable', async () => {
  const barrier = new PromiseBarrier('lifecycle-control');
  let released = false;
  const operation = barrier.waitRelease().then(() => { released = true; });
  barrier.notifyEntered();
  await barrier.waitEntered();
  expect(released).toBe(false);
  barrier.release();
  await operation;
  expect(released).toBe(true);

  const cancelled = new PromiseBarrier('cancel-control');
  const controller = new AbortController();
  const waiting = cancelled.waitRelease(1000, controller.signal);
  const rejected = expect(waiting).rejects.toThrow('aborted');
  controller.abort();
  await rejected;
  cancelled.release();

  const deadlineController = new AbortController();
  await expect(withDeadline(new Promise<never>(() => {}), 5, 'deadline-control', deadlineController)).rejects.toThrow('timed out');
  expect(deadlineController.signal.aborted).toBe(true);
  await expect(drainOldTurn(new Promise<TurnOutcome>(() => {}), 5)).rejects.toBeInstanceOf(CleanupIncomplete);
});
