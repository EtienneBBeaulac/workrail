import 'reflect-metadata';
import { loadNotesBaseline } from './notes-baseline.js';
import { expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ARTIFACT_CONTRACT_REFS } from '../../src/v2/durable-core/schemas/artifacts/index.js';

const serverModulePath = '../../src/mcp/server.js';
const containerModulePath = '../../src/di/container.js';

type ComposedServerLike = {
  server: {
    connect: (transport: unknown) => Promise<void>;
    close: () => Promise<void>;
  };
};

let resetContainerFn: (() => void) | undefined;

const viewSchema = z.object({ kind: z.string(), read: z.string(), reply: z.string().optional() }).passthrough();
const recordedSchema = z.object({ kind: z.literal('recorded'), receipt: z.string(),
  disposition: z.enum(['accepted', 'partial', 'rejected']), view: viewSchema }).passthrough();
const openedSchema = z.object({ kind: z.literal('opened'), recovery: z.string(), view: viewSchema }).passthrough();
const evidencePageCompleteSchema = z.object({
  kind: z.literal('complete'),
  receipt: z.string(),
  disposition: z.enum(['accepted', 'partial', 'rejected']),
  encoding: z.enum(['canonical_json', 'raw_utf8']),
  chunk: z.string(),
}).strict();

const evidencePageMoreSchema = z.object({
  kind: z.literal('more'),
  receipt: z.string(),
  disposition: z.enum(['accepted', 'partial', 'rejected']),
  encoding: z.enum(['canonical_json', 'raw_utf8']),
  chunk: z.string(),
  next: z.string().min(1),
}).strict();

const evidenceRefusedSchema = z.object({
  kind: z.literal('refused'),
  reason: z.enum(['invalid_scope', 'corrupt', 'storage_unavailable', 'bound_session_required']),
}).strict();

const evidenceReadSchema = z.discriminatedUnion('kind', [
  evidencePageCompleteSchema,
  evidencePageMoreSchema,
  evidenceRefusedSchema,
]);

type EvidencePageResult = z.infer<typeof evidencePageCompleteSchema> | z.infer<typeof evidencePageMoreSchema>;

async function drainReceipt(
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  read: string,
  receipt: string,
  options?: {
    initialCursor?: string;
    onFirstNextPage?: () => Promise<void>;
  },
): Promise<{
  pages: EvidencePageResult[];
  reassembled: string;
}> {
  const pages: EvidencePageResult[] = [];
  const seenCursors = new Set<string>();
  let currentCursor = options?.initialCursor;
  let reassembled = '';
  let expectedEncoding: 'canonical_json' | 'raw_utf8' | undefined = undefined;
  let expectedDisposition: 'accepted' | 'partial' | 'rejected' | undefined;
  const maxIterations = 20;

  for (let i = 0; i < maxIterations; i++) {
    if (currentCursor !== undefined) {
      expect(seenCursors.has(currentCursor), 'Cursor must not repeat (infinite loop prevention)').toBe(false);
      seenCursors.add(currentCursor);
    }
    if (i === 1 && options?.onFirstNextPage) {
      await options.onFirstNextPage();
    }
    const readResultRaw = await call('inspect_work', {
      read,
      receipt,
      ...(currentCursor !== undefined ? { cursor: currentCursor } : {}),
    });
    assertNoReply(readResultRaw);
    const page = evidenceReadSchema.parse(readResultRaw);
    if (page.kind === 'refused') {
      throw new Error(`Receipt read unexpectedly refused: ${page.reason}`);
    }
    expect(page.receipt).toBe(receipt);
    if (expectedDisposition === undefined) expectedDisposition = page.disposition;
    else expect(page.disposition).toBe(expectedDisposition);
    if (expectedEncoding === undefined) {
      expectedEncoding = page.encoding;
    } else {
      expect(page.encoding, 'Encoding must remain consistent across pages').toBe(expectedEncoding);
    }

    const chunkByteLength = Buffer.byteLength(page.chunk, 'utf8');
    expect(chunkByteLength).toBeLessThanOrEqual(4096);
    reassembled += page.chunk;
    pages.push(page);

    if (page.kind === 'more') {
      expect(chunkByteLength).toBeGreaterThan(0);
      currentCursor = page.next;
    } else {
      currentCursor = undefined;
      break;
    }
  }

  expect(currentCursor, 'Paging traversal must terminate within max iterations').toBeUndefined();
  return { pages, reassembled };
}
const question = (raw: unknown) => {
  const view = viewSchema.parse(raw);
  expect(view.kind).toBe('question');
  return z.object({ reply: z.string().min(1), read: z.string().min(1), instruction: z.string().min(1) }).passthrough().parse(view);
};
const assertNoReply = (raw: unknown): void => {
  if (raw && typeof raw === 'object') {
    expect(Object.hasOwn(raw, 'reply'), 'Read projections cannot mint reply authority').toBe(false);
    expect(Object.hasOwn(raw, 'recovery'), 'Read projections cannot mint worker recovery authority').toBe(false);
    for (const value of Object.values(raw)) assertNoReply(value);
  }
};
const unsupportedContracts = ARTIFACT_CONTRACT_REFS.filter(ref => ref !== 'wr.contracts.review_verdict');
const contractWorkflowId = (ref: string) => 'answer-unsupported-' + ref.split('.').at(-1)!.replaceAll('_', '-');
const unsupportedWorkflows = [...unsupportedContracts.map(contractWorkflowId),
  'answer-unsupported-loop', 'answer-unsupported-human-gate', 'answer-unsupported-evaluator-gate',
  'answer-unsupported-condition', 'answer-unsupported-delegation'];

const findingWithCategory = { severity: 'minor', summary: 'A retained finding with category', findingCategory: 'correctness',
  file: 'sample.ts', startLine: 8, remediation: 'Retain this enrichment.' } as const;
const findingWithoutCategory = { severity: 'minor', summary: 'A secondary finding with optional category absent',
  file: 'lib.ts', startLine: 42, causalLink: 'Missing guard allows undefined property access.',
  remediation: 'Check boundary before property access.' } as const;
const completeReview = { kind: 'wr.review_verdict', verdict: 'minor', confidence: 'high',
  findings: [findingWithCategory, findingWithoutCategory], summary: 'One actionable issue and one secondary note.' };

async function fixture(run: (f: {
  root: string; boot: (profile: 'notes' | 'answers') => Promise<void>;
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  journal: () => Promise<Record<string, string>>;
  artifacts: () => Promise<unknown[]>;
  notes: () => Promise<string[]>;
  sessionFiles: () => Promise<Record<string, string>>;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'workrail-answer-acceptance-'));
  const envKeys = ['WORKRAIL_DATA_DIR', 'WORKFLOW_STORAGE_PATH', 'WORKRAIL_ENABLE_V2_TOOLS',
    'WORKRAIL_ENABLE_SESSION_TOOLS', 'WORKRAIL_AGENT_PROFILE', 'WORKRAIL_KEYS_DIR'] as const;
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  let client: Client | undefined;
  let server: ComposedServerLike['server'] | undefined;
  const close = async () => {
    try { await client?.close(); } finally {
      client = undefined;
      try { await server?.close(); } finally { server = undefined; resetContainerFn?.(); }
    }
  };
  const journal = async (directory = root): Promise<Record<string, string>> => {
    const result: Record<string, string> = {};
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) Object.assign(result, await journal(path));
      else if (path.includes('/sessions/') && entry.name.endsWith('.jsonl')) result[path] = await readFile(path, 'utf8');
    }
    return result;
  };
  const sessionFiles = async (directory = root): Promise<Record<string, string>> => {
    const result: Record<string, string> = {};
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const inSessions = path.includes('/sessions/') || path.endsWith('/sessions');
      if (entry.isDirectory()) {
        if (inSessions) result[path] = '<directory>';
        Object.assign(result, await sessionFiles(path));
      } else if (inSessions) result[path] = (await readFile(path)).toString('base64');
    }
    return result;
  };
  try {
    const workflows = join(root, 'workflows');
    await mkdir(workflows);
    for (const [id, steps] of [
      ['answer-notes', [{ id: 'first', title: 'First', prompt: 'Record the first observation.' },
        { id: 'second', title: 'Second', prompt: 'Record the second observation.' }]],
      ['answer-review', [{ id: 'review', title: 'Review', prompt: 'Review the change.',
        outputContract: { contractRef: 'wr.contracts.review_verdict' } }]],
      ...unsupportedContracts.map(contractRef => [contractWorkflowId(contractRef), [
        { id: 'first', title: 'First', prompt: 'An ordinary step before the unsupported feature.' },
        { id: 'structured', title: 'Structured', prompt: 'Produce the declared structured result.',
          outputContract: { contractRef } }]] as const),
      ['answer-unsupported-loop', [
        { id: 'first', title: 'First', prompt: 'An ordinary step before the unsupported feature.' },
        { id: 'repeat', type: 'loop', title: 'Repeat', loop: { type: 'while', maxIterations: 2, conditionSource: { kind: 'artifact_contract', contractRef: 'wr.contracts.loop_control', loopId: 'repeat' } },
          body: [{ id: 'body', title: 'Body', prompt: 'Record work.' }] }]],
      ...(['human_approval', 'coordinator_eval'] as const).map((kind, index) => [
        index === 0 ? 'answer-unsupported-human-gate' : 'answer-unsupported-evaluator-gate', [
          { id: 'first', title: 'First', prompt: 'Ordinary first step.' },
          { id: 'gated', title: 'Gate', prompt: 'Needs an authorized decision.', requireConfirmation: { kind } }]] as const),
      ['answer-unsupported-condition', [
        { id: 'first', title: 'First', prompt: 'Ordinary first step.' },
        { id: 'conditional', title: 'Conditional', prompt: 'Depends on context.', runCondition: { var: 'enabled', equals: true } }]],
      ['answer-unsupported-delegation', [
        { id: 'first', title: 'First', prompt: 'Ordinary first step.' },
        { id: 'delegate', type: 'parallel', title: 'Delegate', parallelDelegations: [{ workflowId: 'answer-notes', goal: 'Record independent notes.' }] }]],
    ] as const) await writeFile(join(workflows, id + '.json'), JSON.stringify({ id, name: id,
      description: 'Acceptance fixture', version: '1.0.0', steps }));
    process.env.WORKRAIL_DATA_DIR = root;
    process.env.WORKRAIL_KEYS_DIR = join(root, 'keys');
    process.env.WORKFLOW_STORAGE_PATH = workflows;
    process.env.WORKRAIL_ENABLE_V2_TOOLS = 'true';
    process.env.WORKRAIL_ENABLE_SESSION_TOOLS = 'false';
    const boot = async (profile: 'notes' | 'answers') => {
      await close();
      const baseline = profile === 'notes' ? loadNotesBaseline() : undefined;
      const containerModule = baseline?.container ?? await import(containerModulePath);
      resetContainerFn = containerModule.resetContainer;
      resetContainerFn?.();
      process.env.WORKRAIL_AGENT_PROFILE = profile;
      try {
        const serverModule = (baseline?.server ?? await import(serverModulePath)) as {
          composeServer: (options?: import('../../src/answer-v1/contracts/host-composition.js').AnswerMcpCompositionOptions) => Promise<ComposedServerLike>;
        };
        server = (await serverModule.composeServer(profile === 'answers' ? { answerAuthority: {
          storage: { journalRootDir: join(root, 'answer-v1', 'sessions'), hostIndexRootDir: join(root, 'answer-v1', 'host-index') },
          keyringPath: join(root, 'keys', 'keyring.json'), workflowStoragePath: workflows,
        } } : undefined)).server;
      }
      catch (error) { throw new Error(`Profile ${profile} unavailable; downstream acceptance assertions not exercised: ${error instanceof Error ? error.message : String(error)}`); }
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      client = new Client({ name: 'answer-acceptance', version: '1.0.0' });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
    };
    const call = async (name: string, args: Record<string, unknown>) => {
      if (!client) throw new Error('Fixture not connected');
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
      expect(result.isError, `MCP error from ${name}: ${JSON.stringify(result.content)}`).not.toBe(true);
      const envelope = z.object({ content: z.array(z.object({ type: z.literal('text'), text: z.string() }).passthrough()).min(1) }).passthrough().parse(result);
      return JSON.parse(envelope.content[0]!.text) as unknown;
    };
    const artifacts = async () => Object.entries(await journal()).filter(([path]) => !path.includes('manifest'))
      .flatMap(([, content]) => content.split('\n').filter(Boolean).map(line => JSON.parse(line)))
      .filter(event => event.kind === 'node_output_appended' && event.data?.payload?.payloadKind === 'artifact_ref')
      .map(event => event.data.payload.content);
    const notes = async () => Object.entries(await journal()).filter(([path]) => !path.includes('manifest'))
      .flatMap(([, content]) => content.split('\n').filter(Boolean).map(line => JSON.parse(line)))
      .filter(event => event.kind === 'node_output_appended' && event.data?.payload?.payloadKind === 'notes')
      .map(event => event.data.payload.notesMarkdown as string);
    await run({ root, boot, call, journal, artifacts, notes, sessionFiles });
  } finally {
    try { await close(); } finally {
      for (const key of envKeys) {
        if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
      }
      await rm(root, { recursive: true, force: true });
    }
  }
}


export { viewSchema, recordedSchema, openedSchema, evidenceReadSchema, drainReceipt, question, assertNoReply, unsupportedContracts, contractWorkflowId, unsupportedWorkflows, findingWithCategory, findingWithoutCategory, completeReview, fixture };
