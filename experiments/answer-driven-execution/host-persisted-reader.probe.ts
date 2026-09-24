import { loadNotesBaseline } from './notes-baseline.js';
/** Bounded F041 persisted-format acceptance probes for answer-driven execution.
 * Covers:
 * - Positive control (legacy): Notes MCP session recovered via LocalSessionEventLogStoreV2,
 *   exact digest_mismatch on corruption, unknown_schema_version on version bump.
 * - Candidate corruption: Candidate accepted notes turn closed cleanly; DataDir locates single session;
 *   manifest relative paths validated; byte mutation refuses as 'corrupt' with preserved bytes and zero
 *   model calls; restored positive control completes turn 2 with exact original+successor receipts.
 * - Candidate version: Committed event version bumped to 99 with consistent digest attestation refuses
 *   as 'unsupported_version' (not 'corrupt') with zero inference; restored control completes turn 2.
 * Production module 'src/answer-v1/host.ts' is absent: fails with 'runtime_unavailable'. Candidate NOT MET.
 */
import 'reflect-metadata';
import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { ManifestRecordV1Schema, type ManifestRecordV1 } from '../../src/v2/durable-core/schemas/session/manifest.js';
import type { DomainEventV1 } from '../../src/v2/durable-core/schemas/session/index.js';
import { LocalDataDirV2 } from '../../src/v2/infra/local/data-dir/index.js';
import { LocalSessionEventLogStoreV2 } from '../../src/v2/infra/local/session-store/index.js';
import { NodeFileSystemV2 } from '../../src/v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../../src/v2/infra/local/sha256/index.js';
import { asSessionId } from '../../src/v2/durable-core/ids/index.js';

import type {
  AnswerHostConfig, HostJournalStorageConfig, HostWorkRequest,
  ModelCompletionResult, ModelInferenceBoundary, ModelPromptInput,
  PersistedHostPointer, SharedAuthorityConfig, TrustedAnswerScheduler,
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
  if (!mod || typeof mod.createAnswerHost !== 'function') expect.fail(`runtime_error: ${PRODUCTION_MODULE_PATH} (missing createAnswerHost export)`);
  return mod.createAnswerHost;
}

const makeAnswerResponse = (id: string, notes: string): RawModelResponse => ({
  responseText: notes, calls: [{ id, name: 'answer_work', argumentsJson: JSON.stringify({ answer: { notes } }) }],
});

async function verifyReceiptChunk(ports: HostExecutorPorts, readRef: ReadRef, receipt: ReceiptRef, notes: string, signal: AbortSignal): Promise<void> {
  const read = await ports.inspector.inspectReceipt(readRef, receipt, signal);
  expect(read.kind).toBe('complete');
  if (read.kind === 'complete') {
    expect(read.disposition).toBe('accepted'); expect(read.receipt).toBe(receipt);
    expect(JSON.parse(read.chunk)).toEqual({ notes });
  }
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

async function locateCommittedSegment(dataDir: LocalDataDirV2, root: string) {
  const sessionEntries = (await readdir(dataDir.sessionsDir(), { withFileTypes: true })).filter(e => e.isDirectory());
  expect(sessionEntries).toHaveLength(1);
  const sessionId = asSessionId(sessionEntries[0]!.name);
  const manifestPath = dataDir.sessionManifestPath(sessionId);
  const manifestRaw = await readFile(manifestPath, 'utf8');
  const manifestRecords = manifestRaw.trim().split('\n').filter(Boolean).map(l => ManifestRecordV1Schema.parse(JSON.parse(l)));
  const closedSegments = manifestRecords.filter((r): r is Extract<ManifestRecordV1, { kind: 'segment_closed' }> => r.kind === 'segment_closed');
  expect(closedSegments.length).toBeGreaterThan(0);
  for (const seg of closedSegments) {
    const fullSegPath = resolve(dataDir.sessionDir(sessionId), seg.segmentRelPath);
    for (const parent of [dataDir.sessionDir(sessionId), root]) {
      const child = relative(resolve(parent), fullSegPath);
      expect(child.length).toBeGreaterThan(0);
      expect(isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)).toBe(false);
    }
    expect(seg.sessionId).toBe(sessionId);
    const bytes = await readFile(fullSegPath);
    expect(bytes.length).toBe(seg.bytes);
    expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(seg.sha256);
  }
  const targetSeg = closedSegments[0]!;
  const targetSegPath = resolve(dataDir.sessionDir(sessionId), targetSeg.segmentRelPath);
  return { sessionId, manifestPath, manifestRaw, targetSeg, targetSegPath };
}

async function runCandidateFirstTurn(
  f: PersistedReaderFixtureContext, fakeModel: FakeTestModelBoundary, note1: string, signal: AbortSignal,
) {
  const createAnswerHost = await f.loadFactory();
  fakeModel.setQueuedResponses([makeAnswerResponse('c1', note1)]);
  const hostResult = await createAnswerHost({ ...f.sharedAuthorityConfig, model: fakeModel }, signal);
  expect(hostResult.kind).toBe('created');
  if (hostResult.kind !== 'created') return;
  f.trackHost(hostResult.scheduler);
  const enrollResult = await hostResult.scheduler.enroll(f.workRequest, signal);
  expect(enrollResult.kind).toBe('enrolled');
  if (enrollResult.kind !== 'enrolled') return;
  const pointer = hostResult.scheduler.hydrator.dehydrate(enrollResult.enrollment);
  expect(pointer.formatVersion).toBe(1);
  const turn1 = await enrollResult.runner.runTurn(signal);
  expect(turn1.kind).toBe('advanced');
  if (turn1.kind !== 'advanced') return;
  expect(fakeModel.callCount).toBe(1);
  await f.closeHost(hostResult.scheduler);
  expect(f.storageConfig.journalRootDir).toBe(f.dataDir.sessionsDir());
  const segInfo = await locateCommittedSegment(f.dataDir, f.root);
  return { pointer, receipt1: turn1.receipt, ...segInfo };
}

async function assertRecoveryRefusal(
  recomposedFactory: typeof import('./host-composition.js').createAnswerHost,
  config: AnswerHostConfig, pointer: PersistedHostPointer, expectedReason: 'corrupt' | 'unsupported_version',
  fakeModel: FakeTestModelBoundary, snapshotStorage: () => Promise<Record<string, string>>,
  trackHost: (s: TrustedAnswerScheduler) => void, closeHost: (s: TrustedAnswerScheduler) => Promise<void>, signal: AbortSignal,
) {
  const snapBefore = await snapshotStorage();
  const modelCallsBefore = fakeModel.callCount;
  const host = await recomposedFactory(config, signal);
  expect(host.kind).toBe('created');
  if (host.kind !== 'created') return;
  trackHost(host.scheduler);
  const recoverRes = await host.scheduler.recover(pointer, signal);
  expect(recoverRes.kind).toBe('refused');
  if (recoverRes.kind === 'refused') {
    expect(recoverRes.reason).toBe(expectedReason);
    if (expectedReason === 'unsupported_version') expect(recoverRes.reason).not.toBe('corrupt');
  }
  await closeHost(host.scheduler);
  expect(await snapshotStorage()).toEqual(snapBefore);
  expect(fakeModel.callCount).toBe(modelCallsBefore);
}

async function runPositiveCompletion(
  recomposedFactory: typeof import('./host-composition.js').createAnswerHost,
  config: AnswerHostConfig, pointer: PersistedHostPointer, receipt1: ReceiptRef,
  note1: string, note2: string, fakeModel: FakeTestModelBoundary,
  trackHost: (s: TrustedAnswerScheduler) => void, closeHost: (s: TrustedAnswerScheduler) => Promise<void>, signal: AbortSignal,
) {
  const host = await recomposedFactory(config, signal);
  expect(host.kind).toBe('created');
  if (host.kind !== 'created') return;
  trackHost(host.scheduler);
  const ready = await host.scheduler.recover(pointer, signal);
  expect(ready.kind).toBe('ready');
  if (ready.kind !== 'ready') return;
  fakeModel.setQueuedResponses([makeAnswerResponse('c2', note2)]);
  const callsBefore = fakeModel.callCount;
  const turn2 = await ready.runner.runTurn(signal);
  expect(fakeModel.callCount).toBe(callsBefore + 1);
  expect(turn2.kind).toBe('advanced');
  if (turn2.kind !== 'advanced') return;
  expect(turn2.nextView.kind).toBe('finished');
  if (turn2.nextView.kind !== 'finished') return;
  expect(turn2.nextView.execution.kind).toBe('completed');
  expect(turn2.nextView.taskOutcome).toBe('unknown');
  expect(turn2.nextView.retained).toHaveLength(2);
  expect(turn2.nextView.retained[0]!.receipt).toBe(receipt1);
  expect(turn2.nextView.retained[1]!.receipt).toBe(turn2.receipt);
  const ports = host.scheduler.bindDiagnosticPorts(ready.enrollment);
  await verifyReceiptChunk(ports, turn2.nextView.read, receipt1, note1, signal);
  await verifyReceiptChunk(ports, turn2.nextView.read, turn2.receipt, note2, signal);
  await closeHost(host.scheduler);
}

interface PersistedReaderFixtureContext {
  root: string; dataDir: LocalDataDirV2; storageConfig: HostJournalStorageConfig;
  sharedAuthorityConfig: SharedAuthorityConfig; workRequest: HostWorkRequest;
  trackHost: (scheduler: TrustedAnswerScheduler) => void;
  closeHost: (scheduler: TrustedAnswerScheduler) => Promise<void>;
  snapshotStorage: (dir?: string) => Promise<Record<string, string>>;
  loadFactory: () => Promise<typeof import('./host-composition.js').createAnswerHost>;
  bootMcp: (profile: 'notes') => Promise<{ call: (name: string, args: Record<string, unknown>) => Promise<unknown>; close: () => Promise<void> }>;
}

let priorCleanupFailure: Error | undefined;

async function persistedReaderFixture(run: (f: PersistedReaderFixtureContext) => Promise<void>): Promise<void> {
  if (priorCleanupFailure) throw priorCleanupFailure;
  const root = await mkdtemp(join(tmpdir(), 'workrail-host-persisted-reader-'));
  const [dataDirRoot, workflowsDir] = [join(root, 'data'), join(root, 'workflows')];
  const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: dataDirRoot });
  const [journalRootDir, hostIndexRootDir, keysDir] = [dataDir.sessionsDir(), join(dataDirRoot, 'host-index'), dataDir.keysDir()];

  await Promise.all([
    mkdir(journalRootDir, { recursive: true }), mkdir(hostIndexRootDir, { recursive: true }),
    mkdir(keysDir, { recursive: true }), mkdir(workflowsDir, { recursive: true }),
  ]);

  await writeFile(join(workflowsDir, 'two-step-test.json'), JSON.stringify({
    id: 'two-step-test', name: 'Two Step Persisted Reader Acceptance Workflow',
    description: 'Actual two-step workflow for persisted reader acceptance probe', version: '1.0.0',
    steps: [
      { id: 'step-1', title: 'Step 1: First Observation', prompt: 'Record first observation.' },
      { id: 'step-2', title: 'Step 2: Second Observation', prompt: 'Record second observation.' },
    ],
  }), 'utf8');

  const storageConfig: HostJournalStorageConfig = { journalRootDir, hostIndexRootDir };
  const sharedAuthorityConfig: SharedAuthorityConfig = {
    storage: storageConfig, keyringPath: dataDir.keyringPath(), workflowStoragePath: workflowsDir,
  };
  const workRequest: HostWorkRequest = {
    workflowId: 'two-step-test', goal: 'F041 persisted reader probe run', workspacePath: root,
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

  const hosts = new Set<TrustedAnswerScheduler>();
  const clients: Client[] = [];
  const servers: Array<{ close: () => Promise<void> }> = [];

  const bootMcp = async (profile: 'notes') => {
    Object.assign(process.env, {
      WORKRAIL_DATA_DIR: dataDirRoot, WORKRAIL_KEYS_DIR: keysDir, WORKFLOW_STORAGE_PATH: workflowsDir,
      WORKRAIL_ENABLE_V2_TOOLS: 'true', WORKRAIL_ENABLE_SESSION_TOOLS: 'false', WORKRAIL_AGENT_PROFILE: profile,
    });
    let serverInstance: { connect: (transport: unknown) => Promise<void>; close: () => Promise<void> };
    try {
      const serverPath = resolve(process.cwd(), 'src/mcp/server.ts');
      const baseline = loadNotesBaseline();
      baseline.container.resetContainer();
      const serverMod = baseline.server as { composeServer: () => Promise<{ server: typeof serverInstance }> };
      serverInstance = (await serverMod.composeServer()).server;
    } catch (error) {
      expect.fail(`runtime_unavailable: WORKRAIL_AGENT_PROFILE=${profile} (${String(error)})`);
    }
    servers.push(serverInstance);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'host-persisted-reader-probe', version: '1.0.0' });
    clients.push(client);
    await Promise.all([serverInstance.connect(serverTransport), client.connect(clientTransport)]);

    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
      expect(res.isError, `MCP error from ${name}: ${JSON.stringify(res.content)}`).not.toBe(true);
      return JSON.parse(z.object({ content: z.array(z.object({ text: z.string() })).min(1) }).parse(res).content[0]!.text) as unknown;
    };
    return { call, close: async () => {
      await bounded(client.close());
      clients.splice(clients.indexOf(client), 1);
      await bounded(serverInstance.close());
      servers.splice(servers.indexOf(serverInstance), 1);
    } };
  };

  const bounded = async (work: Promise<unknown>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Cleanup timed out; preserve storage')), 3000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };

  const closeHost = async (host: TrustedAnswerScheduler) => {
    await bounded((async () => {
      const result = await host.close(AbortSignal.timeout(2500));
      if (result.kind !== 'closed') throw new Error(`Host cleanup incomplete: ${result.reason}`);
      hosts.delete(host);
    })());
  };

  let primaryError: unknown;
  try {
    await run({ root, dataDir, storageConfig, sharedAuthorityConfig, workRequest, trackHost: s => { hosts.add(s); }, closeHost, snapshotStorage, loadFactory: loadCandidateHostFactory, bootMcp });
  } catch (err) {
    primaryError = err; throw err;
  } finally {
    const cleanupErrors: unknown[] = [];
    const clean = async (work: () => Promise<unknown>) => {
      try { await bounded(work()); } catch (error) { cleanupErrors.push(error); }
    };
    for (const host of hosts) await clean(() => closeHost(host));
    for (const c of clients) await clean(() => c.close());
    for (const s of servers) await clean(() => s.close());
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
// 1. Positive Control (Legacy Population via Notes MCP and LocalSessionEventLogStoreV2)
// -----------------------------------------------------------------------------

it('positive control (legacy): real legacy notes session recovered via LocalSessionEventLogStoreV2, detects exact digest_mismatch on corruption, and classifies version bump as unknown_schema_version', () => persistedReaderFixture(async f => {
  const mcp = await f.bootMcp('notes');
  const started = z.object({ kind: z.literal('work'), assignment: z.string() }).passthrough().parse(
    await mcp.call('start_work', { workflowId: 'two-step-test', workspacePath: f.root, goal: 'Legacy notes persisted reader probe' })
  );
  const step1 = z.object({ kind: z.literal('work'), assignment: z.string() }).passthrough().parse(
    await mcp.call('submit_work', { assignment: started.assignment, result: { notes: 'First observation live legacy notes.' } })
  );
  expect(step1.kind).toBe('work');
  await mcp.close();

  expect(f.storageConfig.journalRootDir).toBe(f.dataDir.sessionsDir());
  const { sessionId, manifestPath, manifestRaw, targetSeg, targetSegPath } = await locateCommittedSegment(f.dataDir, f.root);

  const fsPort = new NodeFileSystemV2();
  const shaPort = new NodeSha256V2();
  const store = new LocalSessionEventLogStoreV2(f.dataDir, fsPort, shaPort);

  const load1 = await store.load(sessionId);
  expect(load1.isOk()).toBe(true);
  if (!load1.isOk()) return;
  const notesEvt = load1.value.events.find(
    (e): e is Extract<DomainEventV1, { kind: 'node_output_appended' }> =>
      e.kind === 'node_output_appended' && (e.data as { payload?: { payloadKind?: string } }).payload?.payloadKind === 'notes'
  );
  expect(notesEvt).toBeDefined();
  if (notesEvt && notesEvt.data.payload.payloadKind === 'notes') {
    expect(notesEvt.data.payload.notesMarkdown).toBe('First observation live legacy notes.');
  }

  const pristineSegBytes = Buffer.from(await readFile(targetSegPath));
  const pristineManifest = manifestRaw;

  // Mutate attested bytes without updating manifest -> exact digest_mismatch
  const corruptBytes = Buffer.from(pristineSegBytes);
  corruptBytes[0] = corruptBytes[0]! ^ 0xff;
  await writeFile(targetSegPath, corruptBytes);

  const corruptSnapshot = await f.snapshotStorage();
  const loadCorrupt = await store.load(sessionId);
  expect(await f.snapshotStorage()).toEqual(corruptSnapshot);
  expect(loadCorrupt.isErr()).toBe(true);
  if (loadCorrupt.isErr()) {
    expect(loadCorrupt.error.code).toBe('SESSION_STORE_CORRUPTION_DETECTED');
    if (loadCorrupt.error.code === 'SESSION_STORE_CORRUPTION_DETECTED') {
      expect(loadCorrupt.error.reason.code).toBe('digest_mismatch');
    }
  }

  // Restore reads exact truth
  await writeFile(targetSegPath, pristineSegBytes);
  await writeFile(manifestPath, pristineManifest);

  const loadRestored = await store.load(sessionId);
  expect(loadRestored.isOk()).toBe(true);
  if (!loadRestored.isOk()) return;
  const restoredNotes = loadRestored.value.events.find(
    (e): e is Extract<DomainEventV1, { kind: 'node_output_appended' }> =>
      e.kind === 'node_output_appended' && (e.data as { payload?: { payloadKind?: string } }).payload?.payloadKind === 'notes'
  );
  expect(restoredNotes).toBeDefined();
  if (restoredNotes && restoredNotes.data.payload.payloadKind === 'notes') {
    expect(restoredNotes.data.payload.notesMarkdown).toBe('First observation live legacy notes.');
  }

  // Version refusal: change documented v discriminator in segment to unsupported version (99), update manifest sha256/bytes consistently
  const segLines = pristineSegBytes.toString('utf8').trim().split('\n');
  const evtObj = JSON.parse(segLines[0]!);
  expect(evtObj.v).toBe(1);
  evtObj.v = 99;
  segLines[0] = JSON.stringify(evtObj);
  const verSegBytes = Buffer.from(segLines.join('\n') + '\n', 'utf8');
  await writeFile(targetSegPath, verSegBytes);

  const newHash = 'sha256:' + createHash('sha256').update(verSegBytes).digest('hex');
  const verManifest = pristineManifest.trim().split('\n').map(l => {
    const r = JSON.parse(l);
    if (r.kind === 'segment_closed' && r.segmentRelPath === targetSeg.segmentRelPath) {
      return JSON.stringify({ ...r, sha256: newHash, bytes: verSegBytes.length });
    }
    return l;
  }).join('\n') + '\n';
  await writeFile(manifestPath, verManifest);

  const versionSnapshot = await f.snapshotStorage();
  const loadVer = await store.load(sessionId);
  expect(await f.snapshotStorage()).toEqual(versionSnapshot);
  expect(loadVer.isErr()).toBe(true);
  if (loadVer.isErr()) {
    expect(loadVer.error.code).toBe('SESSION_STORE_CORRUPTION_DETECTED');
    if (loadVer.error.code === 'SESSION_STORE_CORRUPTION_DETECTED') {
      expect(loadVer.error.reason.code).toBe('unknown_schema_version');
      expect(loadVer.error.reason.code).not.toBe('unsupported_version');
    }
  }

  await writeFile(targetSegPath, pristineSegBytes);
  await writeFile(manifestPath, pristineManifest);
  const finalLoad = await store.load(sessionId);
  expect(finalLoad.isOk()).toBe(true);
  if (finalLoad.isOk()) expect(finalLoad.value.events).toEqual(load1.value.events);
}));

// -----------------------------------------------------------------------------
// 2. Candidate Corruption Case (F041 Segment Mutation Refusal and Restored Control)
// -----------------------------------------------------------------------------

it('candidate corruption: flips segment byte without manifest update, recover refuses with corrupt, exact bytes preserved and zero inference, pristine positive control completes', () => persistedReaderFixture(async f => {
  const fakeModel = new FakeTestModelBoundary();
  const signal = new AbortController().signal;

  const firstTurn = await runCandidateFirstTurn(f, fakeModel, 'Step 1 candidate note', signal);
  if (!firstTurn) return;
  const { pointer, receipt1, targetSegPath, manifestPath, manifestRaw } = firstTurn;
  const pristineSegBytes = Buffer.from(await readFile(targetSegPath));
  const pristineManifest = manifestRaw;

  // Corruption case: flip a byte without updating manifest
  const corruptBytes = Buffer.from(pristineSegBytes);
  corruptBytes[0] = corruptBytes[0]! ^ 0xff;
  await writeFile(targetSegPath, corruptBytes);

  const recomposedFactory = await f.loadFactory();
  await assertRecoveryRefusal(
    recomposedFactory, { ...f.sharedAuthorityConfig, model: fakeModel }, pointer,
    'corrupt', fakeModel, f.snapshotStorage, f.trackHost, f.closeHost, signal
  );

  // Restore originals and complete positive control
  await writeFile(targetSegPath, pristineSegBytes);
  await writeFile(manifestPath, pristineManifest);

  await runPositiveCompletion(
    recomposedFactory, { ...f.sharedAuthorityConfig, model: fakeModel }, pointer,
    receipt1, 'Step 1 candidate note', 'Step 2 accepted successor candidate note',
    fakeModel, f.trackHost, f.closeHost, signal
  );
}));

// -----------------------------------------------------------------------------
// 3. Candidate Version Case (F041 Documented Discriminator Refusal and Restored Control)
// -----------------------------------------------------------------------------

it('candidate version: updates documented v discriminator to unsupported version with consistent digest, recover refuses with unsupported_version, exact bytes preserved and zero inference, pristine control completes', () => persistedReaderFixture(async f => {
  const fakeModel = new FakeTestModelBoundary();
  const signal = new AbortController().signal;

  const firstTurn = await runCandidateFirstTurn(f, fakeModel, 'Step 1 candidate note for version case', signal);
  if (!firstTurn) return;
  const { pointer, receipt1, targetSeg, targetSegPath, manifestPath, manifestRaw } = firstTurn;
  const pristineSegBytes = Buffer.from(await readFile(targetSegPath));
  const pristineManifest = manifestRaw;

  // Version case: change documented v discriminator in committed event to unsupported numeric version (99),
  // and update segment digest/bytes attestation in manifest consistently so hash mismatch cannot mask version check
  const segLines = pristineSegBytes.toString('utf8').trim().split('\n');
  const evtObj = JSON.parse(segLines[0]!);
  expect(evtObj.v).toBe(1);
  evtObj.v = 99;
  segLines[0] = JSON.stringify(evtObj);
  const verSegBytes = Buffer.from(segLines.join('\n') + '\n', 'utf8');
  await writeFile(targetSegPath, verSegBytes);

  const newDigest = 'sha256:' + createHash('sha256').update(verSegBytes).digest('hex');
  const verManifest = pristineManifest.trim().split('\n').map(l => {
    const r = JSON.parse(l);
    if (r.kind === 'segment_closed' && r.segmentRelPath === targetSeg.segmentRelPath) {
      return JSON.stringify({ ...r, sha256: newDigest, bytes: verSegBytes.length });
    }
    return l;
  }).join('\n') + '\n';
  await writeFile(manifestPath, verManifest);

  const recomposedFactory = await f.loadFactory();
  await assertRecoveryRefusal(
    recomposedFactory, { ...f.sharedAuthorityConfig, model: fakeModel }, pointer,
    'unsupported_version', fakeModel, f.snapshotStorage, f.trackHost, f.closeHost, signal
  );

  // Restore originals and complete positive control
  await writeFile(targetSegPath, pristineSegBytes);
  await writeFile(manifestPath, pristineManifest);

  await runPositiveCompletion(
    recomposedFactory, { ...f.sharedAuthorityConfig, model: fakeModel }, pointer,
    receipt1, 'Step 1 candidate note for version case', 'Step 2 accepted successor note for version case',
    fakeModel, f.trackHost, f.closeHost, signal
  );
}));
