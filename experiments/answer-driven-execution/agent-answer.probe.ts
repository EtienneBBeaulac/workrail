/// <reference types="node" />
/** Candidate acceptance specifications over the real MCP server and filesystem.
 * No candidate implementation is supplied here. Until profile=answers exists,
 * candidate cases stop at profile admission and their behavioral assertions are
 * UNEXERCISED, not proven failures of partial-answer/recovery behavior.
 */
import 'reflect-metadata';
import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ARTIFACT_CONTRACT_REFS } from '../../src/v2/durable-core/schemas/artifacts/index.js';
import { readVerdictArtifact } from '../../src/coordinators/pr-review.js';
import { parseReviewVerdictArtifact } from '../../src/v2/durable-core/schemas/artifacts/review-verdict.js';

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
      if (!resetContainerFn) {
        const containerModule = (await import(containerModulePath)) as { resetContainer: () => void };
        resetContainerFn = containerModule.resetContainer;
      }
      await close();
      process.env.WORKRAIL_AGENT_PROFILE = profile;
      try {
        const serverModule = (await import(serverModulePath)) as {
          composeServer: (options?: import('./host-composition.js').AnswerMcpCompositionOptions) => Promise<ComposedServerLike>;
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

it('control: the actual notes profile completes both steps of the notes workflow over MCP', () => fixture(async f => {
  await f.boot('notes');
  const started = z.object({ kind: z.literal('work'), assignment: z.string() }).passthrough().parse(
    await f.call('start_work', { workflowId: 'answer-notes', workspacePath: f.root, goal: 'Record two observations.' }));
  const first = z.object({ kind: z.literal('work'), assignment: z.string() }).passthrough().parse(
    await f.call('submit_work', { assignment: started.assignment, result: { notes: 'First observation.' } }));
  const finished = await f.call('submit_work', { assignment: first.assignment, result: { notes: 'Second observation.' } });
  expect(finished).toMatchObject({ kind: 'finished', outcome: { kind: 'completed' } });
  expect(Object.keys(await f.journal()).length).toBeGreaterThan(0);
  expect(await f.notes()).toEqual(['First observation.', 'Second observation.']);
}));

it('retains a partial review across MCP recomposition and materializes the exact full artifact', () => fixture(async f => {
  await f.boot('answers');
  const opened = openedSchema.parse(await f.call('open_work', { workflowId: 'answer-review', workspacePath: f.root, goal: 'Review.' }));
  const initial = question(opened.view);
  const partial = recordedSchema.parse(await f.call('answer_work', { reply: initial.reply,
    answer: { notes: 'Checked sample.ts.', verdict: 'minor', confidence: 'high',
      findings: [findingWithCategory, findingWithoutCategory] } }));
  expect(partial.disposition).toBe('partial');
  expect(await f.artifacts()).toEqual([]);
  question(partial.view);
  expect(partial.view).toMatchObject({ issues: [{ kind: 'field', field: 'summary' }] });
  const before = await f.journal();
  await f.boot('answers');
  const recovered = question(await f.call('recover_work', { recovery: opened.recovery }));
  expect(await f.journal()).toEqual(before);
  expect(recovered).toMatchObject({ retained: expect.arrayContaining([expect.objectContaining({ receipt: partial.receipt })]), issues: [{ kind: 'field', field: 'summary' }] });
  const final = recordedSchema.parse(await f.call('answer_work', {
    reply: recovered.reply,
    answer: { summary: completeReview.summary },
  }));
  expect(final.view).toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  assertNoReply(final.view);
  expect(await f.artifacts()).toEqual([completeReview]);
  const materialized = (await f.artifacts())[0] as typeof completeReview;
  expect(materialized.findings[0]).toEqual(findingWithCategory);
  expect(materialized.findings[1]).toEqual(findingWithoutCategory);
  expect(Object.hasOwn(materialized.findings[1], 'findingCategory')).toBe(false);
  expect(await f.notes()).toEqual(['Checked sample.ts.']);

  // Downstream consumer acceptance: pass exact materialized artifact through actual exported readVerdictArtifact
  const handle = 'session-recomposed-review-1234';
  const consumerFindings = readVerdictArtifact(await f.artifacts(), handle);
  expect(consumerFindings).toEqual({
    severity: 'minor',
    findingSummaries: [
      'A retained finding with category',
      'A secondary finding with optional category absent',
    ],
    raw: JSON.stringify(materialized),
    source: 'artifact',
  });
}));

it('control: legacy readVerdictArtifact parses valid review fixture and isolates category-specific consumer behavior', () => {
  // Bounded legacy positive control: exercises actual exported readVerdictArtifact
  // with valid full review fixture without requiring mock dependencies.
  const handle = 'legacy-review-session-control-1234';
  const consumerVerdict = readVerdictArtifact([completeReview], handle);
  expect(consumerVerdict).not.toBeNull();
  expect(consumerVerdict).toEqual({
    severity: 'minor',
    findingSummaries: [
      'A retained finding with category',
      'A secondary finding with optional category absent',
    ],
    raw: JSON.stringify(completeReview),
    source: 'artifact',
  });

  // Verify parser intentionally reduces findings to summaries without preserving category on ReviewFindings
  expect(Object.hasOwn(consumerVerdict!, 'findingCategory')).toBe(false);
  expect(Object.hasOwn(consumerVerdict!, 'findings')).toBe(false);

  // Category routing in downstream coordinators (src/coordinators/modes/implement-shared.ts:128-131):
  // Consumers independently call parseReviewVerdictArtifact(raw) to inspect findingCategory
  const rawParsed = parseReviewVerdictArtifact(completeReview);
  expect(rawParsed).not.toBeNull();
  expect(rawParsed?.findings[0]?.findingCategory).toBe('correctness');
  expect(rawParsed?.findings[1]?.findingCategory).toBeUndefined();

  // Malformed or invalid artifacts return null to fall back to keyword scanning or unknown severity
  expect(readVerdictArtifact([{ ...completeReview, verdict: 'invalid' }], handle)).toBeNull();
  expect(readVerdictArtifact([{ kind: 'wr.other_artifact' }], handle)).toBeNull();
  expect(readVerdictArtifact([], handle)).toBeNull();
});

it('replays a committed answer without consuming the next assignment or granting read-side write authority', () => fixture(async f => {
  await f.boot('answers');
  const opened = openedSchema.parse(await f.call('open_work', { workflowId: 'answer-notes', workspacePath: f.root, goal: 'Record two observations.' }));
  const request = { reply: question(opened.view).reply, answer: { notes: 'First observation.' } };
  const first = recordedSchema.parse(await f.call('answer_work', request));
  const pending = question(first.view);
  const committed = await f.sessionFiles();

  // Replay of committed answer cannot mint reply or recovery refs; causes no session mutation
  const replay = await f.call('answer_work', request);
  expect(replay).toMatchObject({ kind: 'replay', receipt: first.receipt });
  expect(replay).toMatchObject({ original: { kind: 'question', read: expect.any(String) } });
  assertNoReply(replay);
  expect(await f.sessionFiles()).toEqual(committed);

  // Inspecting active question: read view cannot mint reply or recovery refs; causes no session mutation
  const inspected = await f.call('inspect_work', { read: pending.read });
  expect(inspected).toMatchObject({ kind: 'question', read: pending.read });
  assertNoReply(inspected);
  expect(await f.sessionFiles()).toEqual(committed);

  // Recovery with read capability is refused without mutating session
  expect(await f.call('recover_work', { recovery: pending.read })).toMatchObject({ kind: 'unavailable' });
  expect(await f.sessionFiles()).toEqual(committed);

  // Valid recovery returns active question view with reply authority; read operation causes no session mutation
  const recovered = question(await f.call('recover_work', { recovery: opened.recovery }));
  expect(recovered).toMatchObject({ kind: 'question' });
  expect(recovered.read).toBeDefined();
  expect(recovered.reply).toBeDefined();
  expect(await f.sessionFiles()).toEqual(committed);

  // Answering with the original pending.reply after valid recovery proves recovery didn't invalidate it
  const final = recordedSchema.parse(await f.call('answer_work', { reply: pending.reply, answer: { notes: 'Second observation.' } }));
  expect(final.view).toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  assertNoReply(final.view);

  // Inspecting finished view: cannot mint reply or recovery refs; causes no session mutation
  const committedFinished = await f.sessionFiles();
  const inspectedFinished = await f.call('inspect_work', { read: (final.view as { read: string }).read });
  expect(inspectedFinished).toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  assertNoReply(inspectedFinished);
  expect(await f.sessionFiles()).toEqual(committedFinished);

  // Replaying final answer: cannot mint reply or recovery refs; causes no session mutation
  const finalReplay = await f.call('answer_work', { reply: pending.reply, answer: { notes: 'Second observation.' } });
  expect(finalReplay).toMatchObject({ kind: 'replay', receipt: final.receipt });
  assertNoReply(finalReplay);
  expect(await f.sessionFiles()).toEqual(committedFinished);

  // Completed recover must explicitly be finished with completed execution rather than arbitrary unavailable; no session mutation
  const completedRecovery = await f.call('recover_work', { recovery: opened.recovery });
  expect(completedRecovery).toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  assertNoReply(completedRecovery);
  expect(await f.sessionFiles()).toEqual(committedFinished);

  // Explicit stage progress, notes, and artifact assertions
  expect(await f.notes()).toEqual(['First observation.', 'Second observation.']);
  expect(await f.artifacts()).toEqual([]);
}));

it('distinguishes a consumed-reference conflict from explicit findings replacement', () => fixture(async f => {
  await f.boot('answers');
  const opened = openedSchema.parse(await f.call('open_work', { workflowId: 'answer-review', workspacePath: f.root, goal: 'Review.' }));
  const reply = question(opened.view).reply;
  const first = recordedSchema.parse(await f.call('answer_work', { reply,
    answer: { notes: 'Reviewed.', verdict: 'minor', confidence: 'high', findings: [findingWithCategory] } }));
  const replacement = { ...findingWithCategory, summary: 'Corrected finding', remediation: 'Updated remedy.' };
  const before = await f.journal();
  const conflict = await f.call('answer_work', { reply, answer: { findings: [replacement] } });
  expect(conflict).toMatchObject({ kind: 'conflict', original: first.receipt });
  assertNoReply(conflict);
  expect(await f.journal()).toEqual(before);
  const proposed = recordedSchema.parse(await f.call('answer_work', {
    reply: question(first.view).reply, answer: { findings: [replacement] } }));
  expect(proposed.disposition).toBe('rejected');
  expect(proposed.view).toMatchObject({ retained: expect.arrayContaining([
    expect.objectContaining({ receipt: first.receipt }),
    expect.objectContaining({ receipt: proposed.receipt }),
  ]) });
  const captured = await f.journal();
  expect(captured).not.toEqual(before);
  await f.boot('answers');
  const correction = question(await f.call('recover_work', { recovery: opened.recovery }));
  expect(await f.journal()).toEqual(captured);
  expect(correction).toMatchObject({ retained: expect.arrayContaining([
    expect.objectContaining({ receipt: proposed.receipt }),
  ]) });
  const corrected = recordedSchema.parse(await f.call('answer_work', {
    reply: correction.reply,
    answer: { findings: [replacement], summary: completeReview.summary } }));
  expect(corrected.view).toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  assertNoReply(corrected.view);
  expect(await f.artifacts()).toEqual([{ ...completeReview, findings: [replacement] }]);
  expect(await f.notes()).toEqual(['Reviewed.']);
}));

it('refuses raw worker answers attempting privileged operations or run identity selection and completes with ordinary notes', () => fixture(async f => {
  await f.boot('answers');
  const opened = openedSchema.parse(await f.call('open_work', {
    workflowId: 'answer-notes', workspacePath: f.root, goal: 'Verify privilege and identity boundaries.' }));
  let pending = question(opened.view);
  expect(pending.instruction).toContain('Record the first observation.');

  // Raw worker attempts carrying unauthorized privileged fields, cancellation, or run identity selection
  // must be rejected as captured invalid answers without advancing the workflow.
  const unauthorizedAttempts = [
    { label: 'approval', answer: { notes: 'Attempting gate approval.', approval: true, verdict: 'approved', gateId: 'gate-1' } },
    { label: 'checkpoint', answer: { notes: 'Attempting checkpoint creation.', checkpoint: true, checkpointId: 'cp-priv' } },
    { label: 'fork', answer: { notes: 'Attempting branch fork.', fork: true, forkFromNodeId: 'first' } },
    { label: 'dispatch', answer: { notes: 'Attempting operator dispatch.', dispatch: true, workflowId: 'answer-review' } },
    { label: 'cancellation', answer: { notes: 'Attempting cancellation.', cancel: true, cancelled: true } },
    { label: 'run_identity', answer: { notes: 'Attempting run identity switch.', sessionId: 'forged-session-999', runId: 'forged-run-999' } },
  ] as const;

  for (const attempt of unauthorizedAttempts) {
    const refusal = recordedSchema.parse(await f.call('answer_work', {
      reply: pending.reply,
      answer: attempt.answer,
    }));
    expect(refusal.disposition, `Unauthorized ${attempt.label} should be rejected`).toBe('rejected');
    // Workflow must not advance; view returns actual current first-step bearer reply and prompt instruction
    pending = question(refusal.view);
    expect(pending.instruction).toContain('Record the first observation.');
    expect(Object.hasOwn(refusal.view, 'recovery')).toBe(false);
  }

  // Verify no workflow task advancement, notes, or artifacts materialized before valid submission
  expect(await f.artifacts()).toEqual([]);
  expect(await f.notes()).toEqual([]);

  // Paired valid ordinary notes control: valid notes must advance through each step to completion
  const first = recordedSchema.parse(await f.call('answer_work', {
    reply: pending.reply,
    answer: { notes: 'First observation.' },
  }));
  expect(first.disposition).toBe('accepted');
  const secondQuestion = question(first.view);
  expect(secondQuestion.instruction).toContain('Record the second observation.');

  const second = recordedSchema.parse(await f.call('answer_work', {
    reply: secondQuestion.reply,
    answer: { notes: 'Second observation.' },
  }));
  expect(second.disposition).toBe('accepted');
  expect(second.view).toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  assertNoReply(second.view);

  // Explicit stage progress, exact notes, artifacts, and terminal state assertions
  expect(await f.notes()).toEqual(['First observation.', 'Second observation.']);
  expect(await f.artifacts()).toEqual([]);
}));


// Admission must inspect the complete pinned definition before creating a run.
it.each(unsupportedWorkflows)('control: notes refuses valid unsupported workflow %s without enrollment', workflowId => fixture(async f => {
  await f.boot('notes');
  const metadata = await f.call('inspect_workflow', { workflowId, workspacePath: f.root, mode: 'metadata' });
  expect(metadata).toBeDefined(); // call() rejects MCP errors; validation is through the real registry.
  const before = await f.sessionFiles();
  expect(await f.call('start_work', { workflowId, workspacePath: f.root, goal: 'Check admission.' }))
    .toMatchObject({ kind: 'unsupported_workflow' });
  expect(await f.sessionFiles()).toEqual(before);
}));

it.each(unsupportedWorkflows)('refuses unsupported candidate workflow %s before enrollment and still admits notes', workflowId => fixture(async f => {
  await f.boot('answers');
  const before = await f.sessionFiles();
  const refusal = await f.call('open_work', { workflowId, workspacePath: f.root, goal: 'Check admission.' });
  expect(refusal).toMatchObject({ kind: 'unsupported_workflow' });
  assertNoReply(refusal);
  expect(await f.sessionFiles()).toEqual(before);
  const opened = openedSchema.parse(await f.call('open_work', {
    workflowId: 'answer-notes', workspacePath: f.root, goal: 'Supported control.' }));
  const first = recordedSchema.parse(await f.call('answer_work', {
    reply: question(opened.view).reply, answer: { notes: 'First supported observation.' } }));
  const final = recordedSchema.parse(await f.call('answer_work', {
    reply: question(first.view).reply, answer: { notes: 'Second supported observation.' } }));
  expect(final.view).toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  assertNoReply(final.view);
  expect(await f.notes()).toEqual(['First supported observation.', 'Second supported observation.']);
}));

it('refuses wrong-operation and corrupted capabilities without consuming a valid reply', () => fixture(async f => {
  await f.boot('answers');
  const opened = openedSchema.parse(await f.call('open_work', {
    workflowId: 'answer-notes', workspacePath: f.root, goal: 'Separate authority.' }));
  const initial = question(opened.view);
  const before = await f.sessionFiles();
  const refusedCalls = [
    ['answer_work', { reply: initial.read, answer: { notes: 'Must not be retained.' } }, 'not_retained'],
    ['answer_work', { reply: opened.recovery, answer: { notes: 'Must not be retained.' } }, 'not_retained'],
    ['recover_work', { recovery: initial.read }, 'unavailable'],
    ['recover_work', { recovery: initial.reply }, 'unavailable'],
    ['inspect_work', { read: initial.reply }, 'unavailable'],
    ['inspect_work', { read: opened.recovery }, 'unavailable'],
    ['answer_work', { reply: initial.reply + '.tampered', answer: { notes: 'Must not be retained.' } }, 'not_retained'],
    ['inspect_work', { read: initial.read + '.tampered' }, 'unavailable'],
    ['recover_work', { recovery: opened.recovery + '.tampered' }, 'unavailable'],
  ] as const;
  for (const [name, args, kind] of refusedCalls) {
    const refusal = await f.call(name, args);
    expect(refusal).toMatchObject({ kind });
    assertNoReply(refusal);
    expect(await f.sessionFiles()).toEqual(before);
  }
  const inspected = await f.call('inspect_work', { read: initial.read });
  expect(inspected).toMatchObject({ kind: 'question' });
  assertNoReply(inspected);
  expect(await f.sessionFiles()).toEqual(before);
  const first = recordedSchema.parse(await f.call('answer_work', {
    reply: initial.reply, answer: { notes: 'First authorized observation.' } }));
  question(first.view);
  const committed = await f.sessionFiles();
  const recovered = question(await f.call('recover_work', { recovery: opened.recovery }));
  expect(await f.sessionFiles()).toEqual(committed);
  const final = recordedSchema.parse(await f.call('answer_work', {
    reply: recovered.reply, answer: { notes: 'Second authorized observation.' } }));
  expect(final.view).toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  assertNoReply(final.view);
  expect(await f.notes()).toEqual(['First authorized observation.', 'Second authorized observation.']);
}));

it('reads exact bounded receipt pages for domain-invalid JSON payload and retains rejection through recovery completion', () => fixture(async f => {
  await f.boot('answers');
  const opened = openedSchema.parse(await f.call('open_work', {
    workflowId: 'answer-notes', workspacePath: f.root, goal: 'Verify exact bounded receipt reads.',
  }));
  let pending = question(opened.view);

  // Multibyte string > 8192 UTF-8 bytes with numeric notes (domain-invalid JSON, not malformed JSON)
  const multibyteChunk = '日本語テスト文字とアクセントéàçüö';
  const largeMultibyteText = multibyteChunk.repeat(200); // 9,800 UTF-8 bytes
  const invalidPayload = {
    notes: 12345,
    unknownPayloadData: largeMultibyteText,
  };
  const payloadBytes = Buffer.byteLength(JSON.stringify(invalidPayload), 'utf8');
  expect(payloadBytes).toBeGreaterThan(8192);

  const rejected = recordedSchema.parse(await f.call('answer_work', {
    reply: pending.reply,
    answer: invalidPayload,
  }));
  expect(rejected.disposition).toBe('rejected');
  expect(rejected.receipt).toBeDefined();

  // Correction question emitted; workflow does not advance to step 2
  pending = question(rejected.view);
  expect(pending.instruction).toContain('Record the first observation.');

  // Snapshot session files before reads; reads must not cause file mutation
  const beforeReads = await f.sessionFiles();

  // Drain all pages with server recomposition between first and next page
  const drained = await drainReceipt(f.call, pending.read, rejected.receipt, {
    onFirstNextPage: async () => { await f.boot('answers'); },
  });
  expect(drained.pages.length).toBeGreaterThanOrEqual(3);
  expect(drained.pages[0]!.encoding).toBe('canonical_json');
  expect(drained.pages[0]!.disposition).toBe('rejected');

  // Reassemble exact payload and JSON.parse compare all original fields; no fabricated summary
  const reassembled = JSON.parse(drained.reassembled);
  expect(reassembled).toEqual(invalidPayload);

  // Disk sessions snapshot before/after reads unchanged
  expect(await f.sessionFiles()).toEqual(beforeReads);

  // Valid recovery notes completes both original steps
  const recovered = question(await f.call('recover_work', { recovery: opened.recovery }));
  const firstValid = recordedSchema.parse(await f.call('answer_work', {
    reply: recovered.reply,
    answer: { notes: 'First valid observation.' },
  }));
  expect(firstValid.disposition).toBe('accepted');
  const secondQuestion = question(firstValid.view);
  expect(secondQuestion.instruction).toContain('Record the second observation.');

  const secondValid = recordedSchema.parse(await f.call('answer_work', {
    reply: secondQuestion.reply,
    answer: { notes: 'Second valid observation.' },
  }));
  expect(secondValid.disposition).toBe('accepted');
  expect(secondValid.view).toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  assertNoReply(secondValid.view);
  expect(await f.notes()).toEqual(['First valid observation.', 'Second valid observation.']);

  // Re-read retained rejection after completed recovery: drain all pages and compare all fields exactly again
  const finishedSnapshot = await f.sessionFiles();
  const finishedReadRef = secondValid.view.read;
  const reread = await drainReceipt(f.call, finishedReadRef, rejected.receipt);
  expect(reread.pages.length).toBeGreaterThanOrEqual(3);
  expect(reread.pages[0]!.encoding).toBe('canonical_json');
  expect(reread.pages[0]!.disposition).toBe('rejected');
  expect(JSON.parse(reread.reassembled)).toEqual(invalidPayload);
  expect(await f.sessionFiles()).toEqual(finishedSnapshot);
}));

// Cross-scope reference validation over unbound InspectWork API.
// Does NOT assert host-bound employee/task-auth isolation; bound host acceptance remains unimplemented.
it('refuses cross-scope receipt and cursor reads across unbound runs while preserving replies and disk state', () => fixture(async f => {
  await f.boot('answers');

  // Unbound Run A
  const openedA = openedSchema.parse(await f.call('open_work', {
    workflowId: 'answer-notes', workspacePath: f.root, goal: 'Unbound Run A.',
  }));
  const qA = question(openedA.view);

  // Run A generates two distinct receipts within one run:
  // 1. A rejected domain-invalid submission under initial reply
  const rejectedPayloadA = { notes: 8888, unknownField: '日本語テスト文字とアクセントéàçüö'.repeat(120) };
  const rejectedA = recordedSchema.parse(await f.call('answer_work', {
    reply: qA.reply,
    answer: rejectedPayloadA,
  }));
  expect(rejectedA.disposition).toBe('rejected');
  const remedyQuestionA = question(rejectedA.view);

  // 2. A valid large notes submission under remedy reply
  const largeNotesA = 'Observation A payload with large content. '.repeat(120); // ~5000 bytes > 4096
  const firstA = recordedSchema.parse(await f.call('answer_work', {
    reply: remedyQuestionA.reply,
    answer: { notes: largeNotesA },
  }));
  expect(firstA.disposition).toBe('accepted');
  const pendingA = question(firstA.view);

  // Unbound Run B
  const openedB = openedSchema.parse(await f.call('open_work', {
    workflowId: 'answer-notes', workspacePath: f.root, goal: 'Unbound Run B.',
  }));
  const qB = question(openedB.view);
  const largeNotesB = 'Observation B payload with large content. '.repeat(120); // ~5000 bytes > 4096
  const firstB = recordedSchema.parse(await f.call('answer_work', {
    reply: qB.reply,
    answer: { notes: largeNotesB },
  }));
  expect(firstB.disposition).toBe('accepted');
  const pendingB = question(firstB.view);

  const filesBeforeReads = await f.sessionFiles();
  // Same-scope first page reads for cursor extraction
  const readRawA_rej = await f.call('inspect_work', { read: pendingA.read, receipt: rejectedA.receipt });
  assertNoReply(readRawA_rej);
  const pageA_rej = evidenceReadSchema.parse(readRawA_rej);
  if (pageA_rej.kind !== 'more') throw new Error('Expected more pages for rejected A');
  const cursorA_rej = pageA_rej.next;

  const readRawA = await f.call('inspect_work', { read: pendingA.read, receipt: firstA.receipt });
  assertNoReply(readRawA);
  const pageA1 = evidenceReadSchema.parse(readRawA);
  if (pageA1.kind !== 'more') throw new Error('Expected more pages for run A');
  expect(pageA1.receipt).toBe(firstA.receipt);
  expect(pageA1.disposition).toBe('accepted');
  expect(pageA1.encoding).toBe('canonical_json');
  const cursorA = pageA1.next;

  const readRawB = await f.call('inspect_work', { read: pendingB.read, receipt: firstB.receipt });
  assertNoReply(readRawB);
  const pageB1 = evidenceReadSchema.parse(readRawB);
  if (pageB1.kind !== 'more') throw new Error('Expected more pages for run B');
  expect(pageB1.receipt).toBe(firstB.receipt);
  expect(pageB1.disposition).toBe('accepted');
  expect(pageB1.encoding).toBe('canonical_json');
  const cursorB = pageB1.next;

  expect(await f.sessionFiles()).toEqual(filesBeforeReads);
  const filesBeforeRefusals = await f.sessionFiles();

  // Cross read/receipt pair refuse without file change (strict refusal parsing)
  const crossReadAB = evidenceReadSchema.parse(await f.call('inspect_work', { read: pendingA.read, receipt: firstB.receipt }));
  assertNoReply(crossReadAB);
  expect(crossReadAB).toEqual({ kind: 'refused', reason: 'invalid_scope' });
  expect(await f.sessionFiles()).toEqual(filesBeforeRefusals);

  const crossReadBA = evidenceReadSchema.parse(await f.call('inspect_work', { read: pendingB.read, receipt: firstA.receipt }));
  assertNoReply(crossReadBA);
  expect(crossReadBA).toEqual({ kind: 'refused', reason: 'invalid_scope' });
  expect(await f.sessionFiles()).toEqual(filesBeforeRefusals);

  // Cursor is receipt-bound within the same run: crossing cursors between two receipts in Run A refuses
  const crossReceiptCursorWithinRun = evidenceReadSchema.parse(await f.call('inspect_work', {
    read: pendingA.read,
    receipt: firstA.receipt,
    cursor: cursorA_rej,
  }));
  assertNoReply(crossReceiptCursorWithinRun);
  expect(crossReceiptCursorWithinRun.kind).toBe('refused');
  expect(await f.sessionFiles()).toEqual(filesBeforeRefusals);

  const crossReceiptCursorWithinRunRev = evidenceReadSchema.parse(await f.call('inspect_work', {
    read: pendingA.read,
    receipt: rejectedA.receipt,
    cursor: cursorA,
  }));
  assertNoReply(crossReceiptCursorWithinRunRev);
  expect(crossReceiptCursorWithinRunRev.kind).toBe('refused');
  expect(await f.sessionFiles()).toEqual(filesBeforeRefusals);

  // Cross-run receipt cursor refuses without file change
  const crossCursorAB = evidenceReadSchema.parse(await f.call('inspect_work', {
    read: pendingA.read,
    receipt: firstA.receipt,
    cursor: cursorB,
  }));
  assertNoReply(crossCursorAB);
  expect(crossCursorAB.kind).toBe('refused');
  expect(await f.sessionFiles()).toEqual(filesBeforeRefusals);

  const crossCursorBA = evidenceReadSchema.parse(await f.call('inspect_work', {
    read: pendingB.read,
    receipt: firstB.receipt,
    cursor: cursorA,
  }));
  assertNoReply(crossCursorBA);
  expect(crossCursorBA.kind).toBe('refused');
  expect(await f.sessionFiles()).toEqual(filesBeforeRefusals);

  // Corrupted cursor refuses without file change
  const corruptedCursor = evidenceReadSchema.parse(await f.call('inspect_work', {
    read: pendingA.read,
    receipt: firstA.receipt,
    cursor: 'corrupted-cursor-token-9999',
  }));
  assertNoReply(corruptedCursor);
  expect(corruptedCursor.kind).toBe('refused');
  expect(await f.sessionFiles()).toEqual(filesBeforeRefusals);

  // Rightful original cursor recovers exact remaining content after failed calls, for BOTH runs
  const drainRemainingA = await drainReceipt(f.call, pendingA.read, firstA.receipt, { initialCursor: cursorA });
  const fullReassembledA = pageA1.chunk + drainRemainingA.reassembled;
  expect(JSON.parse(fullReassembledA)).toEqual({ notes: largeNotesA });

  const drainRemainingB = await drainReceipt(f.call, pendingB.read, firstB.receipt, { initialCursor: cursorB });
  const fullReassembledB = pageB1.chunk + drainRemainingB.reassembled;
  expect(JSON.parse(fullReassembledB)).toEqual({ notes: largeNotesB });

  // Full-page drain positive control for both runs from start
  const drainFullA = await drainReceipt(f.call, pendingA.read, firstA.receipt);
  expect(JSON.parse(drainFullA.reassembled)).toEqual({ notes: largeNotesA });
  const drainFullB = await drainReceipt(f.call, pendingB.read, firstB.receipt);
  expect(JSON.parse(drainFullB.reassembled)).toEqual({ notes: largeNotesB });
  expect(await f.sessionFiles()).toEqual(filesBeforeRefusals);

  // Original replies still work; refusals did not consume replies
  const finishA = recordedSchema.parse(await f.call('answer_work', {
    reply: pendingA.reply,
    answer: { notes: 'Second observation for run A.' },
  }));
  expect(finishA.disposition).toBe('accepted');
  expect(finishA.view).toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  assertNoReply(finishA.view);

  const finishB = recordedSchema.parse(await f.call('answer_work', {
    reply: pendingB.reply,
    answer: { notes: 'Second observation for run B.' },
  }));
  expect(finishB.disposition).toBe('accepted');
  expect(finishB.view).toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  assertNoReply(finishB.view);

  // Full receipts above are lossless; engine notes are bounded markdown summaries.
  const recordedNotes = await f.notes();
  expect(recordedNotes).toHaveLength(4);
  expect(recordedNotes).toContain('Second observation for run A.');
  expect(recordedNotes).toContain('Second observation for run B.');
  const summaries = recordedNotes.filter(note => note.endsWith('\n\n[TRUNCATED]'));
  expect(summaries).toHaveLength(2);
  expect(new Set(summaries).size).toBe(2);
  for (const summary of summaries) {
    expect(Buffer.byteLength(summary, 'utf8')).toBe(4096);
    const prefix = summary.slice(0, -'\n\n[TRUNCATED]'.length);
    expect(prefix.length).toBeGreaterThan(0);
    expect([largeNotesA, largeNotesB].some(original => original.startsWith(prefix))).toBe(true);
  }
}));

it.each([
  ['missing verdict only', { confidence: 'low' }, ['verdict'], { verdict: 'clean' }],
  ['missing confidence only', { verdict: 'clean' }, ['confidence'], { confidence: 'low' }],
  ['both', {}, ['confidence', 'verdict'], { verdict: 'clean', confidence: 'low' }],
] as const)('requires explicit review judgments: %s', (_name, initialJudgments, missingFields, finalJudgments) => fixture(async f => {
  await f.boot('answers');
  const opened = openedSchema.parse(await f.call('open_work', { workflowId: 'answer-review', workspacePath: f.root, goal: 'Review.' }));
  const initial = question(opened.view);
  const summary = 'Clean review summary';
  const notes = 'Checked notes once';

  const expectedPartial = { summary, notes, findings: [], ...initialJudgments };
  const partial = recordedSchema.parse(await f.call('answer_work', {
    reply: initial.reply,
    answer: expectedPartial,
  }));
  expect(partial.disposition).toBe('partial');
  question(partial.view);
  expect(await f.artifacts()).toEqual([]);

  const issuesViewSchema = z.object({
    issues: z.array(z.object({ kind: z.literal('field'), field: z.string().min(1), reason: z.string().min(1) }).passthrough()),
  }).passthrough();
  const checkIssues = (view: unknown) => {
    const parsed = issuesViewSchema.parse(view);
    expect(parsed.issues.map(i => i.field).sort()).toEqual(missingFields);
    for (const issue of parsed.issues) {
      expect(issue.reason.trim().length).toBeGreaterThan(0);
    }
  };
  checkIssues(partial.view);

  const payloadBefore = JSON.parse((await drainReceipt(f.call, partial.view.read, partial.receipt)).reassembled);
  expect(payloadBefore).toEqual(expectedPartial);
  const journalBeforeRecomposition = await f.journal();
  await f.boot('answers');
  const recovered = question(await f.call('recover_work', { recovery: opened.recovery }));
  checkIssues(recovered);
  const payloadAfter = JSON.parse((await drainReceipt(f.call, recovered.read, partial.receipt)).reassembled);
  expect(payloadAfter).toEqual(expectedPartial);
  expect(await f.journal()).toEqual(journalBeforeRecomposition);
  expect(await f.artifacts()).toEqual([]);

  const final = recordedSchema.parse(await f.call('answer_work', {
    reply: recovered.reply,
    answer: finalJudgments,
  }));
  expect(final.disposition).toBe('accepted');
  expect(final.view).toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  assertNoReply(final.view);

  const expectedArtifact = {
    kind: 'wr.review_verdict',
    verdict: 'clean',
    confidence: 'low',
    findings: [],
    summary,
  };
  const artifacts = await f.artifacts();
  expect(artifacts).toEqual([expectedArtifact]);
  expect(await f.notes()).toEqual([notes]);

  const consumerVerdict = readVerdictArtifact(artifacts, 'session-review-judgments');
  // The store canonicalizes key order. Raw means the actual retained artifact, not fixture insertion order.
  expect(JSON.parse(consumerVerdict!.raw)).toEqual(expectedArtifact);
  expect(consumerVerdict).toEqual({
    severity: 'clean',
    findingSummaries: [],
    raw: JSON.stringify(artifacts[0]),
    source: 'artifact',
  });
}));
