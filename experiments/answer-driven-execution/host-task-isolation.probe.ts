/** Candidate host task isolation acceptance probes for answer-driven execution.
 * Covers:
 * - Case 1 (Host read scope): Bound inspector refuses foreign task read, receipt,
 *   mixed pairs, and foreign cursors with exact invalid_scope refusal and no leaks.
 *   Authoritative storage bytes remain invariant across refused reads. Rightful
 *   cursors reconstruct exact >8192-byte payload (>2 pages at max 4096 bytes) with
 *   receipt identity, accepted disposition, encoding, UTF8 cap, bounded cursor uniqueness,
 *   and no reply/recovery authority. Both successor runners complete step 2.
 * - Case 2 (Mixed execution IDs): Cross-task owner fences at journal/dispatcher boundary
 *   refuse with stale_owner at capture, prepare (refused stale_owner), and dispatch,
 *   while rightful execution under rightful owner fence succeeds.
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
  HostJournalStorageConfig,
  HostWorkRequest,
  ModelCompletionResult,
  ModelInferenceBoundary,
  ModelPromptInput,
} from './host-composition.js';
import type {
  RawModelResponse,
} from './invocation-contract.js';
import type {
  EvidenceCursor,
  EvidenceReadResult,
  HostInspectorPort,
  ReadRef,
  ReceiptRef,
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

interface HostFixtureContext {
  root: string;
  storageConfig: HostJournalStorageConfig;
  workflowsDir: string;
  loadFactory: () => Promise<typeof import('./host-composition.js').createAnswerHost>;
  snapshotFiles: () => Promise<Record<string, string>>;
}

/** Real temporary filesystem fixture with genuine storage directories and workflow definitions. */
async function hostIsolationFixture(run: (f: HostFixtureContext) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'workrail-host-isolation-acceptance-'));
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
    description: 'Actual two-step workflow for host task isolation acceptance probes',
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

/** Asserts that an EvidenceReadResult is strictly refused with invalid_scope and no leaked data. */
function assertRefusedInvalidScope(result: EvidenceReadResult): void {
  expect(result).toEqual({ kind: 'refused', reason: 'invalid_scope' });
}

/** Paginates through rightful evidence chunks, asserting page contracts and reconstructing JSON payload. */
async function reconstructRightfulPayload(
  inspector: HostInspectorPort,
  read: ReadRef,
  receipt: ReceiptRef,
  signal: AbortSignal,
  firstPage: EvidenceReadResult,
): Promise<{ jsonString: string; pageCount: number }> {
  let currentCursor: EvidenceCursor | undefined = undefined;
  const seenCursors = new Set<string>();
  let reconstructedJson = '';
  let pageCount = 0;
  let reachedComplete = false;

  while (!reachedComplete) {
    expect(pageCount, 'Fixture must terminate within 16 pages').toBeLessThan(16);
    const page: EvidenceReadResult = pageCount === 0 ? firstPage
      : await inspector.inspectReceipt(read, receipt, signal, currentCursor);

    // Read result shape: strictly no reply or recovery authority
    const raw = page as Record<string, unknown>;
    expect(raw['reply']).toBeUndefined();
    expect(raw['recovery']).toBeUndefined();

    if (page.kind === 'refused') {
      expect.fail(`Rightful read unexpectedly refused: ${page.reason}`);
    }

    // Receipt identity, accepted disposition, encoding
    expect(page.receipt).toBe(receipt);
    expect(page.disposition).toBe('accepted');
    expect(page.encoding).toBe('canonical_json');
    expect(Object.keys(page).sort()).toEqual((page.kind === 'more'
      ? ['kind', 'receipt', 'disposition', 'encoding', 'chunk', 'next']
      : ['kind', 'receipt', 'disposition', 'encoding', 'chunk']).sort());

    // UTF8 cap: max 4096 bytes per chunk
    const chunkBytes = Buffer.byteLength(page.chunk, 'utf8');
    expect(chunkBytes).toBeGreaterThan(0);
    expect(chunkBytes).toBeLessThanOrEqual(4096);

    reconstructedJson += page.chunk;
    pageCount++;

    if (page.kind === 'more') {
      // Termination / cursor uniqueness bounded
      expect(seenCursors.has(page.next)).toBe(false);
      seenCursors.add(page.next);
      currentCursor = page.next;
    } else if (page.kind === 'complete') {
      reachedComplete = true;
    }
  }

  return { jsonString: reconstructedJson, pageCount };
}

// ---------------------------------------------------------------------------
// 1. Host Read Scope: Bound inspector isolation between Task A and Task B
// ---------------------------------------------------------------------------

it('host read scope: bound inspector refuses foreign task read, receipt, mixed pairs, and foreign cursors with invalid_scope, preserving authoritative storage and rightful reconstruction', () => hostIsolationFixture(async f => {
  const createAnswerHost = await f.loadFactory();

  // Create real first accepted notes > 8192 UTF-8 bytes to ensure > 2 receipt pages (max 4096 bytes each)
  const noteA1 = 'Observation A1 payload prefix: ' + 'Aé🙂'.repeat(1300);
  const noteB1 = 'Observation B1 payload prefix: ' + 'Bø🚀'.repeat(1300);
  expect(Buffer.byteLength(noteA1, 'utf8')).toBeGreaterThan(8192);
  expect(Buffer.byteLength(noteB1, 'utf8')).toBeGreaterThan(8192);

  const noteA2 = 'Observation A2 final notes';
  const noteB2 = 'Observation B2 final notes';

  const fakeModel = new FakeTestModelBoundary();
  fakeModel.setQueuedResponses([
    {
      responseText: 'Step 1 Task A response',
      calls: [{
        id: 'call_a_1',
        name: 'answer_work',
        argumentsJson: JSON.stringify({ answer: { notes: noteA1 } }),
      }],
    },
    {
      responseText: 'Step 1 Task B response',
      calls: [{
        id: 'call_b_1',
        name: 'answer_work',
        argumentsJson: JSON.stringify({ answer: { notes: noteB1 } }),
      }],
    },
    {
      responseText: 'Step 2 Task A response',
      calls: [{
        id: 'call_a_2',
        name: 'answer_work',
        argumentsJson: JSON.stringify({ answer: { notes: noteA2 } }),
      }],
    },
    {
      responseText: 'Step 2 Task B response',
      calls: [{
        id: 'call_b_2',
        name: 'answer_work',
        argumentsJson: JSON.stringify({ answer: { notes: noteB2 } }),
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

  // 1. Enroll Task A
  const workRequestA: HostWorkRequest = {
    workflowId: 'two-step-test',
    goal: 'Task A isolation probe',
    workspacePath: f.root,
  };
  const enrollA = await scheduler.enroll(workRequestA, signal);
  expect(enrollA.kind).toBe('enrolled');
  if (enrollA.kind !== 'enrolled') return;
  const { runner: runnerA, enrollment: enrollmentA, initialView: initialViewA } = enrollA;

  // 2. Enroll Task B
  const workRequestB: HostWorkRequest = {
    workflowId: 'two-step-test',
    goal: 'Task B isolation probe',
    workspacePath: f.root,
  };
  const enrollB = await scheduler.enroll(workRequestB, signal);
  expect(enrollB.kind).toBe('enrolled');
  if (enrollB.kind !== 'enrolled') return;
  const { runner: runnerB, enrollment: enrollmentB, initialView: initialViewB } = enrollB;

  expect(initialViewA.kind).toBe('question');
  expect(initialViewB.kind).toBe('question');
  expect(enrollmentA.execution).not.toBe(enrollmentB.execution);

  // 3. First turn for Task A: advance step 1 -> step 2
  const outcomeA1 = await runnerA.runTurn(signal);
  expect(outcomeA1.kind).toBe('advanced');
  if (outcomeA1.kind !== 'advanced') return;
  expect(outcomeA1.nextView.kind).toBe('question');
  expect(outcomeA1.nextView.retained).toHaveLength(1);
  const receiptA1 = outcomeA1.receipt;
  const readA = outcomeA1.nextView.read;

  // 4. First turn for Task B: advance step 1 -> step 2
  const outcomeB1 = await runnerB.runTurn(signal);
  expect(outcomeB1.kind).toBe('advanced');
  if (outcomeB1.kind !== 'advanced') return;
  expect(outcomeB1.nextView.kind).toBe('question');
  expect(outcomeB1.nextView.retained).toHaveLength(1);
  const receiptB1 = outcomeB1.receipt;
  const readB = outcomeB1.nextView.read;

  expect(receiptA1).not.toBe(receiptB1);
  expect(readA).not.toBe(readB);

  // 5. Bind task-bound diagnostic inspectors
  const portsA = scheduler.bindDiagnosticPorts(enrollmentA);
  const portsB = scheduler.bindDiagnosticPorts(enrollmentB);
  expect(portsA.inspector.scope).toBe('host_bound');
  expect(portsB.inspector.scope).toBe('host_bound');

  // Obtain legitimate cursor from Task B page 1 for cross-scope cursor testing
  const pageB1 = await portsB.inspector.inspectReceipt(readB, receiptB1, signal);
  expect(pageB1.kind).toBe('more');
  if (pageB1.kind !== 'more') return;
  const cursorB1 = pageB1.next;
  const pageA1 = await portsA.inspector.inspectReceipt(readA, receiptA1, signal);
  expect(pageA1.kind).toBe('more');
  if (pageA1.kind !== 'more') return;
  const cursorA1 = pageA1.next;

  // 6. Snapshot authoritative files before refused cross-task read attempts
  const snapshotBeforeRefused = await f.snapshotFiles();
  expect(Object.keys(snapshotBeforeRefused).length).toBeGreaterThan(0);

  // 7. Inspector A refuses foreign task read/receipt combinations with exact invalid_scope
  // 7a. Matching pair from Task B
  const refusedMatchingBOnA = await portsA.inspector.inspectReceipt(readB, receiptB1, signal);
  assertRefusedInvalidScope(refusedMatchingBOnA);

  // 7b. Mixed pair: own readA with foreign receiptB1
  const refusedMixedReceiptOnA = await portsA.inspector.inspectReceipt(readA, receiptB1, signal);
  assertRefusedInvalidScope(refusedMixedReceiptOnA);

  // 7c. Mixed pair: foreign readB with own receiptA1
  const refusedMixedReadOnA = await portsA.inspector.inspectReceipt(readB, receiptA1, signal);
  assertRefusedInvalidScope(refusedMixedReadOnA);

  // 7d. Foreign cursor with own read/receipt
  const refusedForeignCursorOnA = await portsA.inspector.inspectReceipt(readA, receiptA1, signal, cursorB1);
  assertRefusedInvalidScope(refusedForeignCursorOnA);

  // 8. Inspector B symmetrically refuses Task A references
  // 8a. Matching pair from Task A
  const refusedMatchingAOnB = await portsB.inspector.inspectReceipt(readA, receiptA1, signal);
  assertRefusedInvalidScope(refusedMatchingAOnB);

  // 8b. Mixed pair: foreign readA with own receiptB1
  const refusedMixedReadOnB = await portsB.inspector.inspectReceipt(readA, receiptB1, signal);
  assertRefusedInvalidScope(refusedMixedReadOnB);

  // 8c. Mixed pair: own readB with foreign receiptA1
  const refusedMixedReceiptOnB = await portsB.inspector.inspectReceipt(readB, receiptA1, signal);
  assertRefusedInvalidScope(refusedMixedReceiptOnB);

  assertRefusedInvalidScope(await portsB.inspector.inspectReceipt(readB, receiptB1, signal, cursorA1));

  // 9. Snapshot authoritative files after refused reads: strictly unchanged
  const snapshotAfterRefused = await f.snapshotFiles();
  expect(snapshotAfterRefused).toEqual(snapshotBeforeRefused);

  // 10. Rightful original cursors reconstruct exact >8192-byte JSON payload for Task A
  const { jsonString: reconstructedAJson, pageCount: pageCountA } = await reconstructRightfulPayload(
    portsA.inspector,
    readA,
    receiptA1,
    signal,
    pageA1,
  );
  expect(pageCountA).toBeGreaterThan(2);
  const parsedA = JSON.parse(reconstructedAJson) as { notes?: string };
  expect(parsedA).toEqual({ notes: noteA1 });

  // 11. Rightful original cursors reconstruct exact >8192-byte JSON payload for Task B
  const { jsonString: reconstructedBJson, pageCount: pageCountB } = await reconstructRightfulPayload(
    portsB.inspector,
    readB,
    receiptB1,
    signal,
    pageB1,
  );
  expect(pageCountB).toBeGreaterThan(2);
  const parsedB = JSON.parse(reconstructedBJson) as { notes?: string };
  expect(parsedB).toEqual({ notes: noteB1 });

  // 12. Both original successor runners complete exact second contributions to finished view
  const outcomeA2 = await runnerA.runTurn(signal);
  expect(outcomeA2.kind).toBe('advanced');
  if (outcomeA2.kind !== 'advanced') return;
  expect(outcomeA2.nextView.kind).toBe('finished');
  if (outcomeA2.nextView.kind !== 'finished') return;
  expect(outcomeA2.nextView.execution.kind).toBe('completed');
  expect(outcomeA2.nextView.taskOutcome).toBe('unknown');
  expect(outcomeA2.nextView.retained).toHaveLength(2);

  const outcomeB2 = await runnerB.runTurn(signal);
  expect(outcomeB2.kind).toBe('advanced');
  if (outcomeB2.kind !== 'advanced') return;
  expect(outcomeB2.nextView.kind).toBe('finished');
  if (outcomeB2.nextView.kind !== 'finished') return;
  expect(outcomeB2.nextView.execution.kind).toBe('completed');
  expect(outcomeB2.nextView.taskOutcome).toBe('unknown');
  expect(outcomeB2.nextView.retained).toHaveLength(2);

  // 13. Verify second receipts on rightful inspectors
  const readA2 = await portsA.inspector.inspectReceipt(outcomeA2.nextView.read, outcomeA2.receipt, signal);
  expect(readA2.kind).toBe('complete');
  if (readA2.kind === 'complete') {
    expect(readA2.disposition).toBe('accepted');
    expect(readA2.receipt).toBe(outcomeA2.receipt);
    expect(JSON.parse(readA2.chunk)).toEqual({ notes: noteA2 });
  }

  const readB2 = await portsB.inspector.inspectReceipt(outcomeB2.nextView.read, outcomeB2.receipt, signal);
  expect(readB2.kind).toBe('complete');
  if (readB2.kind === 'complete') {
    expect(readB2.disposition).toBe('accepted');
    expect(readB2.receipt).toBe(outcomeB2.receipt);
    expect(JSON.parse(readB2.chunk)).toEqual({ notes: noteB2 });
  }
  expect(fakeModel.callCount).toBe(4);
  expect(new Set([receiptA1, receiptB1, outcomeA2.receipt, outcomeB2.receipt]).size).toBe(4);
}));

// ---------------------------------------------------------------------------
// 2. Mixed Execution IDs: Journal and Dispatcher Boundary Isolation
// ---------------------------------------------------------------------------

it('mixed execution IDs: journal and dispatcher refuse cross-task owner fences with stale_owner at capture, prepare, and dispatch, while rightful execution succeeds', () => hostIsolationFixture(async f => {
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

  // 1. Enroll Task A
  const enrollA = await scheduler.enroll({
    workflowId: 'two-step-test',
    goal: 'Task A mixed execution boundary test',
    workspacePath: f.root,
  }, signal);
  expect(enrollA.kind).toBe('enrolled');
  if (enrollA.kind !== 'enrolled') return;
  const { enrollment: enrollmentA, initialView: initialViewA, owner: ownerA } = enrollA;

  // 2. Enroll Task B
  const enrollB = await scheduler.enroll({
    workflowId: 'two-step-test',
    goal: 'Task B mixed execution boundary test',
    workspacePath: f.root,
  }, signal);
  expect(enrollB.kind).toBe('enrolled');
  if (enrollB.kind !== 'enrolled') return;
  const { enrollment: enrollmentB, initialView: initialViewB, owner: ownerB } = enrollB;

  expect(initialViewA.kind).toBe('question');
  expect(initialViewB.kind).toBe('question');
  if (initialViewA.kind !== 'question' || initialViewB.kind !== 'question') return;

  // Assert distinct executions and distinct owner fences from actual enrollment
  expect(enrollmentA.execution).not.toBe(enrollmentB.execution);
  expect(ownerA.execution).not.toBe(ownerB.execution);

  const portsA = scheduler.bindDiagnosticPorts(enrollmentA);

  // 3. Task A rightful delivery append under ownerA
  const delResultA = await portsA.journal.appendDelivery(initialViewA.reply, ownerA, signal);
  expect(delResultA.kind).toBe('delivered');
  if (delResultA.kind !== 'delivered') return;
  const deliveryA = delResultA.delivery;

  const rawPayloadA: RawModelResponse = {
    providerResponseId: 'provider_resp_a',
    responseText: 'Model response for Task A',
    calls: [{
      id: 'call_a',
      name: 'answer_work',
      argumentsJson: JSON.stringify({ answer: { notes: 'Authoritative Task A observation' } }),
    }],
  };

  // 4. Snapshot authoritative storage before cross-owner operations
  const snapshotBeforeCross = await f.snapshotFiles();
  expect(Object.keys(snapshotBeforeCross).length).toBeGreaterThan(0);

  // 5. capture A delivery using B owner -> stale_owner
  const captureWithWrongOwner = await portsA.journal.captureResponse(deliveryA, rawPayloadA, ownerB, signal);
  expect(captureWithWrongOwner.kind).toBe('stale_owner');
  // Authoritative files strictly unchanged after refused write
  expect(await f.snapshotFiles()).toEqual(snapshotBeforeCross);

  // 6. Rightful capture of A delivery using rightful ownerA
  const captureWithRightOwner = await portsA.journal.captureResponse(deliveryA, rawPayloadA, ownerA, signal);
  expect(captureWithRightOwner.kind).toBe('captured');
  if (captureWithRightOwner.kind !== 'captured') return;
  const capturedA = captureWithRightOwner.response;

  const snapshotAfterRightfulCapture = await f.snapshotFiles();

  // 7. prepare A captured response using B owner -> refused stale_owner
  const prepareWithWrongOwner = await portsA.journal.prepare(capturedA, ownerB, signal);
  expect(prepareWithWrongOwner.kind).toBe('refused');
  if (prepareWithWrongOwner.kind === 'refused') {
    expect(prepareWithWrongOwner.reason).toBe('stale_owner');
  }
  // Authoritative files strictly unchanged after refused prepare
  expect(await f.snapshotFiles()).toEqual(snapshotAfterRightfulCapture);

  // 8. Rightful prepare of A captured response using rightful ownerA
  const prepareWithRightOwner = await portsA.journal.prepare(capturedA, ownerA, signal);
  expect(prepareWithRightOwner.kind).toBe('prepared');
  if (prepareWithRightOwner.kind !== 'prepared') return;
  const preparedA = prepareWithRightOwner.answer;
  expect(preparedA.delivery).toBe(deliveryA);
  expect(preparedA.answer).toEqual({
    kind: 'notes',
    notes: 'Authoritative Task A observation',
  });

  const snapshotAfterRightfulPrepare = await f.snapshotFiles();

  // 9. dispatch A prepared answer using B owner -> stale_owner
  const dispatchWithWrongOwner = await portsA.dispatcher.dispatch(preparedA, ownerB, signal);
  expect(dispatchWithWrongOwner.kind).toBe('stale_owner');
  // Authoritative files strictly unchanged after refused dispatch
  expect(await f.snapshotFiles()).toEqual(snapshotAfterRightfulPrepare);

  // 10. Rightful A dispatch under ownerA still succeeds
  const dispatchWithRightOwner = await portsA.dispatcher.dispatch(preparedA, ownerA, signal);
  expect(dispatchWithRightOwner.kind).toBe('recorded');
  if (dispatchWithRightOwner.kind !== 'recorded') return;
  expect(dispatchWithRightOwner.disposition).toBe('accepted');
  expect(dispatchWithRightOwner.view.kind).toBe('question');
  if (dispatchWithRightOwner.view.kind !== 'question') return;

  const successorViewA = dispatchWithRightOwner.view;
  expect(successorViewA.retained).toHaveLength(1);
  expect(successorViewA.retained[0]!.receipt).toBe(dispatchWithRightOwner.receipt);

  // 11. Verify authoritative receipt payload through inspector
  const receiptReadA = await portsA.inspector.inspectReceipt(successorViewA.read, dispatchWithRightOwner.receipt, signal);
  expect(receiptReadA.kind).toBe('complete');
  if (receiptReadA.kind === 'complete') {
    expect(receiptReadA.disposition).toBe('accepted');
    expect(receiptReadA.receipt).toBe(dispatchWithRightOwner.receipt);
    const parsed = JSON.parse(receiptReadA.chunk) as { notes?: string };
    expect(parsed).toEqual({ notes: 'Authoritative Task A observation' });
  }
  const portsB = scheduler.bindDiagnosticPorts(enrollmentB);
  const deliveryB = await portsB.journal.appendDelivery(initialViewB.reply, ownerB, signal);
  expect(deliveryB.kind).toBe('delivered');
  if (deliveryB.kind !== 'delivered') return;
  const capturedB = await portsB.journal.captureResponse(deliveryB.delivery, {
    responseText: 'Task B valid', calls: [{ id: 'call_b', name: 'answer_work',
      argumentsJson: JSON.stringify({ answer: { notes: 'Authoritative Task B observation' } }) }],
  }, ownerB, signal);
  expect(capturedB.kind).toBe('captured');
  if (capturedB.kind !== 'captured') return;
  const preparedB = await portsB.journal.prepare(capturedB.response, ownerB, signal);
  expect(preparedB.kind).toBe('prepared');
  if (preparedB.kind !== 'prepared') return;
  const committedB = await portsB.dispatcher.dispatch(preparedB.answer, ownerB, signal);
  expect(committedB.kind).toBe('recorded');
  if (committedB.kind !== 'recorded') return;
  expect(committedB.disposition).toBe('accepted');
  expect(committedB.view.retained).toHaveLength(1);
  const evidenceB = await portsB.inspector.inspectReceipt(committedB.view.read, committedB.receipt, signal);
  expect(evidenceB.kind).toBe('complete');
  if (evidenceB.kind === 'complete') {
    expect(evidenceB.receipt).toBe(committedB.receipt);
    expect(evidenceB.disposition).toBe('accepted');
    expect(JSON.parse(evidenceB.chunk)).toEqual({ notes: 'Authoritative Task B observation' });
  }

}));
