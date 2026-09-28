import { loadNotesBaseline } from './notes-baseline.js';
/** Host unbound isolation acceptance probe for answer-driven execution.
 *
 * Covers:
 * - Positive control (legacy): Real legacy notes profile session completes two steps over MCP.
 * - Case 1: Genuine host enrollment under shared canonical config refuses unbound MCP answer_work
 *   with bound_session_required, preserving storage bytes and zero model calls; rightful bound runner
 *   completes two advanced turns with exact notes and prompt history; candidate unbound positive
 *   control succeeds through the same MCP server instance.
 * - Case 2: Owner-free pending host session via releaseOwnership refuses unbound MCP answer_work
 *   with bound_session_required and marks old runner stale without mutation; scheduler recovery with
 *   newer epoch finishes exact two accepted contributions.
 *
 * Production module 'src/answer-v1/host.ts' is currently absent.
 * Module absence fails explicitly with 'runtime_unavailable: src/answer-v1/host.ts'.
 * Import errors in an existing module propagate as runtime_error. Tests never skip or pass.
 */
import 'reflect-metadata';
import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type {
  AnswerHostConfig, AnswerMcpCompositionOptions, HostJournalStorageConfig,
  HostWorkRequest, ModelCompletionResult, ModelInferenceBoundary,
  ModelPromptInput, SharedAuthorityConfig, TrustedAnswerScheduler,
} from './host-composition.js';
import type { HostExecutorPorts, RawModelResponse } from './invocation-contract.js';
import type { ReadRef, ReceiptRef, WorkView } from './answer-contract.js';

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
  if (!mod || typeof mod.createAnswerHost !== 'function') expect.fail(`runtime_error: ${PRODUCTION_MODULE_PATH} (missing createAnswerHost export)`);
  return mod.createAnswerHost;
}

const viewSchema = z.object({ kind: z.string(), read: z.string(), reply: z.string().optional() }).passthrough();
const recordedSchema = z.object({
  kind: z.literal('recorded'), receipt: z.string(),
  disposition: z.enum(['accepted', 'partial', 'rejected']), view: viewSchema,
}).passthrough();
const openedSchema = z.object({ kind: z.literal('opened'), recovery: z.string(), view: viewSchema }).passthrough();
const evidenceReadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('complete'), receipt: z.string(), disposition: z.enum(['accepted', 'partial', 'rejected']),
    encoding: z.enum(['canonical_json', 'raw_utf8']), chunk: z.string(),
  }).strict(),
  z.object({
    kind: z.literal('more'), receipt: z.string(), disposition: z.enum(['accepted', 'partial', 'rejected']),
    encoding: z.enum(['canonical_json', 'raw_utf8']), chunk: z.string(), next: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal('refused'), reason: z.enum(['invalid_scope', 'corrupt', 'storage_unavailable', 'bound_session_required']),
  }).strict(),
]);

const question = (raw: unknown) => {
  const view = viewSchema.parse(raw);
  expect(view.kind).toBe('question');
  return z.object({ reply: z.string().min(1), read: z.string().min(1) }).passthrough().parse(view);
};

const makeAnswerResponse = (id: string, notes: string): RawModelResponse => ({
  responseText: notes, calls: [{ id, name: 'answer_work', argumentsJson: JSON.stringify({ answer: { notes } }) }],
});

async function verifyReceiptChunk(ports: HostExecutorPorts, readRef: ReadRef, receipt: ReceiptRef, notes: string, signal: AbortSignal): Promise<void> {
  const read = await ports.inspector.inspectReceipt(readRef, receipt, signal);
  expect(read.kind).toBe('complete');
  if (read.kind === 'complete') {
    expect(read.disposition).toBe('accepted'); expect(read.receipt).toBe(receipt); expect(JSON.parse(read.chunk)).toEqual({ notes });
  }
}

async function verifyUnboundReceipt(call: (name: string, args: Record<string, unknown>) => Promise<unknown>, read: string, receipt: string, notes: string): Promise<void> {
  const page = evidenceReadSchema.parse(await call('inspect_work', { read, receipt }));
  expect(page.kind).toBe('complete');
  if (page.kind === 'complete') {
    expect(page.disposition).toBe('accepted'); expect(JSON.parse(page.chunk)).toEqual({ notes });
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
    return next ? { kind: 'completed', response: next } : { kind: 'unavailable', detail: 'No queued model response available' };
  }
}

interface HostUnboundFixtureContext {
  trackHost: (scheduler: TrustedAnswerScheduler) => void;
  root: string; workflowsDir: string; storageConfig: HostJournalStorageConfig; sharedAuthorityConfig: SharedAuthorityConfig;
  snapshotStorage: (dir?: string) => Promise<Record<string, string>>; readJournalLines: () => Promise<string[]>;
  loadFactory: () => Promise<typeof import('./host-composition.js').createAnswerHost>;
  bootMcp: (profile: 'notes' | 'answers', options?: AnswerMcpCompositionOptions) => Promise<{
    call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  }>;
}

let priorCleanupFailure: Error | undefined;

async function hostUnboundFixture(run: (f: HostUnboundFixtureContext) => Promise<void>): Promise<void> {
  if (priorCleanupFailure) throw priorCleanupFailure;
  const root = await mkdtemp(join(tmpdir(), 'workrail-host-unbound-acceptance-'));
  const [journalRootDir, hostIndexRootDir, workflowsDir, keysDir] = [
    join(root, 'answer-v1', 'sessions'), join(root, 'answer-v1', 'host-index'), join(root, 'workflows'), join(root, 'keys'),
  ];
  await Promise.all([
    mkdir(journalRootDir, { recursive: true }), mkdir(hostIndexRootDir, { recursive: true }),
    mkdir(workflowsDir, { recursive: true }), mkdir(keysDir, { recursive: true }),
  ]);

  await writeFile(join(workflowsDir, 'two-step-test.json'), JSON.stringify({
    id: 'two-step-test', name: 'Two Step Acceptance Test Workflow', description: 'Actual two-step workflow for host unbound isolation probe', version: '1.0.0',
    steps: [{ id: 'step-1', title: 'Step 1: First Observation', prompt: 'Record first observation.' }, { id: 'step-2', title: 'Step 2: Second Observation', prompt: 'Record second observation.' }],
  }), 'utf8');

  const storageConfig: HostJournalStorageConfig = { journalRootDir, hostIndexRootDir };
  const sharedAuthorityConfig: SharedAuthorityConfig = {
    storage: storageConfig, keyringPath: join(keysDir, 'keyring.json'), workflowStoragePath: workflowsDir,
  };

  const envKeys = ['WORKRAIL_DATA_DIR', 'WORKRAIL_KEYS_DIR', 'WORKFLOW_STORAGE_PATH', 'WORKRAIL_ENABLE_V2_TOOLS', 'WORKRAIL_ENABLE_SESSION_TOOLS', 'WORKRAIL_AGENT_PROFILE'] as const;
  const previousEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));

  const snapshotStorage = async (dir = journalRootDir): Promise<Record<string, string>> => {
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
    }
    return res;
  };

  const readJournalLines = async (dir = root): Promise<string[]> => {
    const lines: string[] = [];
    let entries;
    entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) lines.push(...await readJournalLines(full));
      else if (e.name.endsWith('.jsonl')) lines.push(...(await readFile(full, 'utf8')).split('\n').filter(Boolean));
    }
    return lines;
  };

  const hosts: TrustedAnswerScheduler[] = [];
  const clients: Client[] = [];
  const servers: Array<{ close: () => Promise<void> }> = [];

  const bootMcp = async (profile: 'notes' | 'answers', options?: AnswerMcpCompositionOptions) => {
    if (profile === 'answers' && !options?.answerAuthority) {
      expect.fail('Declared options.answerAuthority required for WORKRAIL_AGENT_PROFILE=answers');
    }
    if (profile === 'notes' && options !== undefined) {
      expect.fail('Legacy notes calls must pass no composition options');
    }

    Object.assign(process.env, {
      WORKRAIL_DATA_DIR: root, WORKRAIL_KEYS_DIR: keysDir, WORKFLOW_STORAGE_PATH: workflowsDir,
      WORKRAIL_ENABLE_V2_TOOLS: 'true', WORKRAIL_ENABLE_SESSION_TOOLS: 'false', WORKRAIL_AGENT_PROFILE: profile,
    });

    let serverInstance: { connect: (transport: unknown) => Promise<void>; close: () => Promise<void> };
    try {
      const serverPath = resolve(process.cwd(), 'src/mcp/server.ts');
      const baseline = profile === 'notes' ? loadNotesBaseline() : undefined;
      baseline?.container.resetContainer();
      const serverMod = (baseline?.server ?? await import(/* @vite-ignore */ serverPath)) as {
        composeServer: (opts?: AnswerMcpCompositionOptions) => Promise<{ server: typeof serverInstance }>;
      };
      serverInstance = (await serverMod.composeServer(options)).server;
    } catch (error) {
      expect.fail(`runtime_unavailable: WORKRAIL_AGENT_PROFILE=${profile} (${String(error)})`);
    }
    servers.push(serverInstance);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'host-unbound-probe', version: '1.0.0' });
    clients.push(client);
    await Promise.all([serverInstance.connect(serverTransport), client.connect(clientTransport)]);

    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
      expect(res.isError, `MCP error from ${name}: ${JSON.stringify(res.content)}`).not.toBe(true);
      return JSON.parse(z.object({ content: z.array(z.object({ text: z.string() })).min(1) }).parse(res).content[0]!.text) as unknown;
    };

    return { call };
  };

  const bounded = async (work: Promise<unknown>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Cleanup did not finish; preserve fixture storage')), 3000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };

  let primaryError: unknown;
  try {
    await run({ root, trackHost: scheduler => hosts.push(scheduler), workflowsDir, storageConfig, sharedAuthorityConfig, snapshotStorage, readJournalLines, loadFactory: loadCandidateHostFactory, bootMcp });
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    const cleanupErrors: unknown[] = [];
    const clean = async (work: () => Promise<unknown>) => {
      try { await bounded(work()); } catch (error) { cleanupErrors.push(error); }
    };
    for (const host of hosts) await clean(async () => {
      const result = await host.close(AbortSignal.timeout(2500));
      if (result.kind !== 'closed') throw new Error(`Host cleanup incomplete: ${result.reason}`);
    });
    for (const c of clients) await clean(() => c.close());
    for (const server of servers) await clean(() => server.close());
    if (!cleanupErrors.length) await clean(async () => {
      const containerMod = await import(/* @vite-ignore */ resolve(process.cwd(), 'src/di/container.ts')) as { resetContainer: () => void };
      containerMod.resetContainer();
    });
    for (const k of envKeys) { if (previousEnv[k] === undefined) delete process.env[k]; else process.env[k] = previousEnv[k]; }
    if (cleanupErrors.length) {
      priorCleanupFailure = new AggregateError(cleanupErrors, `Cleanup incomplete; retained ${root}`, { cause: primaryError });
      throw priorCleanupFailure;
    }
    if (!primaryError) await rm(root, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------
// Positive Control (Legacy Notes Profile)
// -----------------------------------------------------------------------------

it('positive control (legacy): ordinary unbound MCP session completes two steps over legacy notes profile', () => hostUnboundFixture(async f => {
  const mcp = await f.bootMcp('notes');
  try {
    const started = z.object({ kind: z.literal('work'), assignment: z.string() }).passthrough().parse(
      await mcp.call('start_work', { workflowId: 'two-step-test', workspacePath: f.root, goal: 'Record two observations.' })
    );
    const step1 = z.object({ kind: z.literal('work'), assignment: z.string() }).passthrough().parse(
      await mcp.call('submit_work', { assignment: started.assignment, result: { notes: 'First observation from ordinary unbound session.' } })
    );
    const finished = await mcp.call('submit_work', { assignment: step1.assignment, result: { notes: 'Second observation from ordinary unbound session.' } });
    expect(finished).toMatchObject({ kind: 'finished', outcome: { kind: 'completed' } });

    const lines = await f.readJournalLines();
    expect(lines.length).toBeGreaterThan(0);
    const notes = lines.map(l => JSON.parse(l)).filter((e: { kind: string; data?: { payload?: { payloadKind?: string } } }) => e.kind === 'node_output_appended' && e.data?.payload?.payloadKind === 'notes').map((e: { data: { payload: { notesMarkdown: string } } }) => e.data.payload.notesMarkdown);
    expect(notes).toEqual(['First observation from ordinary unbound session.', 'Second observation from ordinary unbound session.']);
  } finally { /* Fixture owns and verifies cleanup. */ }
}));

// -----------------------------------------------------------------------------
// Candidate Case 1: Genuine host enrollment under same canonical config
// -----------------------------------------------------------------------------

it('case 1: genuine host enrollment refuses unbound MCP answer_work without storage mutation or model inference, then rightful runner completes', () => hostUnboundFixture(async f => {
  const createAnswerHost = await f.loadFactory();
  const fakeModel = new FakeTestModelBoundary();
  const signal = new AbortController().signal;

  const hostResult = await createAnswerHost({ ...f.sharedAuthorityConfig, model: fakeModel }, signal);
  expect(hostResult.kind).toBe('created');
  if (hostResult.kind !== 'created') return;
  const scheduler = hostResult.scheduler;
  f.trackHost(scheduler);

  let mcp: { call: (name: string, args: Record<string, unknown>) => Promise<unknown> } | undefined;
  try {
    mcp = await f.bootMcp('answers', { answerAuthority: f.sharedAuthorityConfig });

    // 1. Genuine host enrollment with same canonical config
    const workRequest: HostWorkRequest = { workflowId: 'two-step-test', goal: 'Case 1 host-unbound isolation probe', workspacePath: f.root };
    const enrollResult = await scheduler.enroll(workRequest, signal);
    expect(enrollResult.kind).toBe('enrolled');
    if (enrollResult.kind !== 'enrolled') return;
    const { runner, initialView, enrollment } = enrollResult;
    expect(initialView.kind).toBe('question');
    if (initialView.kind !== 'question') return;
    expect(initialView.instruction).toBe('Record first observation.');
    expect(fakeModel.callCount).toBe(0);
    const pendingReply = initialView.reply;

    // 2. Snapshot storage and model calls before attempted unbound write
    const storageBefore = await f.snapshotStorage();
    const modelCallsBefore = fakeModel.callCount;

    // 3. Submit host reply through actual unbound MCP answer_work -> refused
    const unboundAttempt = await mcp.call('answer_work', { reply: pendingReply, answer: { notes: 'Attempted unbound write on host session' } });
    expect(unboundAttempt).toEqual({ kind: 'not_retained', reason: 'bound_session_required' });
    expect(await f.snapshotStorage()).toEqual(storageBefore);
    expect(fakeModel.callCount).toBe(modelCallsBefore);

    // 4. Rightful bound runner runs two advanced turns
    fakeModel.setQueuedResponses([makeAnswerResponse('call_1', 'Step 1 bound note'), makeAnswerResponse('call_2', 'Step 2 bound note')]);

    const turn1 = await runner.runTurn(signal);
    expect(turn1.kind).toBe('advanced');
    if (turn1.kind !== 'advanced') return;
    expect(fakeModel.callCount).toBe(modelCallsBefore + 1);
    expect(turn1.nextView.kind).toBe('question');
    expect(turn1.nextView.retained).toHaveLength(1);
    const receipt1 = turn1.receipt;

    const turn2 = await runner.runTurn(signal);
    expect(turn2.kind).toBe('advanced');
    if (turn2.kind !== 'advanced') return;
    expect(fakeModel.callCount).toBe(modelCallsBefore + 2);

    expect(turn2.nextView.kind).toBe('finished');
    if (turn2.nextView.kind !== 'finished') return;
    const finalView = turn2.nextView;
    expect(finalView.execution.kind).toBe('completed'); expect(finalView.taskOutcome).toBe('unknown'); expect(finalView.retained.map(r => r.receipt)).toEqual([receipt1, turn2.receipt]);
    const receipt2 = turn2.receipt;
    expect(receipt1).not.toBe(receipt2);

    // Assert model prompt history
    if (turn1.nextView.kind !== 'question') expect.fail('Expected successor question');
    expect(turn1.nextView.instruction).toBe('Record second observation.');
    expect(fakeModel.promptHistory).toEqual([
      { instruction: initialView.instruction, answerFormat: initialView.answerFormat, issues: initialView.issues, retainedSummaries: initialView.retained },
      { instruction: turn1.nextView.instruction, answerFormat: turn1.nextView.answerFormat, issues: turn1.nextView.issues, retainedSummaries: turn1.nextView.retained },
    ]);

    // Inspect via task-bound diagnostic inspector after completion only
    const ports = scheduler.bindDiagnosticPorts(enrollment);
    await verifyReceiptChunk(ports, finalView.read, receipt1, 'Step 1 bound note', signal);
    await verifyReceiptChunk(ports, finalView.read, receipt2, 'Step 2 bound note', signal);
    const beforeReadBypass = await f.snapshotStorage();
    expect(await mcp.call('inspect_work', { read: finalView.read, receipt: receipt1 })).toEqual({ kind: 'refused', reason: 'bound_session_required' });
    expect(await f.snapshotStorage()).toEqual(beforeReadBypass);
    // Recompose from shared storage before checking final receipt/payload preservation.
    const reopened = await createAnswerHost({ ...f.sharedAuthorityConfig, model: fakeModel }, signal);
    expect(reopened.kind).toBe('created');
    if (reopened.kind !== 'created') return;
    f.trackHost(reopened.scheduler);
    const recoveredFinal = await reopened.scheduler.recover(scheduler.hydrator.dehydrate(enrollment), signal);
    expect(recoveredFinal.kind).toBe('settled');
    if (recoveredFinal.kind !== 'settled') return;
    expect(recoveredFinal.receipt).toBe(receipt2);
    expect(recoveredFinal.view).toEqual(finalView);
    const reopenedPorts = reopened.scheduler.bindDiagnosticPorts(enrollment);
    await verifyReceiptChunk(reopenedPorts, recoveredFinal.view.read, receipt1, 'Step 1 bound note', signal);
    await verifyReceiptChunk(reopenedPorts, recoveredFinal.view.read, receipt2, 'Step 2 bound note', signal);
    expect(fakeModel.callCount).toBe(2);

    // 5. Candidate unbound positive control through same MCP open_work answer_work twice
    const openRes = openedSchema.parse(await mcp.call('open_work', { workflowId: 'two-step-test', workspacePath: f.root, goal: 'Candidate unbound positive control' }));
    const unboundQ1 = question(openRes.view);
    const unboundStep1 = recordedSchema.parse(await mcp.call('answer_work', { reply: unboundQ1.reply, answer: { notes: 'Unbound positive control step 1' } }));
    expect(unboundStep1.disposition).toBe('accepted');
    const unboundQ2 = question(unboundStep1.view);

    const unboundStep2 = recordedSchema.parse(await mcp.call('answer_work', { reply: unboundQ2.reply, answer: { notes: 'Unbound positive control step 2' } }));
    expect(unboundStep2.disposition).toBe('accepted');
    expect(unboundStep2.receipt).not.toBe(unboundStep1.receipt);
    expect(z.object({ retained: z.array(z.object({ receipt: z.string() })) }).parse(unboundStep2.view).retained.map(r => r.receipt)).toEqual([unboundStep1.receipt, unboundStep2.receipt]);
    expect(unboundStep2.view).toMatchObject({ kind: 'finished', execution: { kind: 'completed' }, taskOutcome: 'unknown' });

    // Inspect exact notes receipts using actual tool schema in agent-answer.probe
    await verifyUnboundReceipt(mcp.call, unboundQ2.read, unboundStep1.receipt, 'Unbound positive control step 1');
    await verifyUnboundReceipt(mcp.call, unboundStep2.view.read, unboundStep2.receipt, 'Unbound positive control step 2');
  } finally {
    // Fixture owns cleanup, reports incomplete shutdown and preserves storage.
  }
}));

// -----------------------------------------------------------------------------
// Candidate Case 2: Owner-free pending session
// -----------------------------------------------------------------------------

it('case 2: owner-free pending session refuses unbound MCP answer_work, stale runner rejected, recovery finishes two turns', () => hostUnboundFixture(async f => {
  const createAnswerHost = await f.loadFactory();
  const fakeModel = new FakeTestModelBoundary();
  const signal = new AbortController().signal;

  const hostResult = await createAnswerHost({ ...f.sharedAuthorityConfig, model: fakeModel }, signal);
  expect(hostResult.kind).toBe('created');
  if (hostResult.kind !== 'created') return;
  const scheduler = hostResult.scheduler;
  f.trackHost(scheduler);

  let mcp: { call: (name: string, args: Record<string, unknown>) => Promise<unknown> } | undefined;
  try {
    mcp = await f.bootMcp('answers', { answerAuthority: f.sharedAuthorityConfig });

    // 1. Enroll host session
    const workRequest: HostWorkRequest = { workflowId: 'two-step-test', goal: 'Case 2 owner-free pending test', workspacePath: f.root };
    const enrollResult = await scheduler.enroll(workRequest, signal);
    expect(enrollResult.kind).toBe('enrolled');
    if (enrollResult.kind !== 'enrolled') return;
    const { runner: oldRunner, initialView, enrollment, owner } = enrollResult;
    expect(initialView.kind).toBe('question');
    if (initialView.kind !== 'question') return;
    expect(initialView.instruction).toBe('Record first observation.');
    expect(fakeModel.callCount).toBe(0);
    const pendingReply = initialView.reply;
    const pointer = scheduler.hydrator.dehydrate(enrollment);

    // 2. Production trusted handoff: release ownership under canonical transaction gate
    const releaseResult = await scheduler.releaseOwnership(enrollment, owner, signal);
    expect(releaseResult.kind).toBe('released');
    if (releaseResult.kind !== 'released') return;

    // 3. Capture snapshot AFTER release
    const snapshotAfterRelease = await f.snapshotStorage();
    const modelCallsAfterRelease = fakeModel.callCount;

    // 4. MCP host reply still refused with bound_session_required, nochange/noinfer
    const unboundAttempt = await mcp.call('answer_work', { reply: pendingReply, answer: { notes: 'Attempted unbound write during owner-free state' } });
    expect(unboundAttempt).toEqual({ kind: 'not_retained', reason: 'bound_session_required' });
    expect(await f.snapshotStorage()).toEqual(snapshotAfterRelease);
    expect(fakeModel.callCount).toBe(modelCallsAfterRelease);

    // 5. Old runner stale owner: runTurn returns stale_owner without mutation or inference
    const oldRunnerOutcome = await oldRunner.runTurn(signal);
    expect(oldRunnerOutcome.kind).toBe('stale_owner');
    expect(await f.snapshotStorage()).toEqual(snapshotAfterRelease);
    expect(fakeModel.callCount).toBe(modelCallsAfterRelease);

    // 6. scheduler.recover(pointer) gets replacement with newer epoch
    const recovered = await scheduler.recover(pointer, signal);
    expect(recovered.kind).toBe('ready');
    if (recovered.kind !== 'ready') return;
    expect(recovered.owner.epoch).toBeGreaterThan(owner.epoch);
    const replacementRunner = recovered.runner;

    // 7. Replacement runner finishes exact two accepted contributions
    fakeModel.setQueuedResponses([makeAnswerResponse('call_rec_1', 'Step 1 recovered note'), makeAnswerResponse('call_rec_2', 'Step 2 recovered note')]);

    const recTurn1 = await replacementRunner.runTurn(signal);
    expect(recTurn1.kind).toBe('advanced');
    if (recTurn1.kind !== 'advanced') return;
    expect(recTurn1.nextView.kind).toBe('question');
    expect(recTurn1.nextView.retained).toHaveLength(1);
    const recReceipt1 = recTurn1.receipt;

    const recTurn2 = await replacementRunner.runTurn(signal);
    expect(recTurn2.kind).toBe('advanced');
    if (recTurn2.kind !== 'advanced') return;

    expect(recTurn2.nextView.kind).toBe('finished');
    if (recTurn2.nextView.kind !== 'finished') return;
    const recFinalView = recTurn2.nextView;
    expect(recFinalView.execution.kind).toBe('completed'); expect(recFinalView.taskOutcome).toBe('unknown'); expect(recFinalView.retained.map(r => r.receipt)).toEqual([recReceipt1, recTurn2.receipt]);
    const recReceipt2 = recTurn2.receipt;
    expect(recReceipt1).not.toBe(recReceipt2);

    expect(fakeModel.callCount).toBe(modelCallsAfterRelease + 2);
    if (recTurn1.nextView.kind !== 'question') expect.fail('Expected recovered successor question');
    expect(recTurn1.nextView.instruction).toBe('Record second observation.');
    expect(fakeModel.promptHistory).toEqual([
      { instruction: initialView.instruction, answerFormat: initialView.answerFormat, issues: initialView.issues, retainedSummaries: initialView.retained },
      { instruction: recTurn1.nextView.instruction, answerFormat: recTurn1.nextView.answerFormat, issues: recTurn1.nextView.issues, retainedSummaries: recTurn1.nextView.retained },
    ]);
    expect(recovered.owner.execution).toBe(owner.execution);
    // Inspect via task-bound diagnostic inspector
    const recPorts = scheduler.bindDiagnosticPorts(recovered.enrollment);
    await verifyReceiptChunk(recPorts, recFinalView.read, recReceipt1, 'Step 1 recovered note', signal);
    await verifyReceiptChunk(recPorts, recFinalView.read, recReceipt2, 'Step 2 recovered note', signal);
  } finally {
    // Fixture owns cleanup, reports incomplete shutdown and preserves storage.
  }
}));
