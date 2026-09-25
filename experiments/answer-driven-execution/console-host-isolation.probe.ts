/** Console host-bound isolation acceptance probe for answer-driven execution.
 * Covers:
 * - Positive control (legacy): Mounted Express console routes and session storage run independently.
 * - Parameterized cases (active_owner vs released_ownership):
 *   Host-bound session accepts step 1 notes receipt, pending step 2. Unbound mounted console
 *   HTTP GET /answer and GET /answer/receipts/:receipt strictly refuse with 403 bound_session_required,
 *   unchanged journal and pin storage, zero leaked worker authority (no reply/recovery), zero extra model
 *   inference. Boundness survives ownership release (old runner stale). Rightful host recovery finishes
 *   step 2 with exact notes/receipt payloads. Positive unbound candidate session on same mounted router
 *   returns 200 with exact actual contribution.
 * Production module 'src/answer-v1/host.ts' is currently absent (fails with runtime_unavailable, not skip).
 */
import 'reflect-metadata';
import { createWorkRailEngine } from '../../src/engine/index.js';
import { createHash } from 'node:crypto';
import { rename, lstat } from 'node:fs/promises';
import { relative, isAbsolute, sep } from 'node:path';
import { ManifestRecordV1Schema, type ManifestRecordV1 } from '../../src/v2/durable-core/schemas/session/manifest.js';
import { describe, expect, it, vi } from 'vitest';
import express, { type Application } from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { LocalDataDirV2 } from '../../src/v2/infra/local/data-dir/index.js';
import { LocalDirectoryListingV2 } from '../../src/v2/infra/local/directory-listing/index.js';
import { NodeFileSystemV2 } from '../../src/v2/infra/local/fs/index.js';
import { InMemoryWorkflowStorage } from '../../src/infrastructure/storage/in-memory-storage.js';
import { DefaultWorkflowService } from '../../src/application/services/workflow-service.js';
import { ValidationEngine } from '../../src/application/services/validation-engine.js';
import { EnhancedLoopValidator } from '../../src/application/services/enhanced-loop-validator.js';
import { WorkflowCompiler } from '../../src/application/services/workflow-compiler.js';
import { WorkflowInterpreter } from '../../src/application/services/workflow-interpreter.js';
import { ConsoleService } from '../../src/v2/usecases/console-service.js';
import { mountConsoleRoutes } from '../../src/v2/usecases/console-routes.js';
import { createWorkflow } from '../../src/types/workflow.js';
import { createBundledSource } from '../../src/types/workflow-source.js';
import { EnvironmentFeatureFlagProvider } from '../../src/config/feature-flags.js';
import type { V2ToolContext } from '../../src/mcp/types.js';
import { asSessionId, type SessionId } from '../../src/v2/durable-core/ids/index.js';
import type { WorkflowDefinition } from '../../src/types/workflow-definition.js';
import type {
  AnswerMcpCompositionOptions, HostJournalStorageConfig, HostWorkRequest,
  ModelCompletionResult, ModelInferenceBoundary, ModelPromptInput,
  SharedAuthorityConfig, TrustedAnswerScheduler,
} from './host-composition.js';
import type { HostExecutorPorts, RawModelResponse } from './invocation-contract.js';
import type {
  DurableJournalFaultSeam, JournalFaultAction, JournalFaultBoundary,
} from './host-composition.js';
import type { ExecutionRef } from './invocation-contract.js';
import type { DiscoveredHostSession, DiscoveredSessionEntry, HostDiscoveryCursor, HostScanResult } from './host-discovery-contract.js';
import type { BoundTurnRunner } from './host-composition.js';
import type { HostEnrollment } from './invocation-contract.js';
import type { HostSessionScanner } from './host-discovery-contract.js';
import type { ReadRef, ReceiptRef } from './answer-contract.js';
import type { ConsoleReadRuntime, MountConsoleRoutesWithAnswerReader } from './console-composition.js';
import type { ConsoleHostScopedAnswerReader } from './console-contract.js';

vi.mock('os', async original => {
  const actual = await original<typeof import('node:os')>();
  const homedir = () => '/__unavailable_workrail_console_fixture_home__';
  return { ...actual, homedir, default: { ...actual, homedir } };
});

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

async function loadConsoleReadFactory(): Promise<typeof import('./console-composition.js').createConsoleReadRuntime> {
  const path = resolve(process.cwd(), 'src/answer-v1/console.ts');
  try { await stat(path); } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      expect.fail(`runtime_unavailable: src/answer-v1/console.ts (${path})`);
    }
    throw error;
  }
  const mod = await import(/* @vite-ignore */ path) as { createConsoleReadRuntime?: typeof import('./console-composition.js').createConsoleReadRuntime };
  if (typeof mod.createConsoleReadRuntime !== 'function') throw new Error('runtime_error: missing createConsoleReadRuntime export');
  return mod.createConsoleReadRuntime;
}

const assertNoReply = (raw: unknown): void => {
  if (raw && typeof raw === 'object') {
    expect(Object.hasOwn(raw, 'reply'), 'Console read projections cannot mint reply authority').toBe(false);
    expect(Object.hasOwn(raw, 'recovery'), 'Console read projections cannot mint worker recovery authority').toBe(false);
    expect(Object.hasOwn(raw, 'owner'), 'Console reads cannot expose owner authority').toBe(false);
    expect(Object.hasOwn(raw, 'attempt'), 'Console reads cannot expose enrollment attempt authority').toBe(false);
    for (const value of Object.values(raw)) assertNoReply(value);
  }
};

const viewSchema = z.object({ kind: z.string(), read: z.string(), reply: z.string().optional() }).passthrough();
const recordedSchema = z.object({ kind: z.literal('recorded'), receipt: z.string(), disposition: z.enum(['accepted', 'partial', 'rejected']), view: viewSchema }).passthrough();
const openedSchema = z.object({ kind: z.literal('opened'), recovery: z.string(), view: viewSchema }).passthrough();
const question = (raw: unknown) => {
  const view = viewSchema.parse(raw); expect(view.kind).toBe('question');
  return z.object({ reply: z.string().min(1), read: z.string().min(1), instruction: z.string().min(1) }).passthrough().parse(view);
};

const candidateRefusalSchema = z.object({
  success: z.literal(false), error: z.string(),
  outcome: z.object({ kind: z.literal('refused'), sessionId: z.string(), reason: z.literal('bound_session_required') }).strict(),
}).strict();
const candidateReceiptRefusalSchema = z.object({
  success: z.literal(false), error: z.string(),
  outcome: z.object({ kind: z.literal('refused'), sessionId: z.string(), receipt: z.string(), reason: z.literal('bound_session_required') }).strict(),
}).strict();
const candidateAnswerResponseSchema = z.object({
  success: z.literal(true), data: z.object({
    sessionId: z.string(), view: z.object({
      kind: z.literal('question'), read: z.string(), instruction: z.string(),
      retained: z.array(z.object({ receipt: z.string(), description: z.string() }).strict()),
    }).passthrough(),
  }).strict(),
}).strict();
const candidateReceiptResponseSchema = z.object({
  success: z.literal(true), data: z.object({
    sessionId: z.string(), receipt: z.string(), page: z.object({
      kind: z.literal('complete'), receipt: z.string(), disposition: z.enum(['accepted', 'partial', 'rejected']),
      encoding: z.enum(['canonical_json', 'raw_utf8']), chunk: z.string(),
    }).strict(),
  }).strict(),
}).strict();

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

interface ConsoleHostFixtureContext {
  root: string; dataDir: LocalDataDirV2; ctx: V2ToolContext;
  storageConfig: HostJournalStorageConfig; sharedAuthorityConfig: SharedAuthorityConfig;
  trackHost: (scheduler: TrustedAnswerScheduler) => void;
  loadConsoleFactory: typeof loadConsoleReadFactory;
  trackReadRuntime: (runtime: Pick<ConsoleReadRuntime, 'close'>) => void;
  mountScopedReader: (reader: ConsoleHostScopedAnswerReader) => Promise<(path: string) => Promise<{ status: number; body: unknown }>>;
  loadFactory: () => Promise<typeof import('./host-composition.js').createAnswerHost>;
  bootMcp: (profile: 'notes' | 'answers', options?: AnswerMcpCompositionOptions) => Promise<{
    call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  }>;
  get: (path: string) => Promise<{ status: number; body: unknown }>;
  snapshotRoot: () => Promise<Record<string, string>>;
  snapshotJournal: () => Promise<Record<string, string>>;
  snapshotPins: () => Promise<Record<string, string>>;
  listSessionDirs: () => Promise<Set<string>>;
  discoverNewSessionId: (existing: ReadonlySet<string>) => Promise<SessionId>;
}

let priorCleanupFailure: Error | undefined;

async function consoleHostFixture(run: (f: ConsoleHostFixtureContext) => Promise<void>): Promise<void> {
  if (priorCleanupFailure) throw priorCleanupFailure;
  const root = await mkdtemp(join(tmpdir(), 'workrail-console-host-isolation-'));
  const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
  const [journalRootDir, hostIndexRootDir, workflowsDir, keysDir, pinnedDir] = [
    dataDir.sessionsDir(), join(root, 'answer-v1', 'host-index'), join(root, 'workflows'),
    dataDir.keysDir(), dataDir.pinnedWorkflowsDir(),
  ];
  await Promise.all([journalRootDir, hostIndexRootDir, workflowsDir, keysDir, pinnedDir].map(d => mkdir(d, { recursive: true })));

  const workflowDef: WorkflowDefinition = {
    id: 'two-step-test', name: 'Two Step Acceptance Test Workflow', description: 'Actual two-step workflow for console host isolation probe', version: '1.0.0',
    steps: [{ id: 'step-1', title: 'Step 1: First Observation', prompt: 'Record first observation.' }, { id: 'step-2', title: 'Step 2: Second Observation', prompt: 'Record second observation.' }],
  };
  await writeFile(join(workflowsDir, 'two-step-test.json'), JSON.stringify(workflowDef), 'utf8');

  const storageConfig: HostJournalStorageConfig = { journalRootDir, hostIndexRootDir };
  const sharedAuthorityConfig: SharedAuthorityConfig = { storage: storageConfig, keyringPath: dataDir.keyringPath(), workflowStoragePath: workflowsDir };

  const envKeys = ['WORKRAIL_DATA_DIR', 'WORKRAIL_KEYS_DIR', 'WORKFLOW_STORAGE_PATH', 'WORKRAIL_ENABLE_V2_TOOLS', 'WORKRAIL_ENABLE_SESSION_TOOLS', 'WORKRAIL_AGENT_PROFILE', 'ANTHROPIC_API_KEY'] as const;
  const previousEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  Object.assign(process.env, {
    ANTHROPIC_API_KEY: 'local-fixture-no-model-call', WORKRAIL_DATA_DIR: root,
    WORKRAIL_KEYS_DIR: keysDir, WORKFLOW_STORAGE_PATH: workflowsDir,
    WORKRAIL_ENABLE_V2_TOOLS: 'true', WORKRAIL_ENABLE_SESSION_TOOLS: 'false',
  });

  const snapshotDir = async (dir: string): Promise<Record<string, string>> => {
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
      if (e.isDirectory()) { res[`dir:${full}`] = 'directory'; Object.assign(res, await snapshotDir(full)); }
      else if (e.isFile()) res[`file:${full}`] = (await readFile(full)).toString('base64');
      else throw new Error(`Unsupported storage entry: ${full}`);
    }
    return res;
  };

  const listSessionDirs = async (): Promise<Set<string>> => {
    try { return new Set((await readdir(journalRootDir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name)); }
    catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') return new Set();
      throw err;
    }
  };

  const discoverNewSessionId = async (existing: ReadonlySet<string>): Promise<SessionId> => {
    const diff = (await readdir(journalRootDir, { withFileTypes: true })).filter(e => e.isDirectory() && !existing.has(e.name)).map(e => e.name);
    expect(diff.length, 'Must discover exactly 1 new session directory').toBe(1);
    return asSessionId(diff[0]!);
  };

  const bounded = async (work: Promise<unknown>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([work, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('Cleanup timed out; preserve fixture storage')), 3000); })]);
    } finally { if (timer) clearTimeout(timer); }
  };

  const hosts: TrustedAnswerScheduler[] = []; const clients: Client[] = []; const servers: Array<{ close: () => Promise<void> }> = [];
  const readRuntimes: Pick<ConsoleReadRuntime, 'close'>[] = [];
  const scopedServers: http.Server[] = [];
  const scopedDisposers: Array<() => void> = [];
  let unmount: (() => void) | undefined;
  let server: http.Server | undefined;
  let primaryError: unknown;
  try {
  const helperMod = await import(/* @vite-ignore */ resolve(process.cwd(), 'tests/helpers/v2-test-helpers.ts')) as {
    createV2ToolContext: (dir: LocalDataDirV2) => Promise<V2ToolContext>;
  };
  const base = await helperMod.createV2ToolContext(dataDir);
  if (!base.v2) throw new Error('Missing fixture engine');
  const twoStepWorkflow = createWorkflow(workflowDef, createBundledSource());
  const reader = new DefaultWorkflowService(new InMemoryWorkflowStorage([twoStepWorkflow.definition]), new ValidationEngine(new EnhancedLoopValidator()), new WorkflowCompiler(), new WorkflowInterpreter());
  const ctx: V2ToolContext = { ...base, v2: base.v2, workflowService: reader, featureFlags: new EnvironmentFeatureFlagProvider() };
  const service = new ConsoleService({ dataDir, directoryListing: new LocalDirectoryListingV2(new NodeFileSystemV2()), sessionStore: ctx.v2.sessionStore, snapshotStore: ctx.v2.snapshotStore, pinnedWorkflowStore: ctx.v2.pinnedStore });
  const app: Application = express();
  unmount = mountConsoleRoutes(app, service, reader, undefined, undefined, 'fixture', ctx);
  server = http.createServer(app);
  await new Promise<void>((res, rej) => { server!.once('error', rej); server!.listen(0, '127.0.0.1', res); });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string) => { const r = await fetch(baseUrl + path, { signal: AbortSignal.timeout(5000) }); return { status: r.status, body: await r.json() }; };


  const mountScopedReader = async (binding: ConsoleHostScopedAnswerReader) => {
    // The existing disposer stops its watcher, not Express route registration.
    // Use a fresh application so an older unbound route cannot shadow this binding.
    const scopedApp = express();
    scopedDisposers.push((mountConsoleRoutes as MountConsoleRoutesWithAnswerReader)(
      scopedApp, service, reader, undefined, undefined, 'fixture', ctx, binding,
    ));
    const scopedServer = http.createServer(scopedApp);
    scopedServers.push(scopedServer);
    await new Promise<void>((res, rej) => {
      scopedServer.once('error', rej); scopedServer.listen(0, '127.0.0.1', res);
    });
    const scopedUrl = `http://127.0.0.1:${(scopedServer.address() as AddressInfo).port}`;
    return async (path: string): Promise<{ status: number; body: unknown }> => {
      const response = await fetch(scopedUrl + path, { signal: AbortSignal.timeout(5000) });
      return { status: response.status, body: await response.json() };
    };
  };

  const bootMcp = async (profile: 'notes' | 'answers', options?: AnswerMcpCompositionOptions) => {
    if (profile === 'answers' && !options?.answerAuthority) expect.fail('Declared options.answerAuthority required');
    if (profile === 'notes' && options !== undefined) expect.fail('Legacy notes calls must pass no options');
    Object.assign(process.env, {
      WORKRAIL_DATA_DIR: root, WORKRAIL_KEYS_DIR: keysDir, WORKFLOW_STORAGE_PATH: workflowsDir,
      WORKRAIL_ENABLE_V2_TOOLS: 'true', WORKRAIL_ENABLE_SESSION_TOOLS: 'false', WORKRAIL_AGENT_PROFILE: profile,
    });
    let serverInstance: { connect: (transport: unknown) => Promise<void>; close: () => Promise<void> };
    try {
      const serverMod = await import(/* @vite-ignore */ resolve(process.cwd(), 'src/mcp/server.ts')) as {
        composeServer: (opts?: AnswerMcpCompositionOptions) => Promise<{ server: typeof serverInstance }>;
      };
      serverInstance = (await serverMod.composeServer(options)).server;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Unknown WORKRAIL_AGENT_PROFILE')) {
        expect.fail(`bootstrap_unavailable: WORKRAIL_AGENT_PROFILE=${profile} (${error.message})`);
      }
      throw error;
    }
    servers.push(serverInstance);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'console-host-isolation-probe', version: '1.0.0' });
    clients.push(client);
    await Promise.all([serverInstance.connect(serverTransport), client.connect(clientTransport)]);
    return {
      call: async (name: string, args: Record<string, unknown>) => {
        const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
        expect(res.isError, `MCP error from ${name}: ${JSON.stringify(res.content)}`).not.toBe(true);
        return JSON.parse(z.object({ content: z.array(z.object({ text: z.string() })).min(1) }).parse(res).content[0]!.text) as unknown;
      },
    };
  };

    await run({
      root, dataDir, ctx, storageConfig, sharedAuthorityConfig,
      trackHost: scheduler => hosts.push(scheduler), loadFactory: loadCandidateHostFactory,
      loadConsoleFactory: loadConsoleReadFactory,
      trackReadRuntime: runtime => readRuntimes.push(runtime), mountScopedReader,
      snapshotRoot: () => snapshotDir(root),
      bootMcp, get, snapshotJournal: () => snapshotDir(journalRootDir),
      snapshotPins: () => snapshotDir(pinnedDir), listSessionDirs, discoverNewSessionId,
    });
  } catch (err) {
    primaryError = err; throw err;
  } finally {
    const cleanupErrors: unknown[] = [];
    const clean = async (work: () => Promise<unknown>) => {
      try { await bounded(work()); } catch (error) { cleanupErrors.push(error); }
    };
    for (const scopedServer of scopedServers) await clean(async () => {
      scopedServer.closeAllConnections();
      if (scopedServer.listening) await new Promise<void>((res, rej) => scopedServer.close(error => error ? rej(error) : res()));
    });
    for (const dispose of scopedDisposers) await clean(async () => { dispose(); });
    for (const runtime of readRuntimes) await clean(async () => {
      const result = await runtime.close(AbortSignal.timeout(2500));
      if (result.kind !== 'closed') throw new Error(`Reader close incomplete: ${result.reason}`);
    });
    while (hosts.length > 0) {
      const h = hosts.pop()!;
      await clean(async () => {
        const res = await h.close(AbortSignal.timeout(2500));
        if (res.kind !== 'closed') throw new Error(`Host cleanup incomplete: ${res.reason}`);
      });
    }
    while (clients.length > 0) { const c = clients.pop()!; await clean(() => c.close()); }
    while (servers.length > 0) { const s = servers.pop()!; await clean(() => s.close()); }
    if (server) {
      const s = server; server = undefined;
      await clean(() => new Promise<void>((res, rej) => { s.closeAllConnections(); s.close(err => err ? rej(err) : res()); }));
    }
    if (unmount) { try { unmount(); } catch (err) { cleanupErrors.push(err); } unmount = undefined; }
    if (!cleanupErrors.length) await clean(async () => {
      const mod = await import(/* @vite-ignore */ resolve(process.cwd(), 'src/di/container.ts')) as { resetContainer: () => void };
      mod.resetContainer();
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
// Positive Control (Legacy Console Routes)
// -----------------------------------------------------------------------------

it('positive control (legacy): mounted console routes and session storage run independently', () => consoleHostFixture(async f => {
  const catalog = await f.get('/api/v2/workflows');
  expect(catalog.status).toBe(200);
  expect(catalog.body).toMatchObject({
    success: true, data: { workflows: expect.arrayContaining([expect.objectContaining({ id: 'two-step-test', version: '1.0.0' })]) },
  });
  const initialSessions = await f.get('/api/v2/sessions');
  expect(initialSessions.status).toBe(200);
  expect(initialSessions.body).toMatchObject({ success: true, data: { sessions: [] } });
}));

// -----------------------------------------------------------------------------
// Parameterized Host Isolation Cases (Active vs Released Ownership)
// -----------------------------------------------------------------------------

it.each([
  { mode: 'active_owner' as const, label: 'active host owner' },
  { mode: 'released_ownership' as const, label: 'released ownership (boundness survives release)' },
])('case: $label refuses mounted console GET answer and receipt, rightful host finishes step 2', ({ mode }) => consoleHostFixture(async f => {
  const createAnswerHost = await f.loadFactory();
  const fakeModel = new FakeTestModelBoundary();
  const signal = new AbortController().signal;

  const mcp = await f.bootMcp('answers', { answerAuthority: f.sharedAuthorityConfig });
  const hostResult = await createAnswerHost({ ...f.sharedAuthorityConfig, model: fakeModel }, signal);
  expect(hostResult.kind).toBe('created');
  if (hostResult.kind !== 'created') return;
  const scheduler = hostResult.scheduler;
  f.trackHost(scheduler);

  // 1. Enroll host session
  const workRequest: HostWorkRequest = { workflowId: 'two-step-test', goal: `Console host isolation probe (${mode})`, workspacePath: f.root };
  const beforeHostEnrollment = await f.listSessionDirs();
  const enrollResult = await scheduler.enroll(workRequest, signal);
  expect(enrollResult.kind).toBe('enrolled');
  if (enrollResult.kind !== 'enrolled') return;
  const { runner, initialView, enrollment, owner } = enrollResult;
  expect(initialView.kind).toBe('question');
  if (initialView.kind !== 'question') return;
  expect(initialView.instruction).toBe('Record first observation.');
  expect(fakeModel.callCount).toBe(0);
  const sessionId = await f.discoverNewSessionId(beforeHostEnrollment);

  // 2. Host accepts notes step 1 -> actual receipt, still pending step 2
  fakeModel.setQueuedResponses([makeAnswerResponse('call_step1', 'Step 1 host note')]);
  const turn1 = await runner.runTurn(signal);
  expect(turn1.kind).toBe('advanced');
  if (turn1.kind !== 'advanced') throw new Error('Expected first advancement');
  expect(turn1.nextView.kind).toBe('question');
  if (turn1.nextView.kind !== 'question') throw new Error('Expected pending second question');
  expect(turn1.nextView.instruction).toBe('Record second observation.');
  const receipt1 = turn1.receipt;
  expect(fakeModel.callCount).toBe(1);

  // 3. Ownership state handling: active owner vs released ownership
  let activeRunner = runner;
  let activeEnrollment = enrollment;
  if (mode === 'released_ownership') {
    const releaseResult = await scheduler.releaseOwnership(enrollment, owner, signal);
    expect(releaseResult.kind).toBe('released');
    if (releaseResult.kind !== 'released') return;

    const snapBeforeStale = await f.snapshotJournal();
    const modelBeforeStale = fakeModel.callCount;
    const staleOutcome = await runner.runTurn(signal);
    expect(staleOutcome.kind).toBe('stale_owner');
    expect(await f.snapshotJournal()).toEqual(snapBeforeStale);
    expect(fakeModel.callCount).toBe(modelBeforeStale);
  }

  // 4. HTTP unbound route must 403 strict refused bound_session_required for answer and known actual receipt
  const journalBeforeHttp = await f.snapshotJournal();
  const pinsBeforeHttp = await f.snapshotPins();
  const modelCallsBeforeHttp = fakeModel.callCount;

  const verifyRefusal = async (path: string, receipt?: string) => {
    const res = await f.get(path);
    expect(res.status).toBe(403);
    assertNoReply(res.body);
    if (receipt) {
      const parsed = candidateReceiptRefusalSchema.parse(res.body);
      expect(parsed.outcome.sessionId).toBe(sessionId);
      expect(parsed.outcome.receipt).toBe(receipt);
      expect(parsed.outcome.reason).toBe('bound_session_required');
    } else {
      const parsed = candidateRefusalSchema.parse(res.body);
      expect(parsed.outcome.sessionId).toBe(sessionId);
      expect(parsed.outcome.reason).toBe('bound_session_required');
    }
    expect(await f.snapshotJournal()).toEqual(journalBeforeHttp);
    expect(await f.snapshotPins()).toEqual(pinsBeforeHttp);
    expect(fakeModel.callCount).toBe(modelCallsBeforeHttp);
  };
  await verifyRefusal(`/api/v2/sessions/${encodeURIComponent(sessionId)}/answer`);
  await verifyRefusal(`/api/v2/sessions/${encodeURIComponent(sessionId)}/answer/receipts/${encodeURIComponent(receipt1)}`, receipt1);

  // 5. Rightful host finishes step 2 with exact notes/receipt payloads
  if (mode === 'released_ownership') {
    const recovered = await scheduler.recover(scheduler.hydrator.dehydrate(enrollment), signal);
    expect(recovered.kind).toBe('ready');
    if (recovered.kind !== 'ready') return;
    expect(recovered.owner.epoch).toBeGreaterThan(owner.epoch);
    activeRunner = recovered.runner;
    activeEnrollment = recovered.enrollment;
  }

  fakeModel.setQueuedResponses([makeAnswerResponse('call_step2', 'Step 2 host note')]);
  const turn2 = await activeRunner.runTurn(signal);
  expect(turn2.kind).toBe('advanced');
  if (turn2.kind !== 'advanced') throw new Error('Expected second advancement');
  expect(turn2.nextView.kind).toBe('finished');
  if (turn2.nextView.kind !== 'finished') throw new Error('Expected finished view');
  expect(turn2.nextView.execution.kind).toBe('completed');
  expect(turn2.nextView.taskOutcome).toBe('unknown');
  expect(fakeModel.callCount).toBe(2);
  const receipt2 = turn2.receipt;
  expect(receipt2).not.toBe(receipt1);

  const ports = scheduler.bindDiagnosticPorts(activeEnrollment);
  await verifyReceiptChunk(ports, turn2.nextView.read, receipt1, 'Step 1 host note', signal);
  await verifyReceiptChunk(ports, turn2.nextView.read, receipt2, 'Step 2 host note', signal);

  // 6. Positive unbound candidate session on same mounted router GET 200 with exact actual contribution
  const dirsBefore = await f.listSessionDirs();
  const openRes = openedSchema.parse(await mcp.call('open_work', { workflowId: 'two-step-test', workspacePath: f.root, goal: `Candidate unbound positive control (${mode})` }));
  const unboundSessionId = await f.discoverNewSessionId(dirsBefore);
  const unboundQ1 = question(openRes.view);
  const unboundStep1 = recordedSchema.parse(await mcp.call('answer_work', { reply: unboundQ1.reply, answer: { notes: `Exact unbound note step 1 (${mode})` } }));
  expect(unboundStep1.disposition).toBe('accepted');
  const unboundReceipt1 = unboundStep1.receipt;

  const beforeUnboundRead = await f.snapshotJournal();
  const beforeUnboundPins = await f.snapshotPins();
  const unboundAnswerRes = await f.get(`/api/v2/sessions/${encodeURIComponent(unboundSessionId)}/answer`);
  expect(unboundAnswerRes.status).toBe(200);
  assertNoReply(unboundAnswerRes.body);
  const parsedUnboundAnswer = candidateAnswerResponseSchema.parse(unboundAnswerRes.body);
  expect(parsedUnboundAnswer.data.sessionId).toBe(unboundSessionId);
  expect(parsedUnboundAnswer.data.view.kind).toBe('question');
  expect(parsedUnboundAnswer.data.view.retained).toEqual(expect.arrayContaining([expect.objectContaining({ receipt: unboundReceipt1 })]));

  const unboundReceiptRes = await f.get(`/api/v2/sessions/${encodeURIComponent(unboundSessionId)}/answer/receipts/${encodeURIComponent(unboundReceipt1)}`);
  expect(unboundReceiptRes.status).toBe(200);
  assertNoReply(unboundReceiptRes.body);
  const parsedUnboundReceipt = candidateReceiptResponseSchema.parse(unboundReceiptRes.body);
  expect(parsedUnboundReceipt.data.sessionId).toBe(unboundSessionId);
  expect(parsedUnboundReceipt.data.receipt).toBe(unboundReceipt1);
  expect(parsedUnboundReceipt.data.page.kind).toBe('complete');
  expect(parsedUnboundReceipt.data.page.disposition).toBe('accepted');
  expect(JSON.parse(parsedUnboundReceipt.data.page.chunk)).toEqual({ notes: `Exact unbound note step 1 (${mode})` });
  expect(await f.snapshotJournal()).toEqual(beforeUnboundRead);
  expect(await f.snapshotPins()).toEqual(beforeUnboundPins);
  expect(fakeModel.callCount).toBe(2);
}));

it.each([
  { mode: 'cancelled' as const, label: 'cancelled terminal mode' },
  { mode: 'timeout' as const, label: 'timeout terminal mode' },
  { mode: 'failed' as const, label: 'failed terminal mode' },
  { mode: 'completed' as const, label: 'completed terminal mode' },
])('scoped console lifecycle ($mode): $label verifies finished view, receipts, and invalid_scope refusal', ({ mode }) => consoleHostFixture(async f => {
  const finishedResponseSchema = z.object({
    success: z.literal(true),
    data: z.object({
      sessionId: z.string(),
      view: z.object({
        kind: z.literal('finished'),
        read: z.string(),
        retained: z.array(z.object({ receipt: z.string(), description: z.string() }).strict()),
        execution: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('completed') }).strict(),
          z.object({ kind: z.literal('incomplete'), reason: z.enum(['cancelled', 'timeout', 'failed']), detail: z.string() }).strict(),
        ]),
        taskOutcome: z.literal('unknown'),
      }).strict(),
    }).strict(),
  }).strict();

  const scopedRefusalSchema = z.object({
    success: z.literal(false), error: z.string(),
    outcome: z.object({ kind: z.literal('refused'), sessionId: z.string(), reason: z.literal('invalid_scope') }).strict(),
  }).strict();

  const createAnswerHost = await f.loadFactory();
  const createConsoleReadRuntime = await f.loadConsoleFactory();
  const fakeModel = new FakeTestModelBoundary();
  const signal = new AbortController().signal;

  const hostResult = await createAnswerHost({ ...f.sharedAuthorityConfig, model: fakeModel }, signal);
  if (hostResult.kind === 'created') f.trackHost(hostResult.scheduler);
  expect(hostResult.kind).toBe('created');
  if (hostResult.kind !== 'created') throw new Error("Required candidate setup failed");
  const scheduler = hostResult.scheduler;

  // 1. Enroll host session
  const workRequest: HostWorkRequest = { workflowId: 'two-step-test', goal: `Scoped console lifecycle (${mode})`, workspacePath: f.root };
  const beforeFirstEnroll = await f.listSessionDirs();
  const enrollResult = await scheduler.enroll(workRequest, signal);
  expect(enrollResult.kind).toBe('enrolled');
  if (enrollResult.kind !== 'enrolled') throw new Error("Required candidate setup failed");
  const { runner, initialView, enrollment, owner } = enrollResult;
  expect(initialView.kind).toBe('question');
  const sessionId = await f.discoverNewSessionId(beforeFirstEnroll);

  // 2. Host accepts notes step 1 -> actual receipt1, pending question 2
  fakeModel.setQueuedResponses([makeAnswerResponse('call_step1', 'Step 1 host note')]);
  const turn1 = await runner.runTurn(signal);
  expect(turn1.kind).toBe('advanced');
  if (turn1.kind !== 'advanced') throw new Error('Expected first advancement');
  expect(turn1.nextView.kind).toBe('question');
  const receipt1 = turn1.receipt;
  expect(fakeModel.callCount).toBe(1);

  // 3. Construct real console runtime with same authority config and track before assertions
  const consoleRuntimeResult = await createConsoleReadRuntime(f.sharedAuthorityConfig, signal);
  if (consoleRuntimeResult.kind === 'created') f.trackReadRuntime(consoleRuntimeResult.runtime);
  expect(consoleRuntimeResult.kind).toBe('created');
  if (consoleRuntimeResult.kind !== 'created') throw new Error("Required candidate setup failed");
  const consoleRuntime = consoleRuntimeResult.runtime;

  const bindResult = await consoleRuntime.bindHost(enrollment, signal);
  expect(bindResult.kind).toBe('bound');
  if (bindResult.kind !== 'bound') throw new Error("Required candidate setup failed");
  const reader = bindResult.reader;
  expect(reader.boundSessionId).toBe(sessionId);

  // 4. Mount scoped reader and verify active question view via scoped GET
  const scopedGet = await f.mountScopedReader(reader);
  const questionRes = await scopedGet(`/api/v2/sessions/${encodeURIComponent(sessionId)}/answer`);
  expect(questionRes.status).toBe(200);
  assertNoReply(questionRes.body);
  const parsedQuestion = candidateAnswerResponseSchema.parse(questionRes.body);
  expect(parsedQuestion.data.sessionId).toBe(sessionId);
  expect(parsedQuestion.data.view.kind).toBe('question');

  // 5. Terminal stop via commitStop OR second notes/runTurn for completed
  let receipt2: ReceiptRef | undefined;
  let latestRead = turn1.nextView.read;
  const stopDetail = `Terminal execution probe (${mode})`;
  if (mode === 'completed') {
    fakeModel.setQueuedResponses([makeAnswerResponse('call_step2', 'Step 2 host note')]);
    const turn2 = await runner.runTurn(signal);
    expect(turn2.kind).toBe('advanced');
    if (turn2.kind !== 'advanced') throw new Error('Expected completed advancement');
    expect(turn2.nextView.kind).toBe('finished');
    receipt2 = turn2.receipt;
    latestRead = turn2.nextView.read;
  } else {
    const ports = scheduler.bindDiagnosticPorts(enrollment);
    const stopped = await ports.journal.commitStop(owner, mode, stopDetail, signal);
    expect(stopped).toEqual({ kind: 'stopped', execution: enrollment.execution });
  }

  // 6. Enroll second genuine host session to probe wrong-selector refusal
  const beforeSecondEnroll = await f.listSessionDirs();
  const secondEnroll = await scheduler.enroll(
    { workflowId: 'two-step-test', goal: `Second session selector probe (${mode})`, workspacePath: f.root },
    signal
  );
  expect(secondEnroll.kind).toBe('enrolled');
  if (secondEnroll.kind !== 'enrolled') throw new Error("Required candidate setup failed");
  const secondSessionId = await f.discoverNewSessionId(beforeSecondEnroll);

  // 7. Verification snapshots around all subsequent GET operations
  const snapJournal = await f.snapshotJournal();
  const snapPins = await f.snapshotPins();
  const expectedModelCalls = mode === 'completed' ? 2 : 1;
  expect(fakeModel.callCount).toBe(expectedModelCalls);

  // 8. Wrong-selector refusal must 403 invalid_scope with no protected data content
  const wrongScopeRes = await scopedGet(`/api/v2/sessions/${encodeURIComponent(secondSessionId)}/answer`);
  expect(wrongScopeRes.status).toBe(403);
  assertNoReply(wrongScopeRes.body);
  expect(wrongScopeRes.body).not.toHaveProperty('data');
  const parsedWrongScope = scopedRefusalSchema.parse(wrongScopeRes.body);
  expect(parsedWrongScope.outcome.sessionId).toBe(secondSessionId);
  expect(parsedWrongScope.outcome.reason).toBe('invalid_scope');

  const wrongReceipt = await scopedGet(`/api/v2/sessions/${encodeURIComponent(secondSessionId)}/answer/receipts/${encodeURIComponent(receipt1)}`);
  expect(wrongReceipt.status).toBe(403);
  assertNoReply(wrongReceipt.body);
  expect(wrongReceipt.body).toEqual({
    success: false, error: expect.any(String),
    outcome: { kind: 'refused', sessionId: secondSessionId, receipt: receipt1, reason: 'invalid_scope' },
  });

  // 9. Pair rightful GET 200 showing finished view with expected execution and retained receipts
  const finishedRes = await scopedGet(`/api/v2/sessions/${encodeURIComponent(sessionId)}/answer`);
  expect(finishedRes.status).toBe(200);
  assertNoReply(finishedRes.body);
  const parsedFinished = finishedResponseSchema.parse(finishedRes.body);
  expect(parsedFinished.data.sessionId).toBe(sessionId);
  expect(parsedFinished.data.view.kind).toBe('finished');
  expect(parsedFinished.data.view.taskOutcome).toBe('unknown');

  if (mode === 'completed') {
    expect(parsedFinished.data.view.execution).toEqual({ kind: 'completed' });
    expect(parsedFinished.data.view.retained.map(r => r.receipt)).toEqual([receipt1, receipt2!]);
  } else {
    expect(parsedFinished.data.view.execution).toEqual({ kind: 'incomplete', reason: mode, detail: stopDetail });
    expect(parsedFinished.data.view.retained.map(r => r.receipt)).toEqual([receipt1]);
  }

  // 10. Real HTTP receipt read complete accepted payload
  const resReceipt1 = await scopedGet(`/api/v2/sessions/${encodeURIComponent(sessionId)}/answer/receipts/${encodeURIComponent(receipt1)}`);
  expect(resReceipt1.status).toBe(200);
  assertNoReply(resReceipt1.body);
  const parsedReceipt1 = candidateReceiptResponseSchema.parse(resReceipt1.body);
  expect(parsedReceipt1.data.sessionId).toBe(sessionId);
  expect(parsedReceipt1.data.receipt).toBe(receipt1);
  expect(parsedReceipt1.data.page.receipt).toBe(receipt1);
  expect(parsedReceipt1.data.page.kind).toBe('complete');
  expect(parsedReceipt1.data.page.disposition).toBe('accepted');
  expect(JSON.parse(parsedReceipt1.data.page.chunk)).toEqual({ notes: 'Step 1 host note' });

  if (mode === 'completed') {
    const resReceipt2 = await scopedGet(`/api/v2/sessions/${encodeURIComponent(sessionId)}/answer/receipts/${encodeURIComponent(receipt2!)}`);
    expect(resReceipt2.status).toBe(200);
    assertNoReply(resReceipt2.body);
    const parsedReceipt2 = candidateReceiptResponseSchema.parse(resReceipt2.body);
    expect(parsedReceipt2.data.sessionId).toBe(sessionId);
    expect(parsedReceipt2.data.receipt).toBe(receipt2!);
    expect(parsedReceipt2.data.page.receipt).toBe(receipt2!);
    expect(parsedReceipt2.data.page.kind).toBe('complete');
    expect(parsedReceipt2.data.page.disposition).toBe('accepted');
    expect(JSON.parse(parsedReceipt2.data.page.chunk)).toEqual({ notes: 'Step 2 host note' });
  }

  // 11. Real session store verification via diagnostic ports
  const ports = scheduler.bindDiagnosticPorts(enrollment);
  await verifyReceiptChunk(ports, latestRead, receipt1, 'Step 1 host note', signal);
  if (mode === 'completed') {
    await verifyReceiptChunk(ports, latestRead, receipt2!, 'Step 2 host note', signal);
  }

  // 12. Storage invariant assertions around all GETs
  expect(await f.snapshotJournal()).toEqual(snapJournal);
  expect(await f.snapshotPins()).toEqual(snapPins);
  expect(fakeModel.callCount).toBe(expectedModelCalls);
}));

class OneShotJournalFaultSeam implements DurableJournalFaultSeam {
  public targetBoundary?: JournalFaultBoundary;
  public firedCount = 0;
  public interceptedExecution?: ExecutionRef;

  async intercept(
    boundary: JournalFaultBoundary,
    execution: ExecutionRef,
    _signal: AbortSignal,
  ): Promise<JournalFaultAction> {
    if (this.targetBoundary && boundary === this.targetBoundary && this.firedCount === 0) {
      this.firedCount++;
      this.interceptedExecution = execution;
      return { kind: 'simulate_uncertain', message: `Simulated uncertain acknowledgement at ${boundary}` };
    }
    return { kind: 'proceed' };
  }

  arm(boundary: JournalFaultBoundary): void {
    this.targetBoundary = boundary;
  }

  disarm(): void {
    this.targetBoundary = undefined;
  }
}

const lostAckFinishedResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    sessionId: z.string(),
    view: z.object({
      kind: z.literal('finished'),
      read: z.string(),
      retained: z.array(z.object({ receipt: z.string(), description: z.string() }).strict()),
      execution: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('completed') }).strict(),
        z.object({ kind: z.literal('incomplete'), reason: z.enum(['cancelled', 'timeout', 'failed']), detail: z.string() }).strict(),
      ]),
      taskOutcome: z.literal('unknown'),
    }).strict(),
  }).strict(),
}).strict();

it.each([
  {
    boundary: 'after_engine_commit' as const,
    label: 'after_engine_commit lost ack on final second turn',
  },
  {
    boundary: 'after_stop_commit' as const,
    label: 'after_stop_commit lost ack on cancellation',
  },
])('lost ack resilience ($boundary): $label verifies durable finished console state and clean recovery', ({ boundary }) => consoleHostFixture(async f => {
  const createAnswerHost = await f.loadFactory();
  const createConsoleReadRuntime = await f.loadConsoleFactory();
  const fakeModel = new FakeTestModelBoundary();
  const faultSeam = new OneShotJournalFaultSeam();
  const signal = new AbortController().signal;

  const hostResult = await createAnswerHost({ ...f.sharedAuthorityConfig, model: fakeModel, faultSeam }, signal);
  if (hostResult.kind === 'created') f.trackHost(hostResult.scheduler);
  expect(hostResult.kind).toBe('created');
  if (hostResult.kind !== 'created') throw new Error('Required candidate host setup failed');
  const scheduler = hostResult.scheduler;

  // 1. Enroll host session
  const workRequest: HostWorkRequest = {
    workflowId: 'two-step-test',
    goal: `Lost ack resilience probe (${boundary})`,
    workspacePath: f.root,
  };
  const beforeEnroll = await f.listSessionDirs();
  const enrollResult = await scheduler.enroll(workRequest, signal);
  expect(enrollResult.kind).toBe('enrolled');
  if (enrollResult.kind !== 'enrolled') throw new Error('Required candidate enrollment failed');
  const { runner, initialView, enrollment, owner } = enrollResult;
  expect(initialView.kind).toBe('question');
  const sessionId = await f.discoverNewSessionId(beforeEnroll);

  // 2. Host accepts notes step 1 -> actual receipt1, pending step 2
  fakeModel.setQueuedResponses([makeAnswerResponse('call_step1', 'Step 1 host note')]);
  const turn1 = await runner.runTurn(signal);
  expect(turn1.kind).toBe('advanced');
  if (turn1.kind !== 'advanced') throw new Error('Expected first turn advancement');
  expect(turn1.nextView.kind).toBe('question');
  const receipt1 = turn1.receipt;
  expect(fakeModel.callCount).toBe(1);

  // 3. Construct console runtime and bind scoped reader
  const consoleRuntimeResult = await createConsoleReadRuntime(f.sharedAuthorityConfig, signal);
  if (consoleRuntimeResult.kind === 'created') f.trackReadRuntime(consoleRuntimeResult.runtime);
  expect(consoleRuntimeResult.kind).toBe('created');
  if (consoleRuntimeResult.kind !== 'created') throw new Error('Required candidate console runtime failed');
  const consoleRuntime = consoleRuntimeResult.runtime;

  const bindResult = await consoleRuntime.bindHost(enrollment, signal);
  expect(bindResult.kind).toBe('bound');
  if (bindResult.kind !== 'bound') throw new Error('Required candidate reader bind failed');
  const reader = bindResult.reader;
  expect(reader.boundSessionId).toBe(sessionId);
  const scopedGet = await f.mountScopedReader(reader);

  // 4. Arm one-shot seam after first notes accepted and reader constructed
  faultSeam.arm(boundary);

  // 5. Trigger terminal boundary with simulated lost acknowledgement
  const stopDetail = `Lost ack cancellation probe (${boundary})`;
  if (boundary === 'after_engine_commit') {
    fakeModel.setQueuedResponses([makeAnswerResponse('call_step2', 'Step 2 host note')]);
    const turn2 = await runner.runTurn(signal);
    expect(turn2.kind).toBe('unconfirmed');
    if (turn2.kind !== 'unconfirmed') throw new Error('Expected unconfirmed turn outcome');
    expect(turn2.uncertainty.stage).toBe('commit_or_dispatch');
  } else {
    const ports = scheduler.bindDiagnosticPorts(enrollment);
    const stopped = await ports.journal.commitStop(owner, 'cancelled', stopDetail, signal);
    expect(stopped.kind).toBe('unconfirmed');
    if (stopped.kind !== 'unconfirmed') throw new Error('Expected unconfirmed stop outcome');
    expect(stopped.reason).toBe('commit_uncertain');
  }
  expect(faultSeam.firedCount).toBe(1);
  expect(faultSeam.interceptedExecution).toBe(enrollment.execution);

  // 6. Readonly safety snapshot around reads only
  const snapJournal = await f.snapshotJournal();
  const snapPins = await f.snapshotPins();
  const expectedModelCalls = boundary === 'after_engine_commit' ? 2 : 1;
  expect(fakeModel.callCount).toBe(expectedModelCalls);

  // 7. GET finished view over scoped console reflects actual durable finished state
  const finishedRes = await scopedGet(`/api/v2/sessions/${encodeURIComponent(sessionId)}/answer`);
  expect(finishedRes.status).toBe(200);
  assertNoReply(finishedRes.body);
  const parsedFinished = lostAckFinishedResponseSchema.parse(finishedRes.body);
  expect(parsedFinished.data.sessionId).toBe(sessionId);
  expect(parsedFinished.data.view.kind).toBe('finished');
  expect(parsedFinished.data.view.taskOutcome).toBe('unknown');

  let receipt2: string | undefined;
  if (boundary === 'after_engine_commit') {
    expect(parsedFinished.data.view.execution).toEqual({ kind: 'completed' });
    expect(parsedFinished.data.view.retained).toHaveLength(2);
    expect(parsedFinished.data.view.retained[0]!.receipt).toBe(receipt1);
    receipt2 = parsedFinished.data.view.retained[1]!.receipt;
    expect(receipt2).not.toBe(receipt1);
  } else {
    expect(parsedFinished.data.view.execution).toEqual({
      kind: 'incomplete',
      reason: 'cancelled',
      detail: stopDetail,
    });
    expect(parsedFinished.data.view.retained.map(r => r.receipt)).toEqual([receipt1]);
  }

  // 8. Verify exact retained receipts and payloads
  const resReceipt1 = await scopedGet(`/api/v2/sessions/${encodeURIComponent(sessionId)}/answer/receipts/${encodeURIComponent(receipt1)}`);
  expect(resReceipt1.status).toBe(200);
  assertNoReply(resReceipt1.body);
  const parsedReceipt1 = candidateReceiptResponseSchema.parse(resReceipt1.body);
  expect(parsedReceipt1.data.sessionId).toBe(sessionId);
  expect(parsedReceipt1.data.receipt).toBe(receipt1);
  expect(parsedReceipt1.data.page.receipt).toBe(receipt1);
  expect(parsedReceipt1.data.page.kind).toBe('complete');
  expect(parsedReceipt1.data.page.disposition).toBe('accepted');
  expect(JSON.parse(parsedReceipt1.data.page.chunk)).toEqual({ notes: 'Step 1 host note' });

  if (boundary === 'after_engine_commit') {
    const resReceipt2 = await scopedGet(`/api/v2/sessions/${encodeURIComponent(sessionId)}/answer/receipts/${encodeURIComponent(receipt2!)}`);
    expect(resReceipt2.status).toBe(200);
    assertNoReply(resReceipt2.body);
    const parsedReceipt2 = candidateReceiptResponseSchema.parse(resReceipt2.body);
    expect(parsedReceipt2.data.sessionId).toBe(sessionId);
    expect(parsedReceipt2.data.receipt).toBe(receipt2!);
    expect(parsedReceipt2.data.page.receipt).toBe(receipt2!);
    expect(parsedReceipt2.data.page.kind).toBe('complete');
    expect(parsedReceipt2.data.page.disposition).toBe('accepted');
    expect(JSON.parse(parsedReceipt2.data.page.chunk)).toEqual({ notes: 'Step 2 host note' });
  }

  // Repeated read verification & snapshot immutability
  const repeatFinished = await scopedGet(`/api/v2/sessions/${encodeURIComponent(sessionId)}/answer`);
  expect(repeatFinished.status).toBe(200);
  expect(repeatFinished.body).toEqual(finishedRes.body);
  expect(await f.snapshotJournal()).toEqual(snapJournal);
  expect(await f.snapshotPins()).toEqual(snapPins);
  expect(fakeModel.callCount).toBe(expectedModelCalls);

  // 9. Clear seam and recover via dehydrated pointer
  faultSeam.disarm();
  const pointer = scheduler.hydrator.dehydrate(enrollment);
  const recoverResult = await scheduler.recover(pointer, signal);
  expect(fakeModel.callCount).toBe(expectedModelCalls);

  if (boundary === 'after_engine_commit') {
    expect(recoverResult.kind).toBe('settled');
    if (recoverResult.kind !== 'settled') throw new Error('Expected settled recovery outcome');
    expect(recoverResult.receipt).toBe(receipt2!);
    expect(recoverResult.view.kind).toBe('finished');
    expect(recoverResult.view).toEqual(parsedFinished.data.view);
  } else {
    expect(recoverResult.kind).toBe('stopped');
    if (recoverResult.kind !== 'stopped') throw new Error('Expected stopped recovery outcome');
    expect(recoverResult.execution).toBe(enrollment.execution);
    expect(recoverResult.reason).toBe('cancelled');
    expect(recoverResult.detail).toBe(stopDetail);
  }

  const afterRecoveryJournal = await f.snapshotJournal();
  const afterRecoveryPins = await f.snapshotPins();
  // 10. Post-recovery GET equals prior finished body
  const postRecoverRes = await scopedGet(`/api/v2/sessions/${encodeURIComponent(sessionId)}/answer`);
  expect(postRecoverRes.status).toBe(200);
  assertNoReply(postRecoverRes.body);
  expect(postRecoverRes.body).toEqual(finishedRes.body);

  expect(await f.snapshotJournal()).toEqual(afterRecoveryJournal);
  expect(await f.snapshotPins()).toEqual(afterRecoveryPins);
  expect(fakeModel.callCount).toBe(expectedModelCalls);

  // 11. Canonical session store inspection: exact contributions remain once
  const sessionResult = await f.ctx.v2.sessionStore.load(sessionId);
  expect(sessionResult.isOk()).toBe(true);
  if (!sessionResult.isOk()) throw new Error(`Failed to load canonical session: ${sessionId}`);
  const noteOutputs: string[] = [];
  for (const event of sessionResult.value.events) {
    if (event.kind === 'node_output_appended') {
      if (event.data.payload.payloadKind === 'notes') {
        noteOutputs.push(event.data.payload.notesMarkdown);
      }
    }
  }
  expect(noteOutputs).toEqual(
    boundary === 'after_engine_commit' ? ['Step 1 host note', 'Step 2 host note'] : ['Step 1 host note'],
  );
}));

const DISCOVERY_MODULE_PATH = 'src/answer-v1/discovery.ts';

async function loadDiscoveryFactory(): Promise<typeof import('./host-discovery-contract.js').createHostDiscovery> {
  const absPath = resolve(process.cwd(), DISCOVERY_MODULE_PATH);
  try {
    await stat(absPath);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      expect.fail(`runtime_unavailable: ${DISCOVERY_MODULE_PATH} (module file does not exist at ${absPath})`);
    }
    throw err;
  }
  let mod: { createHostDiscovery?: typeof import('./host-discovery-contract.js').createHostDiscovery };
  try {
    mod = await import(/* @vite-ignore */ absPath);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.stack ?? err.message : String(err);
    expect.fail(`runtime_error: ${DISCOVERY_MODULE_PATH} (${detail})`);
  }
  if (!mod || typeof mod.createHostDiscovery !== 'function') {
    expect.fail(`runtime_error: ${DISCOVERY_MODULE_PATH} (missing createHostDiscovery export)`);
  }
  return mod.createHostDiscovery;
}

it('host discovery: unindexed journal recovery with active and released sessions', () => consoleHostFixture(async f => {
  const createAnswerHost = await f.loadFactory();
  const fakeModel = new FakeTestModelBoundary();
  const signal = new AbortController().signal;

  const hostResult = await createAnswerHost({ ...f.sharedAuthorityConfig, model: fakeModel }, signal);
  expect(hostResult.kind).toBe('created');
  if (hostResult.kind !== 'created') throw new Error('Expected created host scheduler');
  const scheduler = hostResult.scheduler;
  f.trackHost(scheduler);

  // 1. Enroll session 1: accepts first note, pending second, then releases ownership
  const dirsBefore1 = await f.listSessionDirs();
  const enrollResult1 = await scheduler.enroll(
    { workflowId: 'two-step-test', goal: 'Discovery probe released session', workspacePath: f.root },
    signal,
  );
  expect(enrollResult1.kind).toBe('enrolled');
  if (enrollResult1.kind !== 'enrolled') throw new Error('Expected session 1 enrolled');
  const sessionId1 = await f.discoverNewSessionId(dirsBefore1);
  const pointer1 = scheduler.hydrator.dehydrate(enrollResult1.enrollment);

  fakeModel.setQueuedResponses([makeAnswerResponse('call_step1', 'Step 1 host note')]);
  const turn1 = await enrollResult1.runner.runTurn(signal);
  expect(turn1.kind).toBe('advanced');
  if (turn1.kind !== 'advanced') throw new Error('Expected turn 1 advanced');
  expect(turn1.nextView.kind).toBe('question');
  const receipt1 = turn1.receipt;
  expect(fakeModel.callCount).toBe(1);

  const releaseResult = await scheduler.releaseOwnership(enrollResult1.enrollment, enrollResult1.owner, signal);
  expect(releaseResult.kind).toBe('released');
  if (releaseResult.kind !== 'released') throw new Error('Expected session 1 ownership released');

  // 2. Enroll session 2: stays active with its own owner and no notes
  const dirsBefore2 = await f.listSessionDirs();
  const enrollResult2 = await scheduler.enroll(
    { workflowId: 'two-step-test', goal: 'Discovery probe active session', workspacePath: f.root },
    signal,
  );
  expect(enrollResult2.kind).toBe('enrolled');
  if (enrollResult2.kind !== 'enrolled') throw new Error('Expected session 2 enrolled');
  const sessionId2 = await f.discoverNewSessionId(dirsBefore2);
  const pointer2 = scheduler.hydrator.dehydrate(enrollResult2.enrollment);
  expect(fakeModel.callCount).toBe(1);

  // 3. Remove non-authoritative host index cache only; verify absence
  await rm(f.storageConfig.hostIndexRootDir, { recursive: true, force: true });
  await expect(stat(f.storageConfig.hostIndexRootDir)).rejects.toMatchObject({ code: 'ENOENT' });

  // 5. Pre-discovery safety snapshots
  const snapJournalBefore = await f.snapshotJournal();
  const snapPinsBefore = await f.snapshotPins();
  const modelCallsBefore = fakeModel.callCount;

  // 6. Instantiate scanner, track immediately, and paginate to completion
  const createHostDiscovery = await loadDiscoveryFactory();
  const discoveryResult = await createHostDiscovery(f.sharedAuthorityConfig, signal);
  expect(discoveryResult.kind).toBe('created');
  if (discoveryResult.kind !== 'created') throw new Error('Expected created host discovery');
  const scanner = discoveryResult.scanner;
  f.trackReadRuntime(scanner);

  let cursor: HostDiscoveryCursor | undefined = undefined;
  const entries: DiscoveredSessionEntry[] = [];
  const seenIds = new Set<string>();
  let pages = 0;
  let ended = false;
  let firstPage: HostScanResult | undefined;
  while (pages < 10) {
    pages++;
    const scanResult = await scanner.scan(cursor, signal);
    expect(scanResult.kind).toBe('page');
    if (scanResult.kind !== 'page') throw new Error('Expected scan page result');
    if (pages === 1) firstPage = scanResult;
    const page = scanResult.page;
    expect(page.entries.length).toBeLessThanOrEqual(64);
    if (page.kind === 'more') expect(page.entries.length).toBeGreaterThan(0);
    for (const entry of page.entries) {
      expect(seenIds.has(entry.sessionId), `Duplicate session ${entry.sessionId}`).toBe(false);
      seenIds.add(entry.sessionId);
      entries.push(entry);
    }
    if (page.kind === 'end') { ended = true; break; }
    cursor = page.nextCursor;
  }
  expect(ended, "Discovery must reach an explicit end within the fixture bound").toBe(true);

  // 7. Repeated page 0 scan verification
  const repeatPage0 = await scanner.scan(undefined, signal);
  expect(repeatPage0.kind).toBe('page');
  if (repeatPage0.kind !== 'page' || firstPage?.kind !== 'page') throw new Error('Expected repeatable first page');
  expect(repeatPage0.page.kind).toBe(firstPage.page.kind);
  expect(repeatPage0.page.entries).toEqual(firstPage.page.entries);

  // 8. Invariant verification: no writes, no inference, index remains absent, active owner untouched
  expect(await f.snapshotJournal()).toEqual(snapJournalBefore);
  expect(await f.snapshotPins()).toEqual(snapPinsBefore);
  expect(fakeModel.callCount).toBe(modelCallsBefore);
  await expect(stat(f.storageConfig.hostIndexRootDir)).rejects.toMatchObject({ code: 'ENOENT' });
  // 9. Verify discovered entries, authentic pointers, and zero execution authority
  expect(entries).toHaveLength(2);
  const hostEntries = entries.filter((e): e is DiscoveredHostSession => e.kind === 'host');
  expect(hostEntries).toHaveLength(2);
  const entry1 = hostEntries.find(e => e.sessionId === sessionId1);
  const entry2 = hostEntries.find(e => e.sessionId === sessionId2);
  if (!entry1 || !entry2) throw new Error('Discovered entries missing expected sessions');
  expect(entry1).toEqual({ kind: 'host', sessionId: sessionId1, pointer: pointer1 });
  expect(entry2).toEqual({ kind: 'host', sessionId: sessionId2, pointer: pointer2 });
  for (const entry of hostEntries) {
    for (const key of ['owner', 'fence', 'runner', 'reply', 'attempt'] as const) {
      expect(key in entry, `Entry must not carry ${key} authority`).toBe(false);
    }
  }

  // 10. Recover ONLY released session 1 via discovered pointer and complete step 2
  const recoverResult = await scheduler.recover(entry1.pointer, signal);
  expect(fakeModel.callCount).toBe(modelCallsBefore);
  expect(recoverResult.kind).toBe('ready');
  if (recoverResult.kind !== 'ready') throw new Error('Expected session 1 ready recovery');

  fakeModel.setQueuedResponses([makeAnswerResponse('call_step2', 'Step 2 host note')]);
  const turn2 = await recoverResult.runner.runTurn(signal);
  expect(turn2.kind).toBe('advanced');
  if (turn2.kind !== 'advanced') throw new Error('Expected turn 2 advanced');
  expect(turn2.nextView.kind).toBe('finished');
  if (turn2.nextView.kind !== 'finished') throw new Error('Expected finished view');
  expect(turn2.nextView.execution.kind).toBe('completed');
  expect(fakeModel.callCount).toBe(2);

  // 11. Read receipts via diagnostic ports and inspect canonical session events
  const recoveredPorts = scheduler.bindDiagnosticPorts(recoverResult.enrollment);
  await verifyReceiptChunk(recoveredPorts, turn2.nextView.read, receipt1, 'Step 1 host note', signal);
  await verifyReceiptChunk(recoveredPorts, turn2.nextView.read, turn2.receipt, 'Step 2 host note', signal);

  const sessionResult = await f.ctx.v2.sessionStore.load(sessionId1);
  expect(sessionResult.isOk()).toBe(true);
  if (!sessionResult.isOk()) throw new Error(`Failed to load session ${sessionId1}`);
  const notes: string[] = [];
  for (const event of sessionResult.value.events) {
    if (event.kind === 'node_output_appended' && event.data.payload.payloadKind === 'notes') {
      notes.push(event.data.payload.notesMarkdown);
    }
  }
  expect(notes).toEqual(['Step 1 host note', 'Step 2 host note']);

  // The original active runner remains usable; discovery never acquired its owner.
  fakeModel.setQueuedResponses([makeAnswerResponse('active_first', 'Active session observation')]);
  const activeTurn = await enrollResult2.runner.runTurn(signal);
  expect(activeTurn.kind).toBe('advanced');
  if (activeTurn.kind !== 'advanced') throw new Error('Discovery or recovery displaced the unrelated owner');
  expect(activeTurn.nextView.kind).toBe('question');
  expect(fakeModel.callCount).toBe(3);
  await verifyReceiptChunk(scheduler.bindDiagnosticPorts(enrollResult2.enrollment),
    activeTurn.nextView.read, activeTurn.receipt, 'Active session observation', signal);
}));

it('host discovery pagination: bounded cursor traversal, foreign cursor refusal, and frozen enumeration across 65 host sessions', () => consoleHostFixture(async f => {
  const createAnswerHost = await f.loadFactory();
  const fakeModel = new FakeTestModelBoundary();
  const signal = new AbortController().signal;

  const hostResult = await createAnswerHost({ ...f.sharedAuthorityConfig, model: fakeModel }, signal);
  if (hostResult.kind === 'created') f.trackHost(hostResult.scheduler);
  expect(hostResult.kind).toBe('created');
  if (hostResult.kind !== 'created') throw new Error('Expected created host scheduler');
  const scheduler = hostResult.scheduler;

  // 1. Enroll 65 host sessions sequentially without model inference
  const expectedEntries: DiscoveredHostSession[] = [];
  let savedRunner: BoundTurnRunner | undefined;
  let savedEnrollment: HostEnrollment | undefined;

  for (let i = 0; i < 65; i++) {
    const dirsBefore = await f.listSessionDirs();
    const enrollResult = await scheduler.enroll(
      { workflowId: 'two-step-test', goal: `Pagination probe session ${i + 1}`, workspacePath: f.root },
      signal,
    );
    expect(enrollResult.kind).toBe('enrolled');
    if (enrollResult.kind !== 'enrolled') throw new Error(`Enrollment ${i + 1} failed: ${enrollResult.kind}`);
    expect(enrollResult.initialView.kind).toBe('question');

    if (i === 0) {
      savedRunner = enrollResult.runner;
      savedEnrollment = enrollResult.enrollment;
    }

    const sessionId = await f.discoverNewSessionId(dirsBefore);
    const pointer = scheduler.hydrator.dehydrate(enrollResult.enrollment);
    expectedEntries.push({ kind: 'host', sessionId, pointer });
  }
  expect(fakeModel.callCount).toBe(0);
  if (!savedRunner || !savedEnrollment) throw new Error('Missing saved first enrollment runner');

  const sorted65 = [...expectedEntries].sort((a, b) => a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0);

  // 2. Capture read-only baseline snapshots before discovery factories and scans
  const snapJournal65 = await f.snapshotJournal();
  const snapPins65 = await f.snapshotPins();
  expect(fakeModel.callCount).toBe(0);

  // 3. Construct scanners A and B on the same shared authority config and track immediately
  const createHostDiscovery = await loadDiscoveryFactory();

  const discoveryResultA = await createHostDiscovery(f.sharedAuthorityConfig, signal);
  if (discoveryResultA.kind === 'created') f.trackReadRuntime(discoveryResultA.scanner);
  expect(discoveryResultA.kind).toBe('created');
  if (discoveryResultA.kind !== 'created') throw new Error('Expected created scanner A');
  const scannerA: HostSessionScanner = discoveryResultA.scanner;

  const discoveryResultB = await createHostDiscovery(f.sharedAuthorityConfig, signal);
  if (discoveryResultB.kind === 'created') f.trackReadRuntime(discoveryResultB.scanner);
  expect(discoveryResultB.kind).toBe('created');
  if (discoveryResultB.kind !== 'created') throw new Error('Expected created scanner B');
  const scannerB: HostSessionScanner = discoveryResultB.scanner;

  // 4. Scanner A first scan must page.more with 1..64 entries and genuine cursorA
  const scanA1 = await scannerA.scan(undefined, signal);
  expect(scanA1.kind).toBe('page');
  if (scanA1.kind !== 'page') throw new Error('Expected scanA1 page');
  expect(scanA1.page.kind).toBe('more');
  if (scanA1.page.kind !== 'more') throw new Error('Expected scanA1 to have more pages');
  expect(scanA1.page.entries.length).toBeGreaterThanOrEqual(1);
  expect(scanA1.page.entries.length).toBeLessThanOrEqual(64);
  const cursorA = scanA1.page.nextCursor;

  // 5. Scanner B has its own bounded page and cursor; page occupancy is not fixed.
  const scanB1 = await scannerB.scan(undefined, signal);
  expect(scanB1.kind).toBe('page');
  if (scanB1.kind !== 'page') throw new Error('Expected scanB1 page');
  expect(scanB1.page.kind).toBe('more');
  if (scanB1.page.kind !== 'more') throw new Error('Expected scanB1 to have more pages');
  expect(scanB1.page.entries.length).toBeGreaterThan(0);
  expect(scanB1.page.entries.length).toBeLessThanOrEqual(64);
  const cursorB = scanB1.page.nextCursor;
  expect(cursorB).not.toBe(cursorA);

  // 6. Foreign cursor refusal: B.scan(cursorA) and A.scan(cursorB) refused invalid_cursor
  const scanBForeign = await scannerB.scan(cursorA, signal);
  expect(scanBForeign).toEqual({ kind: 'refused', reason: 'invalid_cursor', detail: expect.any(String) });
  if (scanBForeign.kind === 'refused') expect(scanBForeign.reason).toBe('invalid_cursor');
  expect(scanBForeign).not.toHaveProperty('page');
  expect(scanBForeign).not.toHaveProperty('entries');

  const scanAForeign = await scannerA.scan(cursorB, signal);
  expect(scanAForeign).toEqual({ kind: 'refused', reason: 'invalid_cursor', detail: expect.any(String) });
  if (scanAForeign.kind === 'refused') expect(scanAForeign.reason).toBe('invalid_cursor');
  expect(scanAForeign).not.toHaveProperty('page');
  expect(scanAForeign).not.toHaveProperty('entries');

  // Verify unchanged state before intentional 66th session enrollment
  expect(await f.snapshotJournal()).toEqual(snapJournal65);
  expect(await f.snapshotPins()).toEqual(snapPins65);
  expect(fakeModel.callCount).toBe(0);

  // 7. Enroll 66th host session AFTER first scans to probe frozen enumeration
  const dirsBefore66 = await f.listSessionDirs();
  const enrollResult66 = await scheduler.enroll(
    { workflowId: 'two-step-test', goal: 'Pagination probe session 66', workspacePath: f.root },
    signal,
  );
  expect(enrollResult66.kind).toBe('enrolled');
  if (enrollResult66.kind !== 'enrolled') throw new Error('Enrollment 66 failed');
  const session66Id = await f.discoverNewSessionId(dirsBefore66);
  const pointer66 = scheduler.hydrator.dehydrate(enrollResult66.enrollment);
  const entry66: DiscoveredHostSession = { kind: 'host', sessionId: session66Id, pointer: pointer66 };

  // New baseline reflecting the intentional write
  const snapJournal66 = await f.snapshotJournal();
  const snapPins66 = await f.snapshotPins();
  expect(fakeModel.callCount).toBe(0);

  // 8. Drain Scanner A to explicit end (<= 70 pages); verify frozen enumeration excludes session 66
  const entriesA: DiscoveredSessionEntry[] = [...scanA1.page.entries];
  let cursorAActive: HostDiscoveryCursor = cursorA;
  let pagesA = 1;
  let secondPageA: HostScanResult | undefined;
  let endedA = false;
  while (pagesA < 70) {
    pagesA++;
    const scanNext = await scannerA.scan(cursorAActive, signal);
    expect(scanNext.kind).toBe('page');
    if (scanNext.kind !== 'page') throw new Error(`Scanner A page ${pagesA} failed`);
    if (pagesA === 2) secondPageA = scanNext;
    const page = scanNext.page;
    expect(page.entries.length).toBeLessThanOrEqual(64);
    if (page.kind === 'more') {
      expect(page.entries.length).toBeGreaterThan(0);
      entriesA.push(...page.entries);
      cursorAActive = page.nextCursor;
    } else {
      entriesA.push(...page.entries);
      endedA = true;
      break;
    }
  }
  expect(endedA, 'Scanner A must reach explicit end within 70 pages').toBe(true);
  expect(entriesA).toHaveLength(65);
  expect(new Set(entriesA.map(e => e.sessionId)).size).toBe(65);
  expect(entriesA).toEqual(sorted65);
  expect(entriesA.some(e => e.sessionId === session66Id)).toBe(false);

  // Restart page 0 on Scanner A: verify frozen enumeration still holds and matches first page
  const restartA = await scannerA.scan(undefined, signal);
  expect(restartA.kind).toBe('page');
  if (restartA.kind !== 'page') throw new Error('Expected restarted page');
  expect(restartA.page.kind).toBe(scanA1.page.kind);
  expect(restartA.page.entries).toEqual(scanA1.page.entries);
  const replayCursorA = await scannerA.scan(cursorA, signal);
  expect(replayCursorA.kind).toBe('page');
  if (replayCursorA.kind !== 'page' || secondPageA?.kind !== 'page') throw new Error('Expected reusable cursor page');
  expect(replayCursorA.page.kind).toBe(secondPageA.page.kind);
  expect(replayCursorA.page.entries).toEqual(secondPageA.page.entries);

  // 9. Rightful cursorB still works after foreign refusal; drain Scanner B
  const entriesB: DiscoveredSessionEntry[] = [...scanB1.page.entries];
  let cursorBActive: HostDiscoveryCursor = cursorB;
  let pagesB = 1;
  let endedB = false;
  while (pagesB < 70) {
    pagesB++;
    const scanNextB = await scannerB.scan(cursorBActive, signal);
    expect(scanNextB.kind).toBe('page');
    if (scanNextB.kind !== 'page') throw new Error(`Scanner B page ${pagesB} failed`);
    const page = scanNextB.page;
    expect(page.entries.length).toBeLessThanOrEqual(64);
    if (page.kind === 'more') {
      expect(page.entries.length).toBeGreaterThan(0);
      entriesB.push(...page.entries);
      cursorBActive = page.nextCursor;
    } else {
      entriesB.push(...page.entries);
      endedB = true;
      break;
    }
  }
  expect(endedB, 'Scanner B must reach explicit end within 70 pages').toBe(true);
  expect(entriesB).toEqual(sorted65);

  // 10. Fresh Scanner C enumerates all 66 sessions including session 66
  const discoveryResultC = await createHostDiscovery(f.sharedAuthorityConfig, signal);
  if (discoveryResultC.kind === 'created') f.trackReadRuntime(discoveryResultC.scanner);
  expect(discoveryResultC.kind).toBe('created');
  if (discoveryResultC.kind !== 'created') throw new Error('Expected created scanner C');
  const scannerC: HostSessionScanner = discoveryResultC.scanner;

  const entriesC: DiscoveredSessionEntry[] = [];
  let cursorC: HostDiscoveryCursor | undefined = undefined;
  let pagesC = 0;
  let endedC = false;
  while (pagesC < 70) {
    pagesC++;
    const scanNextC = await scannerC.scan(cursorC, signal);
    expect(scanNextC.kind).toBe('page');
    if (scanNextC.kind !== 'page') throw new Error(`Scanner C page ${pagesC} failed`);
    const page = scanNextC.page;
    expect(page.entries.length).toBeLessThanOrEqual(64);
    if (page.kind === 'more') {
      expect(page.entries.length).toBeGreaterThan(0);
      entriesC.push(...page.entries);
      cursorC = page.nextCursor;
    } else {
      entriesC.push(...page.entries);
      endedC = true;
      break;
    }
  }
  expect(endedC, 'Scanner C must reach explicit end within 70 pages').toBe(true);
  expect(entriesC).toHaveLength(66);
  expect(entriesC.some(e => e.sessionId === session66Id)).toBe(true);
  const sorted66 = [...sorted65, entry66].sort((a, b) => a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0);
  expect(entriesC).toEqual(sorted66);
  for (const entry of [...entriesA, ...entriesB, ...entriesC]) {
    for (const key of ['owner', 'fence', 'runner', 'reply', 'attempt'] as const) {
      expect(key in entry, `Discovery entry cannot expose ${key}`).toBe(false);
    }
  }

  // Storage invariant verification: no rogue writes during scans, no model inference
  expect(await f.snapshotJournal()).toEqual(snapJournal66);
  expect(await f.snapshotPins()).toEqual(snapPins66);
  expect(fakeModel.callCount).toBe(0);

  // 11. Positive control: old active runner still functions with exactly 1 model call
  fakeModel.setQueuedResponses([makeAnswerResponse('call_step1_pagination', 'Step 1 host note after scans')]);
  const turn1 = await savedRunner.runTurn(signal);
  expect(turn1.kind).toBe('advanced');
  if (turn1.kind !== 'advanced') throw new Error(`Expected advancement, got ${turn1.kind}`);
  expect(turn1.nextView.kind).toBe('question');
  expect(fakeModel.callCount).toBe(1);

  const ports = scheduler.bindDiagnosticPorts(savedEnrollment);
  await verifyReceiptChunk(ports, turn1.nextView.read, turn1.receipt, 'Step 1 host note after scans', signal);
}), 60000);

const DISCOVERY_PAGE_LIMIT: typeof import('./host-discovery-contract.js').MAX_HOST_DISCOVERY_ENTRIES = 64;

interface ScanCollectionResult {
  entries: DiscoveredSessionEntry[];
  firstPageResult: HostScanResult;
}

async function collectAllDiscoveryPages(
  scanner: HostSessionScanner,
  initialCursor: HostDiscoveryCursor | undefined,
  signal: AbortSignal,
): Promise<ScanCollectionResult> {
  let cursor: HostDiscoveryCursor | undefined = initialCursor;
  const entries: DiscoveredSessionEntry[] = [];
  const seenIds = new Set<string>();
  let pages = 0;
  let ended = false;
  let firstPageResult: HostScanResult | undefined;

  while (pages < 10) {
    pages++;
    const scanResult = await scanner.scan(cursor, signal);
    if (pages === 1) {
      firstPageResult = scanResult;
    }
    expect(scanResult.kind).toBe('page');
    if (scanResult.kind !== 'page') {
      throw new Error(`Expected scan page result, got: ${scanResult.kind}`);
    }
    const page = scanResult.page;
    expect(page.entries.length).toBeLessThanOrEqual(DISCOVERY_PAGE_LIMIT);
    if (page.kind === 'more') {
      expect(page.entries.length).toBeGreaterThan(0);
    }
    for (const entry of page.entries) {
      expect(seenIds.has(entry.sessionId), `Duplicate session discovered: ${entry.sessionId}`).toBe(false);
      seenIds.add(entry.sessionId);
      entries.push(entry);
    }
    if (page.kind === 'end') {
      ended = true;
      break;
    }
    cursor = page.nextCursor;
  }

  expect(ended, 'Discovery scan must reach an explicit end within bounded pages (<= 10)').toBe(true);
  if (!ended || !firstPageResult) {
    throw new Error('Discovery scan failed to complete within page bound');
  }

  return { entries, firstPageResult };
}

async function locateCommittedSessionSegment(
  dataDir: LocalDataDirV2,
  root: string,
  sessionId: SessionId,
) {
  const manifestPath = dataDir.sessionManifestPath(sessionId);
  const manifestRaw = await readFile(manifestPath, 'utf8');
  const manifestRecords = manifestRaw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => ManifestRecordV1Schema.parse(JSON.parse(l)));
  const closedSegments = manifestRecords.filter(
    (r): r is Extract<ManifestRecordV1, { kind: 'segment_closed' }> => r.kind === 'segment_closed',
  );
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
  return { sessionId, manifestPath, manifestRaw, targetSeg, targetSegPath, closedSegments };
}

it.each([
  { mode: 'missing' as const, label: 'missing session directory' },
  { mode: 'corrupt' as const, label: 'corrupt segment byte digest mismatch' },
  { mode: 'unsupported_version' as const, label: 'unsupported schema version v=99' },
  { mode: 'storage_unavailable' as const, label: 'storage unavailable filesystem obstruction' },
])('host discovery fault isolation ($mode): $label', ({ mode }) => consoleHostFixture(async f => {
  const signal = new AbortController().signal;

  // Ordinary engine sessions have no answer-host enrollment.
  const legacySessionId = await seedLegacySession(f, mode);

  // 2. Create genuine unbound answers-profile session
  const answersMcp = await f.bootMcp('answers', { answerAuthority: f.sharedAuthorityConfig });
  const dirsBeforeUnbound = await f.listSessionDirs();
  const openRes = openedSchema.parse(
    await answersMcp.call('open_work', {
      workflowId: 'two-step-test',
      workspacePath: f.root,
      goal: `Unbound positive control session (${mode})`,
    }),
  );
  const unboundSessionId = await f.discoverNewSessionId(dirsBeforeUnbound);
  const unboundQ1 = question(openRes.view);
  const unboundStep1 = recordedSchema.parse(
    await answersMcp.call('answer_work', {
      reply: unboundQ1.reply,
      answer: { notes: `Unbound step 1 observation notes (${mode})` },
    }),
  );
  expect(unboundStep1.disposition).toBe('accepted');

  // 3. Create two actual host enrollments: healthy and fault target
  const createAnswerHost = await f.loadFactory();
  const fakeModel = new FakeTestModelBoundary();
  const hostResult = await createAnswerHost({ ...f.sharedAuthorityConfig, model: fakeModel }, signal);
  expect(hostResult.kind).toBe('created');
  if (hostResult.kind !== 'created') throw new Error('Expected created host scheduler');
  const scheduler = hostResult.scheduler;
  f.trackHost(scheduler);

  const dirsBeforeHealthy = await f.listSessionDirs();
  const healthyEnroll = await scheduler.enroll(
    { workflowId: 'two-step-test', goal: `Healthy host session (${mode})`, workspacePath: f.root },
    signal,
  );
  expect(healthyEnroll.kind).toBe('enrolled');
  if (healthyEnroll.kind !== 'enrolled') throw new Error('Expected healthy host enrolled');
  const healthySessionId = await f.discoverNewSessionId(dirsBeforeHealthy);
  const healthyPointer = scheduler.hydrator.dehydrate(healthyEnroll.enrollment);

  const dirsBeforeFault = await f.listSessionDirs();
  const faultEnroll = await scheduler.enroll(
    { workflowId: 'two-step-test', goal: `Fault target host session (${mode})`, workspacePath: f.root },
    signal,
  );
  expect(faultEnroll.kind).toBe('enrolled');
  if (faultEnroll.kind !== 'enrolled') throw new Error('Expected fault target host enrolled');
  const faultSessionId = await f.discoverNewSessionId(dirsBeforeFault);
  const faultPointer = scheduler.hydrator.dehydrate(faultEnroll.enrollment);

  const pristineJournal = await f.snapshotJournal();
  const pristinePins = await f.snapshotPins();
  expect(fakeModel.callCount).toBe(0);

  // 4. Baseline scan: all 4 bounded pages helper <= 10, freeze enumeration before fault
  const createHostDiscovery = await loadDiscoveryFactory();
  const discoveryResult = await createHostDiscovery(f.sharedAuthorityConfig, signal);
  expect(discoveryResult.kind).toBe('created');
  if (discoveryResult.kind !== 'created') throw new Error('Expected created host discovery');
  const scanner = discoveryResult.scanner;
  f.trackReadRuntime(scanner);

  const baselineScan = await collectAllDiscoveryPages(scanner, undefined, signal);
  expect(baselineScan.entries).toHaveLength(4);

  const baselineLegacy = baselineScan.entries.find(e => e.sessionId === legacySessionId);
  expect(baselineLegacy).toEqual({ kind: 'legacy', sessionId: legacySessionId });

  const baselineUnbound = baselineScan.entries.find(e => e.sessionId === unboundSessionId);
  expect(baselineUnbound).toEqual({ kind: 'unbound', sessionId: unboundSessionId });

  const baselineHealthy = baselineScan.entries.find(e => e.sessionId === healthySessionId);
  expect(baselineHealthy).toEqual({ kind: 'host', sessionId: healthySessionId, pointer: healthyPointer });

  const baselineFault = baselineScan.entries.find(e => e.sessionId === faultSessionId);
  expect(baselineFault).toEqual({ kind: 'host', sessionId: faultSessionId, pointer: faultPointer });

  for (const entry of baselineScan.entries) {
    for (const key of ['owner', 'fence', 'runner', 'reply', 'attempt'] as const) {
      expect(key in entry, `Baseline entry must not carry ${key} authority`).toBe(false);
    }
  }

  expect(await f.snapshotJournal()).toEqual(pristineJournal);
  expect(await f.snapshotPins()).toEqual(pristinePins);
  expect(fakeModel.callCount).toBe(0);

  // 5. Fault target mutation with restore installed BEFORE destructive operation
  const faultTargetDir = f.dataDir.sessionDir(faultSessionId);
  let restoreFault: (() => Promise<void>) | undefined;

  const pathExists = async (targetPath: string): Promise<boolean> => {
    try {
      await stat(targetPath);
      return true;
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
        return false;
      }
      throw err;
    }
  };

  try {
    if (mode === 'missing') {
      const backupDir = join(f.root, `private-backup-missing-${faultSessionId}`);
      expect(await pathExists(backupDir), 'Backup directory must not exist prior to rename').toBe(false);
      restoreFault = async () => {
        if (!(await pathExists(backupDir))) return;
        if (await pathExists(faultTargetDir)) throw new Error(`Unexpected recreated session path; preserve evidence: ${faultTargetDir}`);
        await rename(backupDir, faultTargetDir);
      };
      await rename(faultTargetDir, backupDir);
      expect(await pathExists(faultTargetDir)).toBe(false);
      // The low-level store intentionally returns empty for a missing manifest.
      // Discovery must preserve the known enumerated identity and report missing.
      const emptyLowLevel = await f.ctx.v2.sessionStore.load(faultSessionId);
      expect(emptyLowLevel.isOk()).toBe(true);
      if (!emptyLowLevel.isOk()) throw new Error('Expected low-level missing-manifest empty truth');
      expect(emptyLowLevel.value).toEqual({ manifest: [], events: [] });
    } else if (mode === 'storage_unavailable') {
      // Obstruct the committed file itself: an ancestor file can report ENOENT
      // on Windows and would exercise absence rather than a storage read failure.
      const { targetSegPath } = await locateCommittedSessionSegment(f.dataDir, f.root, faultSessionId);
      const backupSegment = join(f.root, `private-backup-obstruct-${faultSessionId}`);
      expect(await pathExists(backupSegment)).toBe(false);
      restoreFault = async () => {
        if (!(await pathExists(backupSegment))) return;
        if (await pathExists(targetSegPath)) {
          if (!(await stat(targetSegPath)).isDirectory() || (await readdir(targetSegPath)).length !== 0) {
            throw new Error('Refuse to remove unexpected segment obstruction');
          }
          await rm(targetSegPath, { recursive: true });
        }
        await rename(backupSegment, targetSegPath);
      };
      await rename(targetSegPath, backupSegment);
      await mkdir(targetSegPath);
      const obstructed = await f.ctx.v2.sessionStore.load(faultSessionId);
      expect(obstructed.isErr()).toBe(true);
      if (!obstructed.isErr()) throw new Error('Expected unreadable committed segment');
      expect(obstructed.error.code).toBe('SESSION_STORE_IO_ERROR');
    } else if (mode === 'corrupt') {
      const { manifestPath, manifestRaw, targetSegPath } = await locateCommittedSessionSegment(
        f.dataDir,
        f.root,
        faultSessionId,
      );
      const pristineSegBytes = Buffer.from(await readFile(targetSegPath));
      const pristineManifest = manifestRaw;

      restoreFault = async () => {
        await writeFile(targetSegPath, pristineSegBytes);
        await writeFile(manifestPath, pristineManifest);
      };

      const corruptBytes = Buffer.from(pristineSegBytes);
      corruptBytes[0] = corruptBytes[0]! ^ 0xff;
      await writeFile(targetSegPath, corruptBytes);

      const loadCorrupt = await f.ctx.v2.sessionStore.load(faultSessionId);
      expect(loadCorrupt.isErr()).toBe(true);
      if (loadCorrupt.isErr()) {
        expect(loadCorrupt.error.code).toBe('SESSION_STORE_CORRUPTION_DETECTED');
        if (loadCorrupt.error.code === 'SESSION_STORE_CORRUPTION_DETECTED') {
          expect(loadCorrupt.error.reason.code).toBe('digest_mismatch');
        }
      }
    } else if (mode === 'unsupported_version') {
      const { manifestPath, manifestRaw, targetSeg, targetSegPath } = await locateCommittedSessionSegment(
        f.dataDir,
        f.root,
        faultSessionId,
      );
      const pristineSegBytes = Buffer.from(await readFile(targetSegPath));
      const pristineManifest = manifestRaw;

      restoreFault = async () => {
        await writeFile(targetSegPath, pristineSegBytes);
        await writeFile(manifestPath, pristineManifest);
      };

      const segLines = pristineSegBytes.toString('utf8').trim().split('\n');
      const evtObj = JSON.parse(segLines[0]!);
      expect(evtObj.v).toBe(1);
      evtObj.v = 99;
      segLines[0] = JSON.stringify(evtObj);
      const verSegBytes = Buffer.from(segLines.join('\n') + '\n', 'utf8');
      await writeFile(targetSegPath, verSegBytes);

      const newHash = 'sha256:' + createHash('sha256').update(verSegBytes).digest('hex');
      const verManifest =
        pristineManifest
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(l => {
            const r = JSON.parse(l);
            if (r.kind === 'segment_closed' && r.segmentRelPath === targetSeg.segmentRelPath) {
              return JSON.stringify({ ...r, sha256: newHash, bytes: verSegBytes.length });
            }
            return l;
          })
          .join('\n') + '\n';
      await writeFile(manifestPath, verManifest);

      const loadVer = await f.ctx.v2.sessionStore.load(faultSessionId);
      expect(loadVer.isErr()).toBe(true);
      if (loadVer.isErr()) {
        expect(loadVer.error.code).toBe('SESSION_STORE_CORRUPTION_DETECTED');
        if (loadVer.error.code === 'SESSION_STORE_CORRUPTION_DETECTED') {
          expect(loadVer.error.reason.code).toBe('unknown_schema_version');
        }
      }
    }

    // 6. Snapshot journal/pins after fault before scans and compare after; no model calls
    const snapJournalAfterFault = await f.snapshotJournal();
    const snapPinsAfterFault = await f.snapshotPins();
    const modelCallsAfterFault = fakeModel.callCount;

    const faultScan = await collectAllDiscoveryPages(scanner, undefined, signal);
    expect(faultScan.entries).toHaveLength(4);

    const faultEntry = faultScan.entries.find(e => e.sessionId === faultSessionId);
    expect(faultEntry).toBeDefined();
    if (!faultEntry) throw new Error('Fault target session missing from scan');

    expect(faultEntry.kind).toBe('unavailable');
    if (faultEntry.kind === 'unavailable') {
      expect(faultEntry.reason).toBe(mode);
      expect(typeof faultEntry.detail).toBe('string');
      expect(faultEntry.detail.trim().length).toBeGreaterThan(0);
    }

    expect(Object.keys(faultEntry).sort()).toEqual(['detail', 'kind', 'reason', 'sessionId'].sort());
    for (const key of ['owner', 'fence', 'runner', 'reply', 'attempt', 'pointer'] as const) {
      expect(key in faultEntry, `Fault entry must not contain ${key}`).toBe(false);
    }

    const otherLegacy = faultScan.entries.find(e => e.sessionId === legacySessionId);
    expect(otherLegacy).toEqual(baselineLegacy);

    const otherUnbound = faultScan.entries.find(e => e.sessionId === unboundSessionId);
    expect(otherUnbound).toEqual(baselineUnbound);

    const otherHealthy = faultScan.entries.find(e => e.sessionId === healthySessionId);
    expect(otherHealthy).toEqual(baselineHealthy);

    expect(await f.snapshotJournal()).toEqual(snapJournalAfterFault);
    expect(await f.snapshotPins()).toEqual(snapPinsAfterFault);
    expect(modelCallsAfterFault).toBe(0);
    expect(fakeModel.callCount).toBe(0);
  } finally {
    if (restoreFault) {
      await restoreFault();
      restoreFault = undefined;
    }
  }

  expect(await f.snapshotJournal()).toEqual(pristineJournal);
  expect(await f.snapshotPins()).toEqual(pristinePins);

  // 7. On restore, scanner.scan(undefined) must report exact initial entries
  const restoredScan = await collectAllDiscoveryPages(scanner, undefined, signal);
  expect(restoredScan.entries).toEqual(baselineScan.entries);

  // Fresh scanner confirms same canonical entries
  const freshDiscoveryResult = await createHostDiscovery(f.sharedAuthorityConfig, signal);
  expect(freshDiscoveryResult.kind).toBe('created');
  if (freshDiscoveryResult.kind === 'created') {
    const freshScanner = freshDiscoveryResult.scanner;
    f.trackReadRuntime(freshScanner);
    const freshScan = await collectAllDiscoveryPages(freshScanner, undefined, signal);
    expect(freshScan.entries).toEqual(baselineScan.entries);
  }
  expect(await f.snapshotJournal()).toEqual(pristineJournal);
  expect(await f.snapshotPins()).toEqual(pristinePins);
  expect(fakeModel.callCount).toBe(0);
}), 30000);

async function discoveryPathPresent(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function seedLegacySession(f: ConsoleHostFixtureContext, label: string): Promise<SessionId> {
  const before = await f.listSessionDirs();
  const created = await createWorkRailEngine({ dataDir: f.root });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error('Could not create legacy fixture engine');
  try {
    const started = await created.value.startWorkflow('two-step-test', `Legacy observation (${label})`);
    expect(started.ok).toBe(true);
    if (!started.ok || started.value.kind !== 'ok') throw new Error('Could not start legacy fixture');
    const answered = await created.value.continueWorkflow(started.value.stateToken, started.value.ackToken,
      { notesMarkdown: `Legacy observation (${label})` });
    expect(answered.ok).toBe(true);
    return await f.discoverNewSessionId(before);
  } finally { await created.value.close(); }
}

it('host discovery lifecycle: pre-aborted create, pre-aborted scan, discovery, idempotent close, refused post-close, and fresh scanner continuity', async () => {
  await consoleHostFixture(async f => {
    const legacySessionId = await seedLegacySession(f, 'lifecycle');
    const createHostDiscovery = await loadDiscoveryFactory();
    const baselineKeyring = await readFile(f.sharedAuthorityConfig.keyringPath);
    const baselineJournal = await f.snapshotJournal();
    const baselinePins = await f.snapshotPins();

    const preAbortedCreate = await createHostDiscovery(f.sharedAuthorityConfig, AbortSignal.abort());
    expect(preAbortedCreate).toEqual({ kind: 'cancelled' });

    const created = await createHostDiscovery(f.sharedAuthorityConfig, AbortSignal.timeout(5000));
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') throw new Error('Expected discovery creation');
    const scanner = created.scanner;
    f.trackReadRuntime(scanner);

    const preAbortedScan = await scanner.scan(undefined, AbortSignal.abort());
    expect(preAbortedScan).toEqual({ kind: 'cancelled' });

    const normalScan = await scanner.scan(undefined, AbortSignal.timeout(5000));
    expect(normalScan.kind).toBe('page');
    if (normalScan.kind !== 'page') throw new Error('Expected discovery page');
    expect(normalScan.page).toEqual({ kind: 'end', entries: [{ kind: 'legacy', sessionId: legacySessionId }] });

    const close1 = await scanner.close(AbortSignal.timeout(5000));
    expect(close1).toEqual({ kind: 'closed' });
    const close2 = await scanner.close(AbortSignal.timeout(5000));
    expect(close2).toEqual({ kind: 'closed' });

    const postCloseScan = await scanner.scan(undefined, AbortSignal.timeout(5000));
    expect(postCloseScan).toEqual({ kind: 'refused', reason: 'scanner_closed', detail: expect.any(String) });

    const freshCreated = await createHostDiscovery(f.sharedAuthorityConfig, AbortSignal.timeout(5000));
    expect(freshCreated.kind).toBe('created');
    if (freshCreated.kind !== 'created') throw new Error('Expected fresh discovery creation');
    f.trackReadRuntime(freshCreated.scanner);

    const freshScan = await freshCreated.scanner.scan(undefined, AbortSignal.timeout(5000));
    expect(freshScan.kind).toBe('page');
    if (freshScan.kind !== 'page') throw new Error('Expected discovery page');
    expect(freshScan.page).toEqual({ kind: 'end', entries: [{ kind: 'legacy', sessionId: legacySessionId }] });
    expect(freshScan.page.entries).toEqual(normalScan.page.entries);

    expect(await readFile(f.sharedAuthorityConfig.keyringPath)).toEqual(baselineKeyring);
    expect(await f.snapshotJournal()).toEqual(baselineJournal);
    expect(await f.snapshotPins()).toEqual(baselinePins);
  });
});

it.each([
  { fault: 'missing', reason: 'missing' as const, placeFile: false },
  { fault: 'storage_unavailable', reason: 'storage_unavailable' as const, placeFile: true },
])('host discovery storage: root fault $fault before first scan returns $reason, recovers on safe restore, and distinguishes empty root', async ({ fault, reason, placeFile }) => {
  await consoleHostFixture(async f => {
    const legacySessionId = await seedLegacySession(f, `fault-${fault}`);
    const createHostDiscovery = await loadDiscoveryFactory();
    const baselineKeyring = await readFile(f.sharedAuthorityConfig.keyringPath);
    const baselineJournal = await f.snapshotJournal();
    const baselinePins = await f.snapshotPins();

    const created = await createHostDiscovery(f.sharedAuthorityConfig, AbortSignal.timeout(5000));
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') throw new Error('Expected discovery creation');
    const scanner = created.scanner;
    f.trackReadRuntime(scanner);

    const rootDir = f.storageConfig.journalRootDir;
    const backupDir = join(f.root, `sessions-backup-${fault}`);
    const ownedMarker = `workrail-owned-exact-file-${fault}`;
    // Restore only the private backup; never overwrite an unexpected recreated path.
    try {
      await rename(rootDir, backupDir);
      if (placeFile) await writeFile(rootDir, ownedMarker, { encoding: 'utf8', flag: 'wx' });
      const faultScan = await scanner.scan(undefined, AbortSignal.timeout(5000));
      expect(faultScan).toEqual({ kind: 'unavailable', reason, detail: expect.any(String) });
      if (placeFile) {
        expect((await lstat(rootDir)).isFile()).toBe(true);
        expect(await readFile(rootDir, 'utf8')).toBe(ownedMarker);
      } else {
        expect(await discoveryPathPresent(rootDir)).toBe(false);
      }
    } finally {
      if (await discoveryPathPresent(backupDir)) {
        if (await discoveryPathPresent(rootDir)) {
          if (!placeFile || !(await lstat(rootDir)).isFile() || await readFile(rootDir, 'utf8') !== ownedMarker) {
            throw new Error('Refuse to overwrite unexpected discovery root');
          }
          await rm(rootDir);
        }
        await rename(backupDir, rootDir);
      }
    }

    const recoveredScan = await scanner.scan(undefined, AbortSignal.timeout(5000));
    expect(recoveredScan.kind).toBe('page');
    if (recoveredScan.kind !== 'page') throw new Error('Expected discovery page');
    expect(recoveredScan.page).toEqual({ kind: 'end', entries: [{ kind: 'legacy', sessionId: legacySessionId }] });

    const closeRes = await scanner.close(AbortSignal.timeout(5000));
    expect(closeRes).toEqual({ kind: 'closed' });

    const emptyCanonicalRoot = join(f.root, `empty-canonical-${fault}`);
    await mkdir(emptyCanonicalRoot, { recursive: true });
    const emptyCreated = await createHostDiscovery(
      { ...f.sharedAuthorityConfig, storage: { ...f.storageConfig, journalRootDir: emptyCanonicalRoot } },
      AbortSignal.timeout(5000),
    );
    expect(emptyCreated.kind).toBe('created');
    if (emptyCreated.kind !== 'created') throw new Error('Expected empty-root discovery creation');
    f.trackReadRuntime(emptyCreated.scanner);

    const emptyScan = await emptyCreated.scanner.scan(undefined, AbortSignal.timeout(5000));
    expect(emptyScan).toEqual({ kind: 'page', page: { kind: 'end', entries: [] } });

    const emptyClose = await emptyCreated.scanner.close(AbortSignal.timeout(5000));
    expect(emptyClose).toEqual({ kind: 'closed' });
    expect(await readdir(emptyCanonicalRoot)).toEqual([]);

    expect(await readFile(f.sharedAuthorityConfig.keyringPath)).toEqual(baselineKeyring);
    expect(await f.snapshotJournal()).toEqual(baselineJournal);
    expect(await f.snapshotPins()).toEqual(baselinePins);
  });
});

it('host discovery storage: factory refuses missing_authority when configured keyring is missing, does not generate replacement, and recovers upon safe restore', async () => {
  await consoleHostFixture(async f => {
    const legacySessionId = await seedLegacySession(f, 'keyring-refusal');
    const createHostDiscovery = await loadDiscoveryFactory();
    const baselineKeyring = await readFile(f.sharedAuthorityConfig.keyringPath);
    const baselineJournal = await f.snapshotJournal();
    const baselinePins = await f.snapshotPins();

    const keyringPath = f.sharedAuthorityConfig.keyringPath;
    const backupKeyringPath = join(f.root, 'keyring-authority-backup.json');
    try {
      await rename(keyringPath, backupKeyringPath);
      const refused = await createHostDiscovery(f.sharedAuthorityConfig, AbortSignal.timeout(5000));
      expect(refused).toEqual({ kind: 'refused', reason: 'missing_authority', detail: expect.any(String) });

      expect(await discoveryPathPresent(keyringPath), 'Keyring must not be regenerated').toBe(false);
    } finally {
      if (await discoveryPathPresent(backupKeyringPath)) {
        if (await discoveryPathPresent(keyringPath)) throw new Error('Refuse to overwrite recreated authority');
        await rename(backupKeyringPath, keyringPath);
      }
    }

    const created = await createHostDiscovery(f.sharedAuthorityConfig, AbortSignal.timeout(5000));
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') throw new Error('Expected discovery creation');
    f.trackReadRuntime(created.scanner);

    const scanRes = await created.scanner.scan(undefined, AbortSignal.timeout(5000));
    expect(scanRes.kind).toBe('page');
    if (scanRes.kind !== 'page') throw new Error('Expected discovery page');
    expect(scanRes.page).toEqual({ kind: 'end', entries: [{ kind: 'legacy', sessionId: legacySessionId }] });

    const closeRes = await created.scanner.close(AbortSignal.timeout(5000));
    expect(closeRes).toEqual({ kind: 'closed' });

    expect(await readFile(keyringPath)).toEqual(baselineKeyring);
    expect(await f.snapshotJournal()).toEqual(baselineJournal);
    expect(await f.snapshotPins()).toEqual(baselinePins);
  });
});

it('automatic recovery admission: concurrent claims, busy non-interference, and terminal states', () => consoleHostFixture(async f => {
  const signal = AbortSignal.timeout(15_000);
  const fakeModel = new FakeTestModelBoundary();
  const createAnswerHost = await f.loadFactory();

  async function trackedHost() {
    const result = await createAnswerHost({ ...f.sharedAuthorityConfig, model: fakeModel }, signal);
    if (result.kind !== 'created') throw new Error('Expected created host');
    f.trackHost(result.scheduler);
    return result.scheduler;
  }
  const ownerHost = await trackedHost();
  const c1Host = await trackedHost();
  const c2Host = await trackedHost();

  const dirs0 = await f.listSessionDirs();
  const enrollA = await ownerHost.enroll({ workflowId: 'two-step-test', goal: 'A', workspacePath: f.root }, signal);
  expect(enrollA.kind).toBe('enrolled'); if (enrollA.kind !== 'enrolled') throw new Error('enroll A failed');
  const idA = await f.discoverNewSessionId(dirs0);
  fakeModel.setQueuedResponses([makeAnswerResponse('call_a1', 'Note A1')]);
  const turnA1 = await enrollA.runner.runTurn(signal);
  expect(turnA1.kind).toBe('advanced'); if (turnA1.kind !== 'advanced') throw new Error('turn A1 failed');
  expect(fakeModel.callCount).toBe(1);

  const dirs1 = await f.listSessionDirs();
  const enrollB = await ownerHost.enroll({ workflowId: 'two-step-test', goal: 'B', workspacePath: f.root }, signal);
  expect(enrollB.kind).toBe('enrolled'); if (enrollB.kind !== 'enrolled') throw new Error('enroll B failed');
  const idB = await f.discoverNewSessionId(dirs1);
  expect(fakeModel.callCount).toBe(1);

  const createHostDiscovery = await loadDiscoveryFactory();
  const discRes = await createHostDiscovery(f.sharedAuthorityConfig, signal);
  expect(discRes.kind).toBe('created'); if (discRes.kind !== 'created') throw new Error('discovery failed');
  const scanner = discRes.scanner;
  f.trackReadRuntime(scanner);
  const { entries } = await collectAllDiscoveryPages(scanner, undefined, signal);

  const entryA = entries.find((e): e is DiscoveredHostSession => e.kind === 'host' && e.sessionId === idA);
  const entryB = entries.find((e): e is DiscoveredHostSession => e.kind === 'host' && e.sessionId === idB);
  expect(entryA).toBeDefined(); if (!entryA) throw new Error('missing session A entry');
  expect(entryB).toBeDefined(); if (!entryB) throw new Error('missing session B entry');

  const snapJBefore = await f.snapshotJournal();
  const snapPBefore = await f.snapshotPins();
  const claimsB = await Promise.all([
    c1Host.automaticRecovery.claimUnowned(entryB.pointer, signal),
    c2Host.automaticRecovery.claimUnowned(entryB.pointer, signal),
  ]);
  for (const res of claimsB) {
    expect(res.kind).toBe('busy');
    if (res.kind !== 'busy') throw new Error('Expected busy claim');
    expect(res.detail.trim().length).toBeGreaterThan(0);
    expect('owner' in res).toBe(false); expect('enrollment' in res).toBe(false); expect('runner' in res).toBe(false);
  }
  expect(await f.snapshotJournal()).toEqual(snapJBefore);
  expect(await f.snapshotPins()).toEqual(snapPBefore);
  expect(fakeModel.callCount).toBe(1);

  const relA = await ownerHost.releaseOwnership(enrollA.enrollment, enrollA.owner, signal);
  expect(relA.kind).toBe('released'); if (relA.kind !== 'released') throw new Error('release A failed');

  const claimsA = await Promise.all([
    c1Host.automaticRecovery.claimUnowned(entryA.pointer, signal),
    c2Host.automaticRecovery.claimUnowned(entryA.pointer, signal),
  ]);
  const readyIdx = claimsA.findIndex(r => r.kind === 'ready');
  const busyIdx = claimsA.findIndex(r => r.kind === 'busy');
  expect(readyIdx).not.toBe(-1); expect(busyIdx).not.toBe(-1); expect(readyIdx).not.toBe(busyIdx);
  const win = claimsA[readyIdx];
  if (!win || win.kind !== 'ready') throw new Error('Missing winning claim');
  const busy = claimsA[busyIdx]!;
  if (busy.kind !== 'busy') throw new Error('Expected losing busy claim');
  expect(busy.detail.trim().length).toBeGreaterThan(0);
  expect('owner' in busy).toBe(false); expect('enrollment' in busy).toBe(false); expect('runner' in busy).toBe(false);
  expect(win.owner.execution).toEqual(enrollA.owner.execution);
  expect(win.owner.epoch).toBeGreaterThan(enrollA.owner.epoch);
  expect(fakeModel.callCount).toBe(1);

  const snapJAfterRace = await f.snapshotJournal();
  const snapPAfterRace = await f.snapshotPins();
  const staleTurn = await enrollA.runner.runTurn(signal);
  expect(staleTurn.kind).toBe('stale_owner');
  expect(fakeModel.callCount).toBe(1);
  expect(await f.snapshotJournal()).toEqual(snapJAfterRace);
  expect(await f.snapshotPins()).toEqual(snapPAfterRace);

  const winnerScheduler = readyIdx === 0 ? c1Host : c2Host;
  const repeats = await Promise.all([
    c1Host.automaticRecovery.claimUnowned(entryA.pointer, signal),
    c2Host.automaticRecovery.claimUnowned(entryA.pointer, signal),
  ]);
  for (const res of repeats) {
    expect(res.kind).toBe('busy');
    if (res.kind !== 'busy') throw new Error('Expected busy claim');
    expect(res.detail.trim().length).toBeGreaterThan(0);
    expect('owner' in res).toBe(false); expect('enrollment' in res).toBe(false); expect('runner' in res).toBe(false);
  }
  expect(await f.snapshotJournal()).toEqual(snapJAfterRace);
  expect(await f.snapshotPins()).toEqual(snapPAfterRace);
  expect(fakeModel.callCount).toBe(1);

  fakeModel.setQueuedResponses([makeAnswerResponse('call_a2', 'Note A2')]);
  const turnA2 = await win.runner.runTurn(signal);
  expect(turnA2.kind).toBe('advanced'); if (turnA2.kind !== 'advanced') throw new Error('turn A2 failed');
  expect(turnA2.nextView.kind).toBe('finished'); if (turnA2.nextView.kind !== 'finished') throw new Error('turn A2 not finished');
  expect(turnA2.nextView.execution.kind).toBe('completed');
  expect(fakeModel.callCount).toBe(2);

  const winPorts = winnerScheduler.bindDiagnosticPorts(win.enrollment);
  await verifyReceiptChunk(winPorts, turnA2.nextView.read, turnA1.receipt, 'Note A1', signal);
  await verifyReceiptChunk(winPorts, turnA2.nextView.read, turnA2.receipt, 'Note A2', signal);

  const sessA = await f.ctx.v2.sessionStore.load(idA);
  expect(sessA.isOk()).toBe(true); if (!sessA.isOk()) throw new Error('load A failed');
  const notesA = sessA.value.events
    .flatMap(e => e.kind === 'node_output_appended' && e.data.payload.payloadKind === 'notes' ? [e.data.payload.notesMarkdown] : []);
  expect(notesA).toEqual(['Note A1', 'Note A2']);

  const snapJDone = await f.snapshotJournal();
  const snapPDone = await f.snapshotPins();
  for (const host of [ownerHost, c1Host, c2Host]) {
    const claimDone = await host.automaticRecovery.claimUnowned(entryA.pointer, signal);
    expect(claimDone.kind).toBe('settled');
    if (claimDone.kind !== 'settled') throw new Error('Expected settled claim');
    expect(claimDone.receipt).toBe(turnA2.receipt);
    expect(claimDone.view.kind).toBe('finished');
    expect(claimDone.view.execution.kind).toBe('completed');
    await verifyReceiptChunk(winPorts, claimDone.view.read, turnA2.receipt, 'Note A2', signal);
    expect('owner' in claimDone).toBe(false); expect('enrollment' in claimDone).toBe(false); expect('runner' in claimDone).toBe(false);
  }
  expect(await f.snapshotJournal()).toEqual(snapJDone);
  expect(await f.snapshotPins()).toEqual(snapPDone);
  expect(fakeModel.callCount).toBe(2);

  fakeModel.setQueuedResponses([makeAnswerResponse('call_b1', 'Note B1')]);
  const turnB1 = await enrollB.runner.runTurn(signal);
  expect(turnB1.kind).toBe('advanced'); if (turnB1.kind !== 'advanced') throw new Error('turn B1 failed');
  expect(turnB1.nextView.kind).toBe('question');
  expect(fakeModel.callCount).toBe(3);
  await verifyReceiptChunk(ownerHost.bindDiagnosticPorts(enrollB.enrollment), turnB1.nextView.read, turnB1.receipt, 'Note B1', signal);

  const portsB = ownerHost.bindDiagnosticPorts(enrollB.enrollment);
  const stopped = await portsB.journal.commitStop(enrollB.owner, 'cancelled', 'stop B', signal);
  expect(stopped.kind).toBe('stopped');
  const snapJStopB = await f.snapshotJournal();
  const snapPStopB = await f.snapshotPins();
  for (const host of [ownerHost, c1Host, c2Host]) {
    const claimStopB = await host.automaticRecovery.claimUnowned(entryB.pointer, signal);
    expect(claimStopB.kind).toBe('stopped');
    if (claimStopB.kind !== 'stopped') throw new Error('Expected stopped claim');
    expect(claimStopB.execution).toEqual(enrollB.enrollment.execution);
    expect(claimStopB.reason).toBe('cancelled');
    expect(claimStopB.detail).toBe('stop B');
    await verifyReceiptChunk(portsB, claimStopB.read, turnB1.receipt, 'Note B1', signal);
    expect('owner' in claimStopB).toBe(false); expect('enrollment' in claimStopB).toBe(false); expect('runner' in claimStopB).toBe(false);
  }
  expect(await enrollB.runner.runTurn(signal)).toMatchObject({ kind: 'stopped', reason: 'cancelled', detail: 'stop B' });
  expect(await f.snapshotJournal()).toEqual(snapJStopB);
  expect(await f.snapshotPins()).toEqual(snapPStopB);
  expect(fakeModel.callCount).toBe(3);

  const sessB = await f.ctx.v2.sessionStore.load(idB);
  expect(sessB.isOk()).toBe(true); if (!sessB.isOk()) throw new Error('load B failed');
  const notesB = sessB.value.events
    .flatMap(e => e.kind === 'node_output_appended' && e.data.payload.payloadKind === 'notes' ? [e.data.payload.notesMarkdown] : []);
  expect(notesB).toEqual(['Note B1']);
}));

it('conditional recovery admission: stale decisions cannot replace newer owners', () => consoleHostFixture(async f => {
  const signal = AbortSignal.timeout(15_000);
  const fakeModel = new FakeTestModelBoundary();
  const createAnswerHost = await f.loadFactory();

  const assertNoAuth = (r: object) => {
    expect('owner' in r).toBe(false);
    expect('enrollment' in r).toBe(false);
    expect('runner' in r).toBe(false);
  };

  const resH0 = await createAnswerHost({ ...f.sharedAuthorityConfig, model: fakeModel }, signal);
  expect(resH0.kind).toBe('created'); if (resH0.kind !== 'created') throw new Error('host 0 failed');
  f.trackHost(resH0.scheduler);
  const ownerHost = resH0.scheduler;

  const resH1 = await createAnswerHost({ ...f.sharedAuthorityConfig, model: fakeModel }, signal);
  expect(resH1.kind).toBe('created'); if (resH1.kind !== 'created') throw new Error('host 1 failed');
  f.trackHost(resH1.scheduler);
  const c1Host = resH1.scheduler;

  const resH2 = await createAnswerHost({ ...f.sharedAuthorityConfig, model: fakeModel }, signal);
  expect(resH2.kind).toBe('created'); if (resH2.kind !== 'created') throw new Error('host 2 failed');
  f.trackHost(resH2.scheduler);
  const c2Host = resH2.scheduler;

  const dirs0 = await f.listSessionDirs();
  const enrollA = await ownerHost.enroll({ workflowId: 'two-step-test', goal: 'A', workspacePath: f.root }, signal);
  expect(enrollA.kind).toBe('enrolled'); if (enrollA.kind !== 'enrolled') throw new Error('enroll A failed');
  const idA = await f.discoverNewSessionId(dirs0);
  const ptrA = ownerHost.hydrator.dehydrate(enrollA.enrollment);

  fakeModel.setQueuedResponses([makeAnswerResponse('call_a1', 'Note A1')]);
  const turnA1 = await enrollA.runner.runTurn(signal);
  expect(turnA1.kind).toBe('advanced'); if (turnA1.kind !== 'advanced') throw new Error('turn A1 failed');
  expect(fakeModel.callCount).toBe(1);

  const dirs1 = await f.listSessionDirs();
  const enrollB = await ownerHost.enroll({ workflowId: 'two-step-test', goal: 'B', workspacePath: f.root }, signal);
  expect(enrollB.kind).toBe('enrolled'); if (enrollB.kind !== 'enrolled') throw new Error('enroll B failed');
  const idB = await f.discoverNewSessionId(dirs1);
  const ptrB = ownerHost.hydrator.dehydrate(enrollB.enrollment);
  expect(fakeModel.callCount).toBe(1);

  const snapJ0 = await f.snapshotJournal();
  const snapP0 = await f.snapshotPins();
  const foreignRes = await c1Host.conditionalRecovery.replaceIfCurrent(ptrA, enrollB.owner, signal);
  expect(foreignRes.kind).toBe('refused'); if (foreignRes.kind !== 'refused') throw new Error('foreign refused');
  expect(foreignRes.reason).toBe('ownership_changed');
  assertNoAuth(foreignRes);
  expect(await f.snapshotJournal()).toEqual(snapJ0);
  expect(await f.snapshotPins()).toEqual(snapP0);
  expect(fakeModel.callCount).toBe(1);

  const relB = await ownerHost.releaseOwnership(enrollB.enrollment, enrollB.owner, signal);
  expect(relB.kind).toBe('released'); if (relB.kind !== 'released') throw new Error('release B failed');

  const snapJ1 = await f.snapshotJournal();
  const snapP1 = await f.snapshotPins();
  const unownedBRes = await c1Host.conditionalRecovery.replaceIfCurrent(ptrB, enrollB.owner, signal);
  expect(unownedBRes.kind).toBe('refused'); if (unownedBRes.kind !== 'refused') throw new Error('unowned B refused');
  expect(unownedBRes.reason).toBe('ownership_changed');
  assertNoAuth(unownedBRes);
  expect(await f.snapshotJournal()).toEqual(snapJ1);
  expect(await f.snapshotPins()).toEqual(snapP1);
  expect(fakeModel.callCount).toBe(1);

  const raceA = await Promise.all([
    c1Host.conditionalRecovery.replaceIfCurrent(ptrA, enrollA.owner, signal),
    c2Host.conditionalRecovery.replaceIfCurrent(ptrA, enrollA.owner, signal),
  ]);
  const readyIdx = raceA.findIndex(r => r.kind === 'ready');
  const changedIdx = raceA.findIndex(r => r.kind === 'refused' && r.reason === 'ownership_changed');
  expect(readyIdx).not.toBe(-1); expect(changedIdx).not.toBe(-1); expect(readyIdx).not.toBe(changedIdx);
  const win = raceA[readyIdx]!; if (win.kind !== 'ready') throw new Error('missing winning claim');
  const loser = raceA[changedIdx]!; if (loser.kind !== 'refused') throw new Error('expected refused loser');
  assertNoAuth(loser);
  expect(win.owner.execution).toEqual(enrollA.owner.execution);
  expect(win.owner.epoch).toBeGreaterThan(enrollA.owner.epoch);
  expect(fakeModel.callCount).toBe(1);
  const winnerScheduler = readyIdx === 0 ? c1Host : c2Host;

  const snapJAfterRace = await f.snapshotJournal();
  const snapPAfterRace = await f.snapshotPins();
  const replayA = await Promise.all([
    c1Host.conditionalRecovery.replaceIfCurrent(ptrA, enrollA.owner, signal),
    c2Host.conditionalRecovery.replaceIfCurrent(ptrA, enrollA.owner, signal),
  ]);
  for (const res of replayA) {
    expect(res.kind).toBe('refused'); if (res.kind !== 'refused') throw new Error('expected refused replay');
    expect(res.reason).toBe('ownership_changed');
    assertNoAuth(res);
  }
  expect(await f.snapshotJournal()).toEqual(snapJAfterRace);
  expect(await f.snapshotPins()).toEqual(snapPAfterRace);
  expect(fakeModel.callCount).toBe(1);

  const staleTurnA = await enrollA.runner.runTurn(signal);
  expect(staleTurnA.kind).toBe('stale_owner');
  expect(await f.snapshotJournal()).toEqual(snapJAfterRace);
  expect(await f.snapshotPins()).toEqual(snapPAfterRace);
  expect(fakeModel.callCount).toBe(1);

  fakeModel.setQueuedResponses([makeAnswerResponse('call_a2', 'Note A2')]);
  const turnA2 = await win.runner.runTurn(signal);
  expect(turnA2.kind).toBe('advanced'); if (turnA2.kind !== 'advanced') throw new Error('turn A2 failed');
  expect(turnA2.nextView.kind).toBe('finished'); if (turnA2.nextView.kind !== 'finished') throw new Error('turn A2 not finished');
  expect(turnA2.nextView.execution.kind).toBe('completed');
  expect(fakeModel.callCount).toBe(2);

  const winPorts = winnerScheduler.bindDiagnosticPorts(win.enrollment);
  await verifyReceiptChunk(winPorts, turnA2.nextView.read, turnA1.receipt, 'Note A1', signal);
  await verifyReceiptChunk(winPorts, turnA2.nextView.read, turnA2.receipt, 'Note A2', signal);

  const sessA = await f.ctx.v2.sessionStore.load(idA);
  expect(sessA.isOk()).toBe(true); if (!sessA.isOk()) throw new Error('load A failed');
  const notesA = sessA.value.events
    .flatMap(e => e.kind === 'node_output_appended' && e.data.payload.payloadKind === 'notes' ? [e.data.payload.notesMarkdown] : []);
  expect(notesA).toEqual(['Note A1', 'Note A2']);

  const snapJDoneA = await f.snapshotJournal();
  const snapPDoneA = await f.snapshotPins();
  for (const host of [ownerHost, c1Host, c2Host]) {
    const resDoneA = await host.conditionalRecovery.replaceIfCurrent(ptrA, win.owner, signal);
    expect(resDoneA.kind).toBe('settled'); if (resDoneA.kind !== 'settled') throw new Error('expected settled');
    expect(resDoneA.receipt).toBe(turnA2.receipt);
    expect(resDoneA.view.kind).toBe('finished');
    expect(resDoneA.view.execution.kind).toBe('completed');
    await verifyReceiptChunk(winPorts, resDoneA.view.read, turnA2.receipt, 'Note A2', signal);
    assertNoAuth(resDoneA);
  }
  expect(await f.snapshotJournal()).toEqual(snapJDoneA);
  expect(await f.snapshotPins()).toEqual(snapPDoneA);
  expect(fakeModel.callCount).toBe(2);

  const claimB = await c1Host.automaticRecovery.claimUnowned(ptrB, signal);
  expect(claimB.kind).toBe('ready'); if (claimB.kind !== 'ready') throw new Error('claim B ready failed');

  fakeModel.setQueuedResponses([
    makeAnswerResponse('call_b1', 'Note B1'),
    makeAnswerResponse('call_b2', 'Note B2'),
  ]);
  const turnB1 = await claimB.runner.runTurn(signal);
  expect(turnB1.kind).toBe('advanced'); if (turnB1.kind !== 'advanced') throw new Error('turn B1 failed');
  expect(fakeModel.callCount).toBe(3);

  const turnB2 = await claimB.runner.runTurn(signal);
  expect(turnB2.kind).toBe('advanced'); if (turnB2.kind !== 'advanced') throw new Error('turn B2 failed');
  expect(turnB2.nextView.kind).toBe('finished'); if (turnB2.nextView.kind !== 'finished') throw new Error('turn B2 not finished');
  expect(turnB2.nextView.execution.kind).toBe('completed');
  expect(fakeModel.callCount).toBe(4);

  const portsB = c1Host.bindDiagnosticPorts(claimB.enrollment);
  await verifyReceiptChunk(portsB, turnB2.nextView.read, turnB1.receipt, 'Note B1', signal);
  await verifyReceiptChunk(portsB, turnB2.nextView.read, turnB2.receipt, 'Note B2', signal);

  const sessB = await f.ctx.v2.sessionStore.load(idB);
  expect(sessB.isOk()).toBe(true); if (!sessB.isOk()) throw new Error('load B failed');
  const notesB = sessB.value.events
    .flatMap(e => e.kind === 'node_output_appended' && e.data.payload.payloadKind === 'notes' ? [e.data.payload.notesMarkdown] : []);
  expect(notesB).toEqual(['Note B1', 'Note B2']);
  expect(fakeModel.callCount).toBe(4);
}));

import type { KnownLegacyBaseline, LegacyRollbackInspectConfig } from './legacy-rollback-contract.js';

type InspectLegacyRollback = (typeof import('./legacy-rollback-contract.js'))['inspectLegacyRollback'];

async function loadRollback(): Promise<InspectLegacyRollback> {
  const path = resolve(process.cwd(), 'src/answer-v1/legacy-rollback.ts');
  try { await stat(path); } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      expect.fail('runtime_unavailable: src/answer-v1/legacy-rollback.ts');
    }
    throw error;
  }
  const mod: { inspectLegacyRollback?: InspectLegacyRollback } = await import(/* @vite-ignore */ path);
  if (typeof mod.inspectLegacyRollback !== 'function') throw new Error('runtime_error: missing inspectLegacyRollback export');
  return mod.inspectLegacyRollback;
}

function assertNoAuth(r: object): void {
  expect('launchAuthority' in r).toBe(false);
  expect('readyToDowngrade' in r).toBe(false);
  expect('compatible' in r).toBe(false);
  expect('owner' in r).toBe(false);
  expect('runner' in r).toBe(false);
  expect('reply' in r).toBe(false);
  expect('pointer' in r).toBe(false);
  expect('recoveryLocator' in r).toBe(false);
}

describe('legacy rollback inspection:', () => {
  const baseline: KnownLegacyBaseline = '396cdfa4e665afa993b50fcf0ec59ca53a2167db';

  it('retains every unreadable session across page boundaries including non-directories', () =>
    consoleHostFixture(async f => {
      const inspect = await loadRollback();
      await seedLegacySession(f, 'rollback-page-seed');
      const unreadableIds = Array.from({ length: 65 }, (_, i) => `sess_rollback${String(i).padStart(3, '0')}`);
      for (const id of unreadableIds) await writeFile(join(f.storageConfig.journalRootDir, id), 'retained unreadable session');
      const before = await f.snapshotRoot();
      const result = await inspect({ targetBaseline: baseline, discovery: f.sharedAuthorityConfig }, AbortSignal.timeout(15000));
      expect(result.kind).toBe('inconclusive');
      if (result.kind !== 'inconclusive') throw new Error('Expected incomplete compatibility evidence');
      expect(result.issues.filter(issue => issue.kind === 'session').map(issue => issue.sessionId)).toEqual(unreadableIds);
      expect(result.observedIncompatibleSessions).toEqual([]);
      expect(await f.snapshotRoot()).toEqual(before);
      assertNoAuth(result);
    }));

  it('legacy-only: observation count 1, no authority, precancelled, unchanged snapshots', () =>
    consoleHostFixture(async f => {
      const inspectLegacyRollback = await loadRollback();
      const signal = AbortSignal.timeout(15_000);
      const config: LegacyRollbackInspectConfig = {
        targetBaseline: baseline,
        discovery: f.sharedAuthorityConfig,
      };

      await seedLegacySession(f, 'rollback-legacy');

      const beforeCancel = await f.snapshotRoot();
      const cancelRes = await inspectLegacyRollback(config, AbortSignal.abort());
      expect(cancelRes.kind).toBe('cancelled');
      expect(cancelRes.baseline).toBe(baseline);
      expect(cancelRes.notice).toBe('observation_only_not_downgrade_authorization');
      assertNoAuth(cancelRes);
      expect(await f.snapshotRoot()).toEqual(beforeCancel);

      const snapJ = await f.snapshotRoot();
      const snapP = await f.snapshotPins();
      const res = await inspectLegacyRollback(config, signal);
      expect(await f.snapshotRoot()).toEqual(snapJ);
      expect(await f.snapshotPins()).toEqual(snapP);

      expect(res.kind).toBe('no_answer_sessions_observed');
      if (res.kind !== 'no_answer_sessions_observed') throw new Error('expected no_answer_sessions_observed');
      expect(res.scannedSessionCount).toBe(1);
      expect(res.baseline).toBe(baseline);
      expect(res.notice).toBe('observation_only_not_downgrade_authorization');
      assertNoAuth(res);
      const journalRoot = f.storageConfig.journalRootDir;
      const backup = journalRoot + '.rollback-inspection-backup';
      await rename(journalRoot, backup);
      try {
        const missingRoot = await f.snapshotRoot();
        const unavailable = await inspectLegacyRollback(config, signal);
        expect(unavailable.kind).toBe('inconclusive');
        if (unavailable.kind !== 'inconclusive') throw new Error('Expected missing-root issue');
        expect(unavailable.issues.some(i => i.kind === 'root' && i.reason === 'missing')).toBe(true);
        assertNoAuth(unavailable);
        for (const issue of unavailable.issues) assertNoAuth(issue);
        expect(await f.snapshotRoot()).toEqual(missingRoot);
      } finally {
        await rm(journalRoot, { recursive: true, force: true });
        await rename(backup, journalRoot);
      }
      expect(await f.snapshotRoot()).toEqual(beforeCancel);
    }));

  it('host A1, unbound B1, legacy C: refused, completion, corruption, recovery and verification', () =>
    consoleHostFixture(async f => {
      const inspectLegacyRollback = await loadRollback();
      const signal = AbortSignal.timeout(15_000);
      const config: LegacyRollbackInspectConfig = {
        targetBaseline: baseline,
        discovery: f.sharedAuthorityConfig,
      };

      const fakeModel = new FakeTestModelBoundary();
      const createAnswerHost = await f.loadFactory();
      const resH0 = await createAnswerHost({ ...f.sharedAuthorityConfig, model: fakeModel }, signal);
      expect(resH0.kind).toBe('created');
      if (resH0.kind !== 'created') throw new Error('host failed');
      f.trackHost(resH0.scheduler);
      const host = resH0.scheduler;

      const dirsA = await f.listSessionDirs();
      const enrollA = await host.enroll({ workflowId: 'two-step-test', goal: 'Host A', workspacePath: f.root }, signal);
      expect(enrollA.kind).toBe('enrolled');
      if (enrollA.kind !== 'enrolled') throw new Error('enroll A failed');
      const idA = await f.discoverNewSessionId(dirsA);

      fakeModel.setQueuedResponses([makeAnswerResponse('call_a1', 'Note A1')]);
      const turnA1 = await enrollA.runner.runTurn(signal);
      expect(turnA1.kind).toBe('advanced');
      if (turnA1.kind !== 'advanced') throw new Error('turn A1 failed');
      expect(fakeModel.callCount).toBe(1);

      const answersMcp = await f.bootMcp('answers', { answerAuthority: f.sharedAuthorityConfig });
      const dirsB = await f.listSessionDirs();
      const openRes = openedSchema.parse(
        await answersMcp.call('open_work', {
          workflowId: 'two-step-test',
          workspacePath: f.root,
          goal: 'Unbound B',
        }),
      );
      const idB = await f.discoverNewSessionId(dirsB);
      const unboundQ1 = question(openRes.view);
      const unboundStep1 = recordedSchema.parse(
        await answersMcp.call('answer_work', {
          reply: unboundQ1.reply,
          answer: { notes: 'Note B1' },
        }),
      );
      expect(unboundStep1.disposition).toBe('accepted');

      await seedLegacySession(f, 'rollback-mixed');

      const snapJ0 = await f.snapshotRoot();
      const snapP0 = await f.snapshotPins();
      const calls0 = fakeModel.callCount;

      const res1 = await inspectLegacyRollback(config, signal);
      expect(await f.snapshotRoot()).toEqual(snapJ0);
      expect(await f.snapshotPins()).toEqual(snapP0);
      expect(fakeModel.callCount).toBe(calls0);

      const expectedIncompatible = [
        { kind: 'host' as const, sessionId: idA },
        { kind: 'unbound' as const, sessionId: idB },
      ].sort((x, y) => (x.sessionId < y.sessionId ? -1 : x.sessionId > y.sessionId ? 1 : 0));

      expect(res1.kind).toBe('refused');
      if (res1.kind !== 'refused') throw new Error('expected refused');
      expect(res1.reason).toBe('incompatible_answer_sessions_present');
      expect(res1.remediation).toBe('use_supporting_version_or_separate_verified_backup');
      expect(res1.baseline).toBe(baseline);
      expect(res1.notice).toBe('observation_only_not_downgrade_authorization');
      assertNoAuth(res1);
      expect(res1.affectedSessions).toEqual(expectedIncompatible);

      fakeModel.setQueuedResponses([makeAnswerResponse('call_a2', 'Note A2')]);
      const turnA2 = await enrollA.runner.runTurn(signal);
      expect(turnA2.kind).toBe('advanced');
      if (turnA2.kind !== 'advanced') throw new Error('turn A2 failed');
      expect(turnA2.nextView.kind).toBe('finished');
      if (turnA2.nextView.kind !== 'finished') throw new Error('turn A2 not finished');
      expect(turnA2.nextView.execution.kind).toBe('completed');
      expect(fakeModel.callCount).toBe(2);

      const portsA = host.bindDiagnosticPorts(enrollA.enrollment);
      await verifyReceiptChunk(portsA, turnA2.nextView.read, turnA1.receipt, 'Note A1', signal);
      await verifyReceiptChunk(portsA, turnA2.nextView.read, turnA2.receipt, 'Note A2', signal);

      const snapJAfterComp = await f.snapshotRoot();
      const snapPAfterComp = await f.snapshotPins();

      const res2 = await inspectLegacyRollback(config, signal);
      expect(await f.snapshotRoot()).toEqual(snapJAfterComp);
      expect(await f.snapshotPins()).toEqual(snapPAfterComp);
      expect(res2.kind).toBe('refused');
      if (res2.kind !== 'refused') throw new Error('expected refused');
      expect(res2.affectedSessions).toEqual(expectedIncompatible);
      assertNoAuth(res2);
      expect(fakeModel.callCount).toBe(2);

      const segA = await locateCommittedSessionSegment(f.dataDir, f.root, idA);
      const origBytes = await readFile(segA.targetSegPath);
      const faultBytes = Buffer.concat([origBytes, Buffer.from([0x7f])]);
      try {
        await writeFile(segA.targetSegPath, faultBytes);
        const faultRoot = await f.snapshotRoot();
        const corruptRes = await inspectLegacyRollback(config, signal);
        expect(corruptRes.kind).toBe('inconclusive');
        if (corruptRes.kind !== 'inconclusive') throw new Error('expected inconclusive');
        assertNoAuth(corruptRes);
        for (const issue of corruptRes.issues) assertNoAuth(issue);
        expect(corruptRes.issues.some(i => i.kind === 'session' && i.sessionId === idA && i.reason === 'corrupt')).toBe(true);
        expect(corruptRes.observedIncompatibleSessions).toEqual([{ kind: 'unbound', sessionId: idB }]);

        const curBytes = await readFile(segA.targetSegPath);
        expect(curBytes.length).toBe(faultBytes.length);
        expect(curBytes).toEqual(faultBytes);
        expect(await f.snapshotRoot()).toEqual(faultRoot);
        expect(fakeModel.callCount).toBe(2);
      } finally {
        await writeFile(segA.targetSegPath, origBytes);
      }

      const resRestored = await inspectLegacyRollback(config, signal);
      expect(resRestored.kind).toBe('refused');
      if (resRestored.kind !== 'refused') throw new Error('expected refused');
      expect(resRestored.affectedSessions).toEqual(expectedIncompatible);
      assertNoAuth(resRestored);
      expect(await f.snapshotRoot()).toEqual(snapJAfterComp);
      expect(fakeModel.callCount).toBe(2);

      await verifyReceiptChunk(portsA, turnA2.nextView.read, turnA1.receipt, 'Note A1', signal);
      await verifyReceiptChunk(portsA, turnA2.nextView.read, turnA2.receipt, 'Note A2', signal);
    }));
});
