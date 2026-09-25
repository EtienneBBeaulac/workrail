/** Acceptance over mounted console HTTP routes and durable session storage. */
import 'reflect-metadata';
import type { AnswerMcpCompositionOptions } from '../../src/answer-v1/contracts/host-composition.js';
import { expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, access, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ManifestRecordV1Schema, type ManifestRecordV1 } from '../../src/v2/durable-core/schemas/session/manifest.js';
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
import type { WorkflowDefinition } from '../../src/types/workflow-definition.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { handleV2ContinueWorkflow } from '../../src/mcp/handlers/v2-execution.js';
import { asSessionId, type SessionId } from '../../src/v2/durable-core/ids/index.js';
import { runWorkflow } from '../../src/daemon/workflow-runner.js';
const serverModulePath = '../../src/mcp/server.js';
const helperModulePath = '../../tests/helpers/v2-test-helpers.js';
interface ConsoleMcpServer { connect(transport: Transport): Promise<void>; close(): Promise<void> }
const composeServer = async (options?: AnswerMcpCompositionOptions): Promise<{ server: ConsoleMcpServer }> => {
  const mod = await import(/* @vite-ignore */ serverModulePath) as { composeServer(options?: AnswerMcpCompositionOptions): Promise<{ server: ConsoleMcpServer }> };
  return mod.composeServer(options);
};
const createV2ToolContext = async (dataDir: LocalDataDirV2): Promise<V2ToolContext> => {
  const mod = await import(/* @vite-ignore */ helperModulePath) as { createV2ToolContext(dataDir: LocalDataDirV2): Promise<V2ToolContext> };
  return mod.createV2ToolContext(dataDir);
};
import { resetContainer } from '../../src/di/container.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Console liveness uses a module-level home path. Keep its unrelated daemon-log
// lookup outside the user's home; the fixture's actual session store is explicit.
vi.mock('os', async original => {
  const actual = await original<typeof import('node:os')>();
  const homedir = () => '/__unavailable_workrail_console_fixture_home__';
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock('../../src/daemon/workflow-runner.js', () => ({
  runWorkflow: vi.fn(async () => ({ _tag: 'success', workflowId: 'console-preservation', stopReason: 'captured-only' })),
}));

// Recursive check ensuring read projections cannot mint writer or owner authority
const assertNoReply = (raw: unknown): void => {
  if (raw && typeof raw === 'object') {
    expect(Object.hasOwn(raw, 'reply'), 'Console read projections cannot mint reply authority').toBe(false);
    expect(Object.hasOwn(raw, 'recovery'), 'Console read projections cannot mint worker recovery authority').toBe(false);
    expect(Object.hasOwn(raw, 'owner'), 'Console read projections cannot mint owner authority').toBe(false);
    for (const value of Object.values(raw)) assertNoReply(value);
  }
};

// Strict projection schemas for candidate HTTP responses
const questionIssueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('field'), field: z.string(), reason: z.string() }).strict(),
  z.object({ kind: z.literal('gate'), rationale: z.string() }).strict(),
]);

const evidenceSummarySchema = z.object({
  receipt: z.string(),
  description: z.string(),
}).strict();

const questionViewSchema = z.object({
  kind: z.literal('question'),
  read: z.string(),
  instruction: z.string(),
  retained: z.array(evidenceSummarySchema),
  issues: z.array(questionIssueSchema),
}).strict();

const waitingViewSchema = z.object({
  kind: z.literal('waiting'),
  read: z.string(),
  reason: z.enum(['approval', 'external_evidence']),
  retained: z.array(evidenceSummarySchema),
}).strict();

const reconcilingViewSchema = z.object({
  kind: z.literal('reconciling'),
  read: z.string(),
  description: z.string(),
  continuation: z.enum(['advance_after_confirmation', 'stop_after_confirmation']),
  retained: z.array(evidenceSummarySchema),
}).strict();

const finishedExecutionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('completed') }).strict(),
  z.object({
    kind: z.literal('incomplete'),
    reason: z.enum(['cancelled', 'gate_rejected', 'timeout', 'failed']),
    detail: z.string(),
  }).strict(),
]);

const finishedViewSchema = z.object({
  kind: z.literal('finished'),
  read: z.string(),
  execution: finishedExecutionSchema,
  taskOutcome: z.enum(['success', 'failure', 'partial', 'unknown']),
  retained: z.array(evidenceSummarySchema),
}).strict();

const inspectionViewSchema = z.discriminatedUnion('kind', [
  questionViewSchema,
  waitingViewSchema,
  reconcilingViewSchema,
  finishedViewSchema,
]);

const candidateAnswerResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    sessionId: z.string(),
    view: inspectionViewSchema,
  }).strict(),
}).strict();

const candidateReceiptPageSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('complete'),
    receipt: z.string(),
    disposition: z.enum(['accepted', 'partial', 'rejected']),
    encoding: z.enum(['canonical_json', 'raw_utf8']),
    chunk: z.string(),
  }).strict(),
  z.object({
    kind: z.literal('more'),
    receipt: z.string(),
    disposition: z.enum(['accepted', 'partial', 'rejected']),
    encoding: z.enum(['canonical_json', 'raw_utf8']),
    chunk: z.string(),
    next: z.string().min(1),
  }).strict(),
]);

const candidateReceiptResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    sessionId: z.string(),
    receipt: z.string(),
    page: candidateReceiptPageSchema,
  }).strict(),
}).strict();

const candidateRefusalSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  outcome: z.object({
    kind: z.literal('refused'),
    sessionId: z.string(),
    receipt: z.string(),
    reason: z.literal('invalid_scope'),
  }).strict(),
}).strict();

const candidateUnavailableSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  outcome: z.object({
    kind: z.literal('unavailable'),
    sessionId: z.string(),
    reason: z.enum(['missing', 'corrupt', 'unsupported_version', 'storage_unavailable', 'profile_disabled']),
    detail: z.string().optional(),
  }).strict(),
}).strict();

async function locateCommittedSegment(dataDir: LocalDataDirV2, root: string, sessionId: SessionId) {
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
  return { sessionId, manifestPath, manifestRaw, targetSeg, targetSegPath, closedSegments };
}

const viewSchema = z.object({ kind: z.string(), read: z.string(), reply: z.string().optional() }).passthrough();
const recordedSchema = z.object({
  kind: z.literal('recorded'),
  receipt: z.string(),
  disposition: z.enum(['accepted', 'partial', 'rejected']),
  view: viewSchema,
}).passthrough();
const openedSchema = z.object({ kind: z.literal('opened'), recovery: z.string(), view: viewSchema }).passthrough();

const question = (raw: unknown) => {
  const view = viewSchema.parse(raw);
  expect(view.kind).toBe('question');
  return z.object({ reply: z.string().min(1), read: z.string().min(1), instruction: z.string().min(1) }).passthrough().parse(view);
};

async function drainHttpReceipt(
  get: (path: string) => Promise<{ status: number; body: unknown }>,
  sessionId: SessionId,
  receipt: string,
  options?: { initialCursor?: string },
): Promise<{
  pages: z.infer<typeof candidateReceiptPageSchema>[];
  reassembled: string;
}> {
  const pages: z.infer<typeof candidateReceiptPageSchema>[] = [];
  const seenCursors = new Set<string>();
  let currentCursor = options?.initialCursor;
  let reassembled = '';
  let expectedEncoding: 'canonical_json' | 'raw_utf8' | undefined;
  let expectedDisposition: 'accepted' | 'partial' | 'rejected' | undefined;
  const maxIterations = 20;

  for (let i = 0; i < maxIterations; i++) {
    if (currentCursor !== undefined) {
      expect(seenCursors.has(currentCursor), 'Cursor must not repeat (infinite loop prevention)').toBe(false);
      seenCursors.add(currentCursor);
    }
    const query = currentCursor !== undefined ? `?cursor=${encodeURIComponent(currentCursor)}` : '';
    const res = await get(`/api/v2/sessions/${encodeURIComponent(sessionId)}/answer/receipts/${encodeURIComponent(receipt)}${query}`);
    expect(res.status).toBe(200);
    assertNoReply(res.body);

    const parsed = candidateReceiptResponseSchema.parse(res.body);
    const page = parsed.data.page;
    expect(parsed.data.receipt).toBe(receipt);
    expect(parsed.data.sessionId).toBe(sessionId);

    if (expectedDisposition === undefined) expectedDisposition = page.disposition;
    else expect(page.disposition).toBe(expectedDisposition);

    if (expectedEncoding === undefined) expectedEncoding = page.encoding;
    else expect(page.encoding).toBe(expectedEncoding);

    const chunkBytes = Buffer.byteLength(page.chunk, 'utf8');
    expect(chunkBytes).toBeLessThanOrEqual(4096);
    reassembled += page.chunk;
    pages.push(page);

    if (page.kind === 'more') {
      expect(chunkBytes).toBeGreaterThan(0);
      currentCursor = page.next;
    } else {
      currentCursor = undefined;
      break;
    }
  }

  expect(currentCursor, 'Paging traversal must terminate within max iterations').toBeUndefined();
  return { pages, reassembled };
}

let priorCleanupFailure: Error | undefined;

const bounded = async (work: Promise<unknown>, timeoutMs = 3000): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Cleanup timed out; preserve storage')), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
};

async function fixture(run: (f: {
  root: string;
  dataDir: LocalDataDirV2;
  ctx: V2ToolContext;
  get: (path: string) => Promise<{ status: number; body: any }>;
  post: (path: string, body: unknown) => Promise<{ status: number; body: any }>;
  sessionFiles: (dir?: string) => Promise<Record<string, string>>;
  notes: (sessionId: SessionId) => Promise<string[]>;
  listSessionDirs: () => Promise<Set<string>>;
  discoverNewSessionId: (existing: ReadonlySet<string>) => Promise<SessionId>;
  boot: (profile: 'notes' | 'answers') => Promise<void>;
  closeMcp: () => Promise<void>;
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}) => Promise<void>) {
  if (priorCleanupFailure) throw priorCleanupFailure;
  const root = await mkdtemp(join(tmpdir(), 'workrail-console-answer-acceptance-'));
  const envKeys = [
    'WORKRAIL_DATA_DIR',
    'WORKFLOW_STORAGE_PATH',
    'WORKRAIL_ENABLE_V2_TOOLS',
    'WORKRAIL_ENABLE_SESSION_TOOLS',
    'WORKRAIL_AGENT_PROFILE',
    'ANTHROPIC_API_KEY',
  ] as const;
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.ANTHROPIC_API_KEY = 'local-fixture-no-model-call';
  process.env.WORKRAIL_DATA_DIR = root;
  process.env.WORKRAIL_ENABLE_V2_TOOLS = 'true';
  process.env.WORKRAIL_ENABLE_SESSION_TOOLS = 'false';

  let server: http.Server | undefined;
  let unmount: (() => void) | undefined;
  let mcpClient: Client | undefined;
  let mcpServer: Awaited<ReturnType<typeof composeServer>>['server'] | undefined;

  vi.mocked(runWorkflow).mockClear();

  const closeMcp = async () => {
    const errors: unknown[] = [];
    if (mcpClient) {
      try { await bounded(mcpClient.close()); mcpClient = undefined; } catch (err) { errors.push(err); }
    }
    if (mcpServer) {
      try { await bounded(mcpServer.close()); mcpServer = undefined; } catch (err) { errors.push(err); }
    }
    if (errors.length > 0) {
      priorCleanupFailure = new AggregateError(errors, `Failed to close MCP; retained ${root}`);
      throw priorCleanupFailure;
    }
  };

  const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });

  // Never swallow scan errors; root exists so recursive snapshot fails on unexpected errors.
  const sessionFiles = async (dir = dataDir.sessionsDir()): Promise<Record<string, string>> => {
    const result: Record<string, string> = {};
    try {
      await access(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return result;
      throw err;
    }
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        result[p] = '<directory>';
        Object.assign(result, await sessionFiles(p));
      } else {
        result[p] = (await readFile(p)).toString('base64');
      }
    }
    return result;
  };

  const listSessionDirs = async (): Promise<Set<string>> => {
    try {
      const entries = await readdir(dataDir.sessionsDir(), { withFileTypes: true });
      return new Set(entries.filter(e => e.isDirectory()).map(e => e.name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
      throw err;
    }
  };

  const discoverNewSessionId = async (existing: ReadonlySet<string>): Promise<SessionId> => {
    const entries = await readdir(dataDir.sessionsDir(), { withFileTypes: true });
    const currentDirs = entries.filter(e => e.isDirectory()).map(e => e.name);
    const diff = currentDirs.filter(d => !existing.has(d));
    expect(diff.length, 'Must discover exactly 1 new session directory per open').toBe(1);
    return asSessionId(diff[0]!);
  };


  let primaryError: unknown;
  try {
    // Write synthetic workflows to WORKFLOW_STORAGE_PATH on disk so MCP server finds them
    const workflowsDir = join(root, 'workflows');
    await mkdir(workflowsDir, { recursive: true });

    const legacyDefinition: WorkflowDefinition = {
      id: 'console-preservation',
      name: 'Console preservation',
      description: 'Actual route fixture',
      version: '1.0.0',
      about: 'Retain source and content.',
      steps: [{
        id: 'work',
        title: 'Work',
        prompt: 'Record observations.',
        outputContract: { contractRef: 'wr.contracts.review_verdict' },
      }],
    };

    const answerNotesDefinition: WorkflowDefinition = {
      id: 'answer-notes',
      name: 'Answer notes',
      description: 'Linear notes workflow',
      version: '1.0.0',
      steps: [
        { id: 'first', title: 'First', prompt: 'Record the first observation.' },
        { id: 'second', title: 'Second', prompt: 'Record the second observation.' },
      ],
    };

    await writeFile(join(workflowsDir, 'console-preservation.json'), JSON.stringify(legacyDefinition));
    await writeFile(join(workflowsDir, 'answer-notes.json'), JSON.stringify(answerNotesDefinition));
    process.env.WORKFLOW_STORAGE_PATH = workflowsDir;

    const base = await createV2ToolContext(dataDir);
    if (!base.v2) throw new Error('Missing fixture engine');

    const legacyWorkflow = createWorkflow(legacyDefinition, createBundledSource());
    const answerNotesWorkflow = createWorkflow(answerNotesDefinition, createBundledSource());

    const reader = new DefaultWorkflowService(
      new InMemoryWorkflowStorage([
        legacyWorkflow.definition,
        answerNotesWorkflow.definition,
      ]),
      new ValidationEngine(new EnhancedLoopValidator()),
      new WorkflowCompiler(),
      new WorkflowInterpreter(),
    );

    const ctx: V2ToolContext = {
      ...base,
      v2: base.v2,
      workflowService: reader,
      featureFlags: new EnvironmentFeatureFlagProvider(),
    };

    const service = new ConsoleService({
      dataDir,
      directoryListing: new LocalDirectoryListingV2(new NodeFileSystemV2()),
      sessionStore: ctx.v2.sessionStore,
      snapshotStore: ctx.v2.snapshotStore,
      pinnedWorkflowStore: ctx.v2.pinnedStore,
    });

    const app = express();
    unmount = mountConsoleRoutes(app, service, reader, undefined, undefined, 'fixture', ctx);
    server = http.createServer(app);
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });

    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const get = async (path: string) => {
      const response = await fetch(baseUrl + path, { signal: AbortSignal.timeout(5000) });
      return { status: response.status, body: await response.json() };
    };

    const post = async (path: string, body: unknown) => {
      const response = await fetch(baseUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };

    const boot = async (profile: 'notes' | 'answers'): Promise<void> => {
      await closeMcp();
      process.env.WORKRAIL_AGENT_PROFILE = profile;
      try {
        mcpServer = (await composeServer(profile === 'answers' ? { answerAuthority: { storage: { journalRootDir: dataDir.sessionsDir(), hostIndexRootDir: join(root, 'answer-v1', 'host-index') }, keyringPath: dataDir.keyringPath(), workflowStoragePath: workflowsDir } } : undefined)).server;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('Unknown WORKRAIL_AGENT_PROFILE')) throw error;
        throw new Error(`bootstrap_unavailable: Profile ${profile} unavailable; downstream acceptance assertions not exercised: ${String(error)}`);
      }
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      mcpClient = new Client({ name: 'console-answer-acceptance', version: '1.0.0' });
      await mcpServer.connect(serverTransport);
      await mcpClient.connect(clientTransport);
    };

    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      if (!mcpClient) throw new Error('Fixture not connected');
      const result = await mcpClient.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
      expect(result.isError, `MCP error from ${name}: ${JSON.stringify(result.content)}`).not.toBe(true);
      const envelope = z.object({
        content: z.array(z.object({ type: z.literal('text'), text: z.string() }).passthrough()).min(1),
      }).passthrough().parse(result);
      return JSON.parse(envelope.content[0]!.text) as unknown;
    };

    await run({
      root,
      dataDir,
      ctx,
      get,
      post,
      sessionFiles,
      notes: async sessionId => {
        const result = await ctx.v2.sessionStore.load(sessionId);
        expect(result.isOk()).toBe(true);
        return result._unsafeUnwrap().events.flatMap(event =>
          event.kind === 'node_output_appended' && event.data.payload.payloadKind === 'notes'
            ? [event.data.payload.notesMarkdown] : []);
      },
      listSessionDirs,
      discoverNewSessionId,
      boot,
      closeMcp,
      call,
    });
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    const cleanupErrors: unknown[] = [];
    const clean = async (work: () => Promise<unknown>) => {
      try { await bounded(work()); } catch (error) { cleanupErrors.push(error); }
    };
    if (unmount) await clean(async () => { unmount!(); });
    await clean(async () => { await closeMcp(); });
    if (server) {
      await clean(async () => {
        await new Promise<void>((resolve, reject) => {
          server!.closeAllConnections();
          server!.close(err => err ? reject(err) : resolve());
        });
      });
    }
    if (!cleanupErrors.length) {
      await clean(async () => { resetContainer(); });
    }
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    vi.mocked(runWorkflow).mockClear();
    if (cleanupErrors.length) {
      priorCleanupFailure = new AggregateError(cleanupErrors, `Cleanup incomplete; retained ${root}`, { cause: primaryError });
      throw priorCleanupFailure;
    }
    if (!primaryError) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Control: legacy console routes and session storage run independently
// ---------------------------------------------------------------------------

it('control: legacy console routes and session storage run independently', () => fixture(async f => {
  const catalog = await f.get('/api/v2/workflows');
  expect(catalog.status).toBe(200);
  expect(catalog.body.data.workflows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'console-preservation', version: '1.0.0' }),
    ]),
  );

  const initialSessions = await f.get('/api/v2/sessions');
  expect(initialSessions.status).toBe(200);
  expect(initialSessions.body.data.sessions).toEqual([]);

  const directoriesBefore = await f.listSessionDirs();
  const dispatched = await f.post('/api/v2/auto/dispatch', {
    workflowId: 'console-preservation',
    goal: 'Control run',
    workspacePath: f.root,
  });
  expect(dispatched.status).toBe(200);
  expect(dispatched.body.data.status).toBe('dispatched');
  const sessionId = asSessionId(dispatched.body.data.sessionHandle);

  expect(await f.discoverNewSessionId(directoriesBefore)).toBe(sessionId);
  const source = vi.mocked(runWorkflow).mock.calls[0]![8];
  if (!source || source.kind !== 'pre_allocated') throw new Error('Missing bound runner handoff');

  const beforeReadEvents = (await f.ctx.v2.sessionStore.load(sessionId))._unsafeUnwrap().events;
  const sessionDetail = await f.get(`/api/v2/sessions/${encodeURIComponent(sessionId)}`);
  expect(sessionDetail.status).toBe(200);
  expect(sessionDetail.body.data.sessionId).toBe(sessionId);

  // Durable store is invariant under read
  expect((await f.ctx.v2.sessionStore.load(sessionId))._unsafeUnwrap().events).toEqual(beforeReadEvents);

  // Complete step with notes and review verdict artifact
  const stepNotes = 'Preserved legacy observations.';
  const artifact = {
    kind: 'wr.review_verdict',
    verdict: 'minor',
    confidence: 'high',
    summary: 'One control finding.',
    findings: [{
      severity: 'minor',
      summary: 'A control finding.',
      findingCategory: 'correctness',
      file: 'control.ts',
      startLine: 1,
      causalLink: { trigger: 'input', effect: 'output' },
      remediation: 'Keep exact data.',
    }],
  };
  const advanced = await handleV2ContinueWorkflow({
    intent: 'advance',
    continueToken: source.session.continueToken,
    output: { notesMarkdown: stepNotes, artifacts: [artifact] },
  }, f.ctx);
  expect(advanced.type).toBe('success');

  const truth = (await f.ctx.v2.sessionStore.load(sessionId))._unsafeUnwrap();
  const noteEvent = truth.events.find(e =>
    e.kind === 'node_output_appended' &&
    e.data.payload.payloadKind === 'notes' &&
    e.data.payload.notesMarkdown === stepNotes,
  );
  expect(noteEvent).toBeDefined();
  if (noteEvent?.kind !== 'node_output_appended') throw new Error('Missing actual note event');

  const nodeDetail = await f.get(`/api/v2/sessions/${encodeURIComponent(sessionId)}/nodes/${encodeURIComponent(noteEvent?.scope?.nodeId ?? '')}`);
  expect(nodeDetail.status).toBe(200);
  expect(nodeDetail.body.data.recapMarkdown).toBe(stepNotes);
  expect(nodeDetail.body.data.artifacts.map((item: { content: unknown }) => item.content)).toEqual([artifact]);

  const completedSession = await f.get(`/api/v2/sessions/${encodeURIComponent(sessionId)}`);
  expect(completedSession.body.data.runs.map((r: { status: string }) => r.status)).toEqual(['complete']);
  expect(completedSession.body.data.metrics?.outcome).toBeNull();

  // Storage remains unchanged after reads; validate shared materialization helper.
  expect((await f.ctx.v2.sessionStore.load(sessionId))._unsafeUnwrap().events).toEqual(truth.events);
  expect(await f.notes(sessionId)).toEqual([stepNotes]);
}));

// ---------------------------------------------------------------------------
// 2. Candidate read projection: reads question, correction, and finished-unknown view
// ---------------------------------------------------------------------------

it('candidate read projection: reads question, correction, and finished-unknown view over HTTP without authority leakage', () => fixture(async f => {
  // Candidate absent: boots candidate profile 'answers' and fails explicitly with bootstrap_unavailable
  await f.boot('answers');

  // The following acceptance assertions remain UNEXERCISED until profile 'answers' is implemented.
  const beforeOpen = await f.listSessionDirs();
  const opened = openedSchema.parse(await f.call('open_work', {
    workflowId: 'answer-notes',
    workspacePath: f.root,
    goal: 'Candidate projection acceptance test.',
  }));
  const initialQuestion = question(opened.view);
  const sessionId = await f.discoverNewSessionId(beforeOpen);

  // Snapshot sessions: ensure non-empty after enrollment
  const snap1 = await f.sessionFiles();
  expect(Object.keys(snap1).length).toBeGreaterThan(0);

  // Read initial question view via HTTP
  const initialAnswerRes = await f.get(`/api/v2/sessions/${encodeURIComponent(sessionId)}/answer`);
  expect(initialAnswerRes.status).toBe(200);
  assertNoReply(initialAnswerRes.body);
  const parsedInitial = candidateAnswerResponseSchema.parse(initialAnswerRes.body);
  expect(parsedInitial.data.view.kind).toBe('question');
  const { reply: initialReply, ...initialInspection } = opened.view;
  expect(parsedInitial.data.view).toEqual(initialInspection);
  expect(await f.sessionFiles()).toEqual(snap1);

  // Submit invalid submission -> emits correction question retaining rejected receipt
  const rejected = recordedSchema.parse(await f.call('answer_work', {
    reply: initialQuestion.reply,
    answer: { notes: 12345 },
  }));
  expect(rejected.disposition).toBe('rejected');
  const correctionQuestion = question(rejected.view);

  const snap2 = await f.sessionFiles();
  expect(Object.keys(snap2).length).toBeGreaterThan(0);

  const correctionAnswerRes = await f.get(`/api/v2/sessions/${encodeURIComponent(sessionId)}/answer`);
  expect(correctionAnswerRes.status).toBe(200);
  assertNoReply(correctionAnswerRes.body);
  const parsedCorrection = candidateAnswerResponseSchema.parse(correctionAnswerRes.body);
  expect(parsedCorrection.data.view.kind).toBe('question');
  const { reply: correctionReply, ...correctionInspection } = rejected.view;
  expect(parsedCorrection.data.view).toEqual(correctionInspection);
  if (parsedCorrection.data.view.kind === 'question') {
    expect(parsedCorrection.data.view.issues.length).toBeGreaterThan(0);
    expect(parsedCorrection.data.view.retained).toEqual(
      expect.arrayContaining([expect.objectContaining({ receipt: rejected.receipt })]),
    );
  }
  expect(await f.sessionFiles()).toEqual(snap2);

  // Complete both steps with valid notes
  const firstValid = recordedSchema.parse(await f.call('answer_work', {
    reply: correctionQuestion.reply,
    answer: { notes: 'First valid observation.' },
  }));
  expect(firstValid.disposition).toBe('accepted');
  const secondQuestion = question(firstValid.view);

  const secondValid = recordedSchema.parse(await f.call('answer_work', {
    reply: secondQuestion.reply,
    answer: { notes: 'Second valid observation.' },
  }));
  expect(secondValid.disposition).toBe('accepted');
  expect(secondValid.view.kind).toBe('finished');

  const snap3 = await f.sessionFiles();
  expect(Object.keys(snap3).length).toBeGreaterThan(0);

  // Finished session without reported task outcome projects taskOutcome === 'unknown'
  const finishedAnswerRes = await f.get(`/api/v2/sessions/${encodeURIComponent(sessionId)}/answer`);
  expect(finishedAnswerRes.status).toBe(200);
  assertNoReply(finishedAnswerRes.body);
  const parsedFinished = candidateAnswerResponseSchema.parse(finishedAnswerRes.body);
  expect(parsedFinished.data.view.kind).toBe('finished');
  const { reply: terminalReply, ...terminalInspection } = secondValid.view;
  expect(parsedFinished.data.view).toEqual(terminalInspection);
  if (parsedFinished.data.view.kind === 'finished') {
    expect(parsedFinished.data.view.taskOutcome).toBe('unknown');
    expect(parsedFinished.data.view.execution.kind).toBe('completed');
  }
  expect(await f.sessionFiles()).toEqual(snap3);

  // Verify exact materialized notes from durable events
  expect(await f.notes(sessionId)).toEqual(['First valid observation.', 'Second valid observation.']);
}));

// ---------------------------------------------------------------------------
// 3. Candidate receipt reading: reconstructs exact rejected >=8192-byte payload
// ---------------------------------------------------------------------------

it('candidate receipt reading: reconstructs exact rejected >=8192-byte payload with bounded pages and cursor refusal', () => fixture(async f => {
  // Candidate absent: fails explicitly with bootstrap_unavailable
  await f.boot('answers');

  // The following acceptance assertions remain UNEXERCISED until candidate runtime is available.
  const beforeOpen = await f.listSessionDirs();
  const opened = openedSchema.parse(await f.call('open_work', {
    workflowId: 'answer-notes',
    workspacePath: f.root,
    goal: 'Exact receipt paging acceptance test.',
  }));
  const pending = question(opened.view);
  const sessionId = await f.discoverNewSessionId(beforeOpen);

  // Multibyte string > 8192 UTF-8 bytes with numeric notes (domain-invalid JSON)
  const multibyteChunk = '日本語テスト文字とアクセントéàçüö';
  const largeMultibyteText = multibyteChunk.repeat(200); // 9,800 UTF-8 bytes
  const invalidPayload = {
    notes: 12345,
    unknownPayloadData: largeMultibyteText,
  };
  expect(Buffer.byteLength(JSON.stringify(invalidPayload), 'utf8')).toBeGreaterThan(8192);

  const rejected = recordedSchema.parse(await f.call('answer_work', {
    reply: pending.reply,
    answer: invalidPayload,
  }));
  expect(rejected.disposition).toBe('rejected');
  const receipt = rejected.receipt;

  const snapBefore = await f.sessionFiles();
  expect(Object.keys(snapBefore).length).toBeGreaterThan(0);

  // Read initial page
  const page0Res = await f.get(`/api/v2/sessions/${encodeURIComponent(sessionId)}/answer/receipts/${encodeURIComponent(receipt)}`);
  expect(page0Res.status).toBe(200);
  assertNoReply(page0Res.body);
  const parsedPage0 = candidateReceiptResponseSchema.parse(page0Res.body);
  expect(parsedPage0.data.page.kind).toBe('more');
  expect(Buffer.byteLength(parsedPage0.data.page.chunk, 'utf8')).toBeLessThanOrEqual(4096);
  if (parsedPage0.data.page.kind !== 'more') throw new Error('Expected a paged receipt');
  const rightfulCursor = parsedPage0.data.page.next;
  expect(parsedPage0.data.sessionId).toBe(sessionId);
  expect(parsedPage0.data.receipt).toBe(receipt);
  expect(parsedPage0.data.page.receipt).toBe(receipt);
  expect(parsedPage0.data.page.disposition).toBe('rejected');
  expect(parsedPage0.data.page.encoding).toBe('canonical_json');
  expect(await f.sessionFiles()).toEqual(snapBefore);

  // Corrupted cursor refusal with STRICT refusal body
  const corruptedRes = await f.get(`/api/v2/sessions/${encodeURIComponent(sessionId)}/answer/receipts/${encodeURIComponent(receipt)}?cursor=${encodeURIComponent('corrupted-cursor-token')}`);
  expect(corruptedRes.status).toBe(403);
  assertNoReply(corruptedRes.body);
  const refused = candidateRefusalSchema.parse(corruptedRes.body);
  expect(refused.outcome.reason).toBe('invalid_scope');
  expect(refused.outcome.sessionId).toBe(sessionId);
  expect(refused.outcome.receipt).toBe(receipt);
  expect(await f.sessionFiles()).toEqual(snapBefore);

  // Resume with rightful cursor and drain remaining pages
  const drained = await drainHttpReceipt(async path => {
    const result = await f.get(path);
    expect(await f.sessionFiles()).toEqual(snapBefore);
    return result;
  }, sessionId, receipt, { initialCursor: rightfulCursor });
  expect(drained.pages.length).toBeGreaterThanOrEqual(2);
  const allPages = [parsedPage0.data.page, ...drained.pages];
  expect(allPages.length).toBeGreaterThanOrEqual(3);
  for (const page of allPages) {
    expect(page.receipt).toBe(receipt);
    expect(page.disposition).toBe('rejected');
    expect(page.encoding).toBe('canonical_json');
  }

  const fullReassembled = parsedPage0.data.page.chunk + drained.reassembled;
  const parsedPayload = JSON.parse(fullReassembled);
  expect(parsedPayload).toEqual(invalidPayload);

  // Disk session files remain unchanged after all reads
  expect(await f.sessionFiles()).toEqual(snapBefore);
}));

// ---------------------------------------------------------------------------
// 4. Candidate scope: reports legacy session as not_enrolled using actual dispatched session
// ---------------------------------------------------------------------------

it('candidate scope: reports legacy session as not_enrolled using actual dispatched session', () => fixture(async f => {
  // Candidate absent: fails explicitly with bootstrap_unavailable
  await f.boot('answers');

  // The following acceptance assertions remain UNEXERCISED until candidate runtime is available.
  // Dispatch an actual legacy session through the real dispatch endpoint
  const dispatched = await f.post('/api/v2/auto/dispatch', {
    workflowId: 'console-preservation',
    goal: 'Legacy enrollment verification',
    workspacePath: f.root,
  });
  expect(dispatched.status).toBe(200);
  const legacySessionId = asSessionId(dispatched.body.data.sessionHandle);

  const snapBefore = await f.sessionFiles();
  expect(Object.keys(snapBefore).length).toBeGreaterThan(0);

  const notEnrolledRes = await f.get(`/api/v2/sessions/${encodeURIComponent(legacySessionId)}/answer`);
  expect(notEnrolledRes.status).toBe(409);
  assertNoReply(notEnrolledRes.body);
  expect(notEnrolledRes.body).toMatchObject({
    success: false,
    outcome: {
      kind: 'not_enrolled',
      sessionId: legacySessionId,
      reason: 'legacy_workflow',
    },
  });

  // Storage remains invariant under read
  expect(await f.sessionFiles()).toEqual(snapBefore);
}));

// ---------------------------------------------------------------------------
// 5. Candidate HTTP cross-scope: receipt and cursor isolation across unbound sessions
// ---------------------------------------------------------------------------

it('candidate HTTP cross-scope: receipt and cursor isolation across unbound sessions', () => fixture(async f => {
  // Candidate absent: boots candidate profile 'answers' and fails explicitly with bootstrap_unavailable
  await f.boot('answers');

  // The following acceptance assertions remain UNEXERCISED until profile 'answers' is implemented.
  const beforeOpenA = await f.listSessionDirs();
  const openedA = openedSchema.parse(await f.call('open_work', {
    workflowId: 'answer-notes',
    workspacePath: f.root,
    goal: 'Cross-scope isolation session A',
  }));
  const pendingA = question(openedA.view);
  const sessionIdA = await f.discoverNewSessionId(beforeOpenA);

  const beforeOpenB = await f.listSessionDirs();
  const openedB = openedSchema.parse(await f.call('open_work', {
    workflowId: 'answer-notes',
    workspacePath: f.root,
    goal: 'Cross-scope isolation session B',
  }));
  const pendingB = question(openedB.view);
  const sessionIdB = await f.discoverNewSessionId(beforeOpenB);
  expect(sessionIdA).not.toBe(sessionIdB);

  // Multibyte payloads > 8192 UTF-8 bytes with distinct contents
  const chunkA = 'セッションAテストデータ日本語文字éàçüö';
  const payloadA = {
    notes: 11111,
    sessionTag: 'session-A-isolated-payload',
    body: chunkA.repeat(200),
  };
  expect(Buffer.byteLength(JSON.stringify(payloadA), 'utf8')).toBeGreaterThan(8192);

  const chunkB = 'セッションBテストデータ異体字カタカナñáíóú';
  const payloadB = {
    notes: 22222,
    sessionTag: 'session-B-isolated-payload',
    body: chunkB.repeat(200),
  };
  expect(Buffer.byteLength(JSON.stringify(payloadB), 'utf8')).toBeGreaterThan(8192);

  const rejectedA = recordedSchema.parse(await f.call('answer_work', {
    reply: pendingA.reply,
    answer: payloadA,
  }));
  expect(rejectedA.disposition).toBe('rejected');
  const receiptA = rejectedA.receipt;
  const correctionQuestionA = question(rejectedA.view);

  const rejectedB = recordedSchema.parse(await f.call('answer_work', {
    reply: pendingB.reply,
    answer: payloadB,
  }));
  expect(rejectedB.disposition).toBe('rejected');
  const receiptB = rejectedB.receipt;
  const correctionQuestionB = question(rejectedB.view);
  expect(receiptA).not.toBe(receiptB);

  const snapBefore = await f.sessionFiles();
  expect(Object.keys(snapBefore).length).toBeGreaterThan(0);

  // Read initial page for Session A
  const page0ResA = await f.get(`/api/v2/sessions/${encodeURIComponent(sessionIdA)}/answer/receipts/${encodeURIComponent(receiptA)}`);
  expect(page0ResA.status).toBe(200);
  assertNoReply(page0ResA.body);
  const parsedPage0A = candidateReceiptResponseSchema.parse(page0ResA.body);
  expect(parsedPage0A.data.sessionId).toBe(sessionIdA);
  expect(parsedPage0A.data.receipt).toBe(receiptA);
  expect(parsedPage0A.data.page.receipt).toBe(receiptA);
  expect(parsedPage0A.data.page.disposition).toBe('rejected');
  expect(parsedPage0A.data.page.encoding).toBe('canonical_json');
  expect(parsedPage0A.data.page.kind).toBe('more');
  expect(Buffer.byteLength(parsedPage0A.data.page.chunk, 'utf8')).toBeLessThanOrEqual(4096);
  if (parsedPage0A.data.page.kind !== 'more') throw new Error('Expected paged receipt for session A');
  const rightfulCursorA = parsedPage0A.data.page.next;
  expect(await f.sessionFiles()).toEqual(snapBefore);

  // Read initial page for Session B
  const page0ResB = await f.get(`/api/v2/sessions/${encodeURIComponent(sessionIdB)}/answer/receipts/${encodeURIComponent(receiptB)}`);
  expect(page0ResB.status).toBe(200);
  assertNoReply(page0ResB.body);
  const parsedPage0B = candidateReceiptResponseSchema.parse(page0ResB.body);
  expect(parsedPage0B.data.sessionId).toBe(sessionIdB);
  expect(parsedPage0B.data.receipt).toBe(receiptB);
  expect(parsedPage0B.data.page.receipt).toBe(receiptB);
  expect(parsedPage0B.data.page.disposition).toBe('rejected');
  expect(parsedPage0B.data.page.encoding).toBe('canonical_json');
  expect(parsedPage0B.data.page.kind).toBe('more');
  expect(Buffer.byteLength(parsedPage0B.data.page.chunk, 'utf8')).toBeLessThanOrEqual(4096);
  if (parsedPage0B.data.page.kind !== 'more') throw new Error('Expected paged receipt for session B');
  const rightfulCursorB = parsedPage0B.data.page.next;
  expect(await f.sessionFiles()).toEqual(snapBefore);

  // Check 1: sessionA + receiptB strictly refused 403 invalid_scope
  const crossReceiptResA = await f.get(`/api/v2/sessions/${encodeURIComponent(sessionIdA)}/answer/receipts/${encodeURIComponent(receiptB)}`);
  expect(crossReceiptResA.status).toBe(403);
  assertNoReply(crossReceiptResA.body);
  const refusedCrossReceiptA = candidateRefusalSchema.parse(crossReceiptResA.body);
  expect(refusedCrossReceiptA.outcome.reason).toBe('invalid_scope');
  expect(refusedCrossReceiptA.outcome.sessionId).toBe(sessionIdA);
  expect(refusedCrossReceiptA.outcome.receipt).toBe(receiptB);
  expect(await f.sessionFiles()).toEqual(snapBefore);

  // Reciprocal: sessionB + receiptA strictly refused 403 invalid_scope
  const crossReceiptResB = await f.get(`/api/v2/sessions/${encodeURIComponent(sessionIdB)}/answer/receipts/${encodeURIComponent(receiptA)}`);
  expect(crossReceiptResB.status).toBe(403);
  assertNoReply(crossReceiptResB.body);
  const refusedCrossReceiptB = candidateRefusalSchema.parse(crossReceiptResB.body);
  expect(refusedCrossReceiptB.outcome.reason).toBe('invalid_scope');
  expect(refusedCrossReceiptB.outcome.sessionId).toBe(sessionIdB);
  expect(refusedCrossReceiptB.outcome.receipt).toBe(receiptA);
  expect(await f.sessionFiles()).toEqual(snapBefore);

  // Check 2: sessionA + receiptA + cursorB strictly refused 403 invalid_scope
  const crossCursorResA = await f.get(`/api/v2/sessions/${encodeURIComponent(sessionIdA)}/answer/receipts/${encodeURIComponent(receiptA)}?cursor=${encodeURIComponent(rightfulCursorB)}`);
  expect(crossCursorResA.status).toBe(403);
  assertNoReply(crossCursorResA.body);
  const refusedCrossCursorA = candidateRefusalSchema.parse(crossCursorResA.body);
  expect(refusedCrossCursorA.outcome.reason).toBe('invalid_scope');
  expect(refusedCrossCursorA.outcome.sessionId).toBe(sessionIdA);
  expect(refusedCrossCursorA.outcome.receipt).toBe(receiptA);
  expect(await f.sessionFiles()).toEqual(snapBefore);

  // Reciprocal: sessionB + receiptB + cursorA strictly refused 403 invalid_scope
  const crossCursorResB = await f.get(`/api/v2/sessions/${encodeURIComponent(sessionIdB)}/answer/receipts/${encodeURIComponent(receiptB)}?cursor=${encodeURIComponent(rightfulCursorA)}`);
  expect(crossCursorResB.status).toBe(403);
  assertNoReply(crossCursorResB.body);
  const refusedCrossCursorB = candidateRefusalSchema.parse(crossCursorResB.body);
  expect(refusedCrossCursorB.outcome.reason).toBe('invalid_scope');
  expect(refusedCrossCursorB.outcome.sessionId).toBe(sessionIdB);
  expect(refusedCrossCursorB.outcome.receipt).toBe(receiptB);
  expect(await f.sessionFiles()).toEqual(snapBefore);

  // Resume original rightful cursors and reassemble both payloads
  const drainedA = await drainHttpReceipt(async path => {
    const result = await f.get(path);
    expect(await f.sessionFiles()).toEqual(snapBefore);
    return result;
  }, sessionIdA, receiptA, { initialCursor: rightfulCursorA });
  const allPagesA = [parsedPage0A.data.page, ...drainedA.pages];
  expect(allPagesA.length).toBeGreaterThanOrEqual(3);
  for (const page of allPagesA) {
    expect(page.receipt).toBe(receiptA);
    expect(page.disposition).toBe('rejected');
    expect(page.encoding).toBe('canonical_json');
    expect(Buffer.byteLength(page.chunk, 'utf8')).toBeLessThanOrEqual(4096);
  }
  const fullReassembledA = parsedPage0A.data.page.chunk + drainedA.reassembled;
  expect(JSON.parse(fullReassembledA)).toEqual(payloadA);
  expect(await f.sessionFiles()).toEqual(snapBefore);

  const drainedB = await drainHttpReceipt(async path => {
    const result = await f.get(path);
    expect(await f.sessionFiles()).toEqual(snapBefore);
    return result;
  }, sessionIdB, receiptB, { initialCursor: rightfulCursorB });
  const allPagesB = [parsedPage0B.data.page, ...drainedB.pages];
  expect(allPagesB.length).toBeGreaterThanOrEqual(3);
  for (const page of allPagesB) {
    expect(page.receipt).toBe(receiptB);
    expect(page.disposition).toBe('rejected');
    expect(page.encoding).toBe('canonical_json');
    expect(Buffer.byteLength(page.chunk, 'utf8')).toBeLessThanOrEqual(4096);
  }
  const fullReassembledB = parsedPage0B.data.page.chunk + drainedB.reassembled;
  expect(JSON.parse(fullReassembledB)).toEqual(payloadB);
  expect(await f.sessionFiles()).toEqual(snapBefore);

  // Complete both workflows via MCP using original correction capabilities
  const valid1A = recordedSchema.parse(await f.call('answer_work', {
    reply: correctionQuestionA.reply,
    answer: { notes: 'Session A observation one.' },
  }));
  expect(valid1A.disposition).toBe('accepted');
  const valid2A = recordedSchema.parse(await f.call('answer_work', {
    reply: question(valid1A.view).reply,
    answer: { notes: 'Session A observation two.' },
  }));
  expect(valid2A.disposition).toBe('accepted');
  expect(valid2A.view.kind).toBe('finished');

  const valid1B = recordedSchema.parse(await f.call('answer_work', {
    reply: correctionQuestionB.reply,
    answer: { notes: 'Session B observation one.' },
  }));
  expect(valid1B.disposition).toBe('accepted');
  const valid2B = recordedSchema.parse(await f.call('answer_work', {
    reply: question(valid1B.view).reply,
    answer: { notes: 'Session B observation two.' },
  }));
  expect(valid2B.disposition).toBe('accepted');
  expect(valid2B.view.kind).toBe('finished');

  // Verify exact durable notes per session, proving reads/refusals did not consume work
  expect(await f.notes(sessionIdA)).toEqual(['Session A observation one.', 'Session A observation two.']);
  expect(await f.notes(sessionIdB)).toEqual(['Session B observation one.', 'Session B observation two.']);
}));

// ---------------------------------------------------------------------------
// 6. Candidate storage degradation acceptance: parameterized real persisted session cases
// ---------------------------------------------------------------------------

const degradationCases = [
  {
    kind: 'missing' as const,
    expectedStatus: 404,
    expectedReason: 'missing' as const,
  },
  {
    kind: 'corrupt' as const,
    expectedStatus: 422,
    expectedReason: 'corrupt' as const,
    diagnosticCode: 'digest_mismatch' as const,
  },
  {
    kind: 'unsupported_version' as const,
    expectedStatus: 422,
    expectedReason: 'unsupported_version' as const,
    diagnosticCode: 'unknown_schema_version' as const,
  },
  {
    kind: 'storage_unavailable' as const,
    expectedStatus: 503,
    expectedReason: 'storage_unavailable' as const,
  },
] as const;

it.each(degradationCases)(
  'candidate storage degradation acceptance ($kind): refuses mounted answer with $expectedReason and restores positive control',
  (c) => fixture(async f => {
    // Candidate absent: boots candidate profile 'answers' and fails explicitly with bootstrap_unavailable
    await f.boot('answers');

    // The following acceptance assertions remain UNEXERCISED until profile 'answers' is implemented.
    const beforeOpen = await f.listSessionDirs();
    const opened = openedSchema.parse(await f.call('open_work', {
      workflowId: 'answer-notes',
      workspacePath: f.root,
      goal: `Storage degradation acceptance probe for ${c.kind}`,
    }));
    const initialQuestion = question(opened.view);
    const sessionId = await f.discoverNewSessionId(beforeOpen);

    // Turn 1: Real MCP creates accepted notes
    const note1 = 'Candidate first observation notes.';
    const firstValid = recordedSchema.parse(await f.call('answer_work', {
      reply: initialQuestion.reply,
      answer: { notes: note1 },
    }));
    expect(firstValid.disposition).toBe('accepted');
    const receipt1 = firstValid.receipt;
    const step2Question = question(firstValid.view);

    // Real MCP closes cleanly before storage mutation
    await f.closeMcp();

    // Validate manifest digest bytes and relative path containment before mutating; no garbage orphan fixture
    const { manifestPath, manifestRaw, targetSeg, targetSegPath } = await locateCommittedSegment(f.dataDir, f.root, sessionId);
    const pristineSegBytes = Buffer.from(await readFile(targetSegPath));
    const pristineManifest = manifestRaw;

    const sessionDir = f.dataDir.sessionDir(sessionId);
    let cleanupMutation: (() => Promise<void>) | undefined;

    try {
      if (c.kind === 'missing') {
        // Missing means selected session journal absent, must not create empty
        const backupDir = join(f.root, `backup-session-${sessionId}`);
        await rename(sessionDir, backupDir);
        cleanupMutation = async () => {
          if (existsSync(sessionDir)) await rm(sessionDir, { recursive: true, force: true });
          await rename(backupDir, sessionDir);
        };
      } else if (c.kind === 'corrupt') {
        // Mutate attested bytes without updating manifest -> exact digest mismatch
        const corruptBytes = Buffer.from(pristineSegBytes);
        corruptBytes[0] = corruptBytes[0]! ^ 0xff;
        await writeFile(targetSegPath, corruptBytes);
        cleanupMutation = async () => {
          await writeFile(targetSegPath, pristineSegBytes);
          await writeFile(manifestPath, pristineManifest);
        };
      } else if (c.kind === 'unsupported_version') {
        // Update documented v discriminator in segment to unsupported version 99 with consistent digest
        const segLines = pristineSegBytes.toString('utf8').trim().split('\n');
        const evtObj = JSON.parse(segLines[0]!);
        expect(evtObj.v).toBe(1);
        evtObj.v = 99;
        segLines[0] = JSON.stringify(evtObj);
        const verSegBytes = Buffer.from(segLines.join('\n') + '\n', 'utf8');
        await writeFile(targetSegPath, verSegBytes);

        const newHash = 'sha256:' + createHash('sha256').update(verSegBytes).digest('hex');
        const verManifest = pristineManifest.trim().split('\n').filter(Boolean).map(l => {
          const r = JSON.parse(l);
          if (r.kind === 'segment_closed' && r.segmentRelPath === targetSeg.segmentRelPath) {
            return JSON.stringify({ ...r, sha256: newHash, bytes: verSegBytes.length });
          }
          return l;
        }).join('\n') + '\n';
        await writeFile(manifestPath, verManifest);
        cleanupMutation = async () => {
          await writeFile(targetSegPath, pristineSegBytes);
          await writeFile(manifestPath, pristineManifest);
        };
      } else if (c.kind === 'storage_unavailable') {
        // Keep the manifest readable and obstruct its committed segment. Replacing
        // an ancestor directory with a file reports ENOENT on Windows, which tests
        // missing storage instead of an unreadable committed journal.
        const backupSegment = join(f.root, `backup-obstruct-${sessionId}`);
        await rename(targetSegPath, backupSegment);
        await mkdir(targetSegPath);
        cleanupMutation = async () => {
          await rm(targetSegPath, { recursive: true, force: true });
          await rename(backupSegment, targetSegPath);
        };
      }

      // Positive diagnostic using actual source reader
      if ('diagnosticCode' in c && c.diagnosticCode === 'digest_mismatch') {
        const loadCorrupt = await f.ctx.v2.sessionStore.load(sessionId);
        expect(loadCorrupt.isErr()).toBe(true);
        if (loadCorrupt.isErr()) expect(loadCorrupt.error.code).toBe('SESSION_STORE_CORRUPTION_DETECTED');
        if (loadCorrupt.isErr() && loadCorrupt.error.code === 'SESSION_STORE_CORRUPTION_DETECTED') {
          expect(loadCorrupt.error.reason.code).toBe('digest_mismatch');
        }
      } else if ('diagnosticCode' in c && c.diagnosticCode === 'unknown_schema_version') {
        const loadVer = await f.ctx.v2.sessionStore.load(sessionId);
        expect(loadVer.isErr()).toBe(true);
        if (loadVer.isErr()) expect(loadVer.error.code).toBe('SESSION_STORE_CORRUPTION_DETECTED');
        if (loadVer.isErr() && loadVer.error.code === 'SESSION_STORE_CORRUPTION_DETECTED') {
          expect(loadVer.error.reason.code).toBe('unknown_schema_version');
        }
      }

      // Storage files snapshot before read: ensures exact unchanged bytes during reads
      const snapBefore = await f.sessionFiles();

      // Mount actual route GET /api/v2/sessions/:sessionId/answer
      const degradedRes = await f.get(`/api/v2/sessions/${encodeURIComponent(sessionId)}/answer`);

      // Assert HTTP status mapping
      expect(degradedRes.status).toBe(c.expectedStatus);

      // Assert no reply, recovery, or owner authority
      assertNoReply(degradedRes.body);

      // Assert strict failure DTO
      const failure = candidateUnavailableSchema.parse(degradedRes.body);
      expect(failure.success).toBe(false);
      expect(failure.outcome.kind).toBe('unavailable');
      expect(failure.outcome.sessionId).toBe(sessionId);
      expect(failure.outcome.reason).toBe(c.expectedReason);

      // Missing means selected session journal absent, must not create empty
      if (c.kind === 'missing') {
        const dirsAfter = await f.listSessionDirs();
        expect(dirsAfter.has(String(sessionId)), 'Missing session read must not create empty directory').toBe(false);
      }

      // Storage bytes must remain exactly unchanged during reads
      const snapAfter = await f.sessionFiles();
      expect(snapAfter).toEqual(snapBefore);
    } finally {
      // Restore original data
      if (cleanupMutation) {
        await cleanupMutation();
      }
    }

    // Restore verification: mounted answer reads exact retained receipt + notes
    const restoredRes = await f.get(`/api/v2/sessions/${encodeURIComponent(sessionId)}/answer`);
    expect(restoredRes.status).toBe(200);
    assertNoReply(restoredRes.body);
    const parsedRestored = candidateAnswerResponseSchema.parse(restoredRes.body);
    expect(parsedRestored.data.sessionId).toBe(sessionId);
    expect(parsedRestored.data.view.kind).toBe('question');
    if (parsedRestored.data.view.kind === 'question') {
      expect(parsedRestored.data.view.retained).toEqual(
        expect.arrayContaining([expect.objectContaining({ receipt: receipt1 })]),
      );
    }

    const restoredSnapshot = await f.sessionFiles();
    const restoredReceipt = await drainHttpReceipt(f.get, sessionId, receipt1);
    expect(JSON.parse(restoredReceipt.reassembled)).toEqual({ notes: note1 });
    expect(restoredReceipt.pages.every(page => page.disposition === 'accepted')).toBe(true);
    expect(await f.sessionFiles()).toEqual(restoredSnapshot);

    // Require real MCP completion with both notes
    await f.boot('answers');
    const note2 = 'Candidate second observation notes completing session.';
    const secondValid = recordedSchema.parse(await f.call('answer_work', {
      reply: step2Question.reply,
      answer: { notes: note2 },
    }));
    expect(secondValid.disposition).toBe('accepted');
    expect(secondValid.view.kind).toBe('finished');

    // Confirm both notes are durably persisted
    expect(await f.notes(sessionId)).toEqual([note1, note2]);
  }),
);
