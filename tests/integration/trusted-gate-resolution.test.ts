/** Acceptance probe for authorized gate resolution at trusted daemon/engine boundary.
 *
 * Covers:
 * - Producer: Grounded on actual parked engine gate with real session_created event.
 * - Acceptance Requirements:
 *   1. Requires production resolver boundary at src/daemon/trusted-gate-resolver.ts.
 *      Absent module fails explicitly with 'runtime_unavailable: src/daemon/trusted-gate-resolver.ts'.
 *   2. Bound to explicit shared existing V2ToolContext/store/key context; no defaults to real home data.
 *   3. inspectPending(gateToken, signal) issues authenticated authority and exact subject from actual
 *      persisted pending gate (engine session/run/node occurrence/work revision). No guessed occurrence or fallback run-1.
 *   4. Refuses wrong pair (valid authority + foreign subject), tampered authority, and same subject with modified
 *      revision/occurrence/runId; session journal bytes and events remain strictly unchanged.
 *   5. Rightful approval confirms approved with stable receipt + actual next continueToken.
 *   6. Real next token advances actual after-gate step to completed via existing continue API.
 *   7. Verifies exact original and successor notes from events (not just event count increased).
 *   8. Replay of same resolution returns identical receipt without duplicate transition or extra changes.
 *   9. Abort-aware construction and close typed RuntimeCloseResult.
 *
 * Tests never fabricate fake resolvers returning chosen outcomes.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { stat, readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { z } from 'zod';

import { LocalDataDirV2 } from '../../src/v2/infra/local/data-dir/index.js';
import { createWorkflow } from '../../src/types/workflow.js';
import { createBundledSource } from '../../src/types/workflow-source.js';
import { EnvironmentFeatureFlagProvider } from '../../src/config/feature-flags.js';
import { handleV2ContinueWorkflow } from '../../src/mcp/handlers/v2-execution.js';
import { asRunId, asSessionId } from '../../src/v2/durable-core/ids/session-ids.js';
import type { V2ToolContext } from '../../src/mcp/types.js';

import type {
  CreateGateResolver,
  GateAuthorityRef,
  GateResolutionDecision,
  GateSubject,
  RuntimeCloseResult,
  TrustedGateResolverPort,
  WorkRevisionRef,
} from '../../src/v2/ports/trusted-gate-resolver.port.js';

const PRODUCTION_MODULE_PATH = 'src/daemon/trusted-gate-resolver.ts';

// Dynamic module specs for test helpers to prevent static typecheck pollution
const V2_TEST_HELPERS_SPEC = '../../tests/helpers/v2-test-helpers.js';
const V2_START_WORKFLOW_SPEC = '../../tests/helpers/v2-start-workflow-helper.js';
const UNWRAP_RESPONSE_SPEC = '../../tests/helpers/unwrap-response.js';

interface V2TestHelpers {
  createV2ToolContext(dataDir: LocalDataDirV2): Promise<V2ToolContext>;
  mkV2TestDataDir(prefix: string): Promise<{ root: string; cleanup: () => Promise<void> }>;
  resolveSessionIdFromToken(token: string, aliasStore: unknown): string;
}

interface V2StartWorkflowHelper {
  startWorkflowForTest(
    input: { workflowId: string; workspacePath: string; goal: string },
    ctx: V2ToolContext,
    flags?: Record<string, string>,
  ): Promise<{ type: 'success'; data: unknown } | { type: 'error'; error: string }>;
}

interface UnwrapResponseHelper {
  unwrapResponse(data: unknown): Record<string, unknown>;
}

async function loadTestHelpers(): Promise<{
  v2Helpers: V2TestHelpers;
  startHelper: V2StartWorkflowHelper;
  unwrapHelper: UnwrapResponseHelper;
}> {
  const v2Helpers = (await import(/* @vite-ignore */ V2_TEST_HELPERS_SPEC)) as V2TestHelpers;
  const startHelper = (await import(/* @vite-ignore */ V2_START_WORKFLOW_SPEC)) as V2StartWorkflowHelper;
  const unwrapHelper = (await import(/* @vite-ignore */ UNWRAP_RESPONSE_SPEC)) as UnwrapResponseHelper;
  return { v2Helpers, startHelper, unwrapHelper };
}

const StepResponseSchema = z.object({
  continueToken: z.string().min(1),
});

const GateResponseSchema = z.object({
  kind: z.string(),
  gateToken: z.string().min(1),
});

const CompleteResponseSchema = z.object({
  isComplete: z.boolean(),
});

async function snapshotJournal(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = { [dir]: '<directory>' };
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshotJournal(path));
    else if (entry.isFile()) result[path] = (await readFile(path)).toString('base64');
    else throw new Error(`Unexpected journal entry ${path}`);
  }
  return result;
}

/** Loads the production resolver factory. Fails via explicit assertion when absent. */
async function loadProductionGateResolver(): Promise<CreateGateResolver> {
  const absoluteSourcePath = resolve(process.cwd(), PRODUCTION_MODULE_PATH);
  try {
    await stat(absoluteSourcePath);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      expect.fail(`runtime_unavailable: ${PRODUCTION_MODULE_PATH} (module file does not exist at ${absoluteSourcePath})`);
    }
    throw err;
  }

  let mod: { createGateResolver?: CreateGateResolver; createTrustedGateResolver?: CreateGateResolver };
  try {
    mod = await import(/* @vite-ignore */ absoluteSourcePath);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.stack ?? err.message : String(err);
    expect.fail(`runtime_error: ${PRODUCTION_MODULE_PATH} (${detail})`);
  }
  const factory = mod?.createGateResolver ?? mod?.createTrustedGateResolver;
  if (!factory || typeof factory !== 'function') {
    expect.fail(`runtime_error: ${PRODUCTION_MODULE_PATH} (missing createGateResolver/createTrustedGateResolver export)`);
  }
  return factory;
}

describe('authorized gate resolution acceptance (M4 engine/daemon boundary)', () => {
  it('grounds producer on actual parked engine gate with session_created event', async () => {
    const { v2Helpers, startHelper, unwrapHelper } = await loadTestHelpers();
    const data = await v2Helpers.mkV2TestDataDir('workrail-gate-resolution-producer-');
    try {
      const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: data.root });
      const base = await v2Helpers.createV2ToolContext(dataDir);
      if (!base.v2) throw new Error('Missing v2 test context');

      const workflow = createWorkflow({
        id: 'gate-resume-contract',
        name: 'Gate resume contract',
        description: 'Two-step gate control',
        version: '1.0.0',
        steps: [
          { id: 'gated', title: 'Gated step', prompt: 'Perform the gated task.', requireConfirmation: true },
          { id: 'after-gate', title: 'After gate', prompt: 'Continue after resolution.' },
        ],
      }, createBundledSource());

      const ctx: V2ToolContext = {
        ...base,
        v2: base.v2,
        featureFlags: new EnvironmentFeatureFlagProvider(),
        workflowService: { ...base.workflowService, getWorkflowById: async () => workflow },
      };

      const started = await startHelper.startWorkflowForTest(
        { workflowId: workflow.definition.id, workspacePath: data.root, goal: 'Verify parked engine gate' },
        ctx,
        { is_autonomous: 'true' },
      );
      if (started.type !== 'success') throw new Error(`Workflow start failed: ${started.error}`);

      const unwrappedStart = unwrapHelper.unwrapResponse(started.data);
      const parsedStart = StepResponseSchema.safeParse(unwrappedStart);
      if (!parsedStart.success) throw new Error('Missing continueToken from start response');
      const continueToken = parsedStart.data.continueToken;

      const notes = 'Producer baseline notes: 8291';
      const parked = await handleV2ContinueWorkflow({
        intent: 'advance',
        continueToken,
        output: { notesMarkdown: notes },
      }, ctx);
      if (parked.type !== 'success') throw new Error('Continue call failed to park at gate');

      const unwrappedGate = unwrapHelper.unwrapResponse(parked.data);
      const parsedGate = GateResponseSchema.safeParse(unwrappedGate);
      if (!parsedGate.success) throw new Error('Failed to unwrap gate checkpoint');

      expect(parsedGate.data.kind).toBe('gate_checkpoint');
      expect(parsedGate.data.gateToken).toBeDefined();

      const rawSessionId = v2Helpers.resolveSessionIdFromToken(continueToken, ctx.v2.tokenAliasStore);
      const sessionId = asSessionId(rawSessionId);
      const loaded = (await ctx.v2.sessionStore.load(sessionId))._unsafeUnwrap();
      expect(loaded.events.length).toBeGreaterThan(0);
      expect(loaded.events.some(e => e.kind === 'session_created')).toBe(true);
      expect(loaded.events.filter(e => e.kind === 'node_output_appended' && e.data.payload.payloadKind === 'notes').map(e => e.data.payload)).toEqual([{ payloadKind: 'notes', notesMarkdown: notes }]);
    } finally {
      await data.cleanup();
    }
  });

  it.each(['direct', 'held'] as const)('requires production resolver boundary (%s): accepts approval, advances successor with retained notes, and enforces resolution invariants', async (mode) => {
    // 1. Module absence fails explicitly with runtime_unavailable.
    // The test runner must detect absence as runtime_unavailable: src/daemon/trusted-gate-resolver.ts.
    const createResolver = await loadProductionGateResolver();

    // 2. Load test helpers
    const { v2Helpers, startHelper, unwrapHelper } = await loadTestHelpers();

    // 3. Build TWO actual parked gate sessions in fixture in the SAME real store
    const data = await v2Helpers.mkV2TestDataDir(`workrail-gate-two-sessions-${mode}-`);
    let resolver: TrustedGateResolverPort | undefined;
    let resolver2: TrustedGateResolverPort | undefined;
    let primaryError: unknown;
    try {
      const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: data.root });
      const base = await v2Helpers.createV2ToolContext(dataDir);
      if (!base.v2) throw new Error('Missing v2 test context');

      const workflow = createWorkflow({
        id: 'gate-resume-contract',
        name: 'Gate resume contract',
        description: 'Two-step gate control',
        version: '1.0.0',
        steps: [
          { id: 'gated', title: 'Gated step', prompt: 'Perform the gated task.', requireConfirmation: true },
          { id: 'after-gate', title: 'After gate', prompt: 'Continue after resolution.' },
        ],
      }, createBundledSource());

      const sharedCtx: V2ToolContext = {
        ...base,
        v2: base.v2,
        featureFlags: new EnvironmentFeatureFlagProvider(),
        workflowService: { ...base.workflowService, getWorkflowById: async () => workflow },
      };

      // Session A
      const notesA = 'Original work notes for session A: 8291-alpha';
      const startedA = await startHelper.startWorkflowForTest(
        { workflowId: workflow.definition.id, workspacePath: data.root, goal: 'Session A verification' },
        sharedCtx,
        { is_autonomous: 'true' },
      );
      if (startedA.type !== 'success') throw new Error(`Workflow start failed: ${startedA.error}`);
      const parsedStartA = StepResponseSchema.parse(unwrapHelper.unwrapResponse(startedA.data));

      const parkedA = await handleV2ContinueWorkflow({
        intent: 'advance',
        continueToken: parsedStartA.continueToken,
        output: { notesMarkdown: notesA },
      }, sharedCtx);
      if (parkedA.type !== 'success') throw new Error('Session A continue failed to park at gate');
      const parsedGateA = GateResponseSchema.parse(unwrapHelper.unwrapResponse(parkedA.data));
      const gateTokenA = parsedGateA.gateToken;

      // Session B (in same store!)
      const notesB = 'Original work notes for session B: 9342-beta';
      const startedB = await startHelper.startWorkflowForTest(
        { workflowId: workflow.definition.id, workspacePath: data.root, goal: 'Session B verification' },
        sharedCtx,
        { is_autonomous: 'true' },
      );
      if (startedB.type !== 'success') throw new Error(`Workflow start failed: ${startedB.error}`);
      const parsedStartB = StepResponseSchema.parse(unwrapHelper.unwrapResponse(startedB.data));

      const parkedB = await handleV2ContinueWorkflow({
        intent: 'advance',
        continueToken: parsedStartB.continueToken,
        output: { notesMarkdown: notesB },
      }, sharedCtx);
      if (parkedB.type !== 'success') throw new Error('Session B continue failed to park at gate');
      const parsedGateB = GateResponseSchema.parse(unwrapHelper.unwrapResponse(parkedB.data));
      const gateTokenB = parsedGateB.gateToken;

      // Construct resolver bound to the shared explicit context (no defaults to home data)
      const abortController = new AbortController();
      resolver = await createResolver(
        { toolContext: sharedCtx },
        abortController.signal,
      );

      // Get issued subjects and authorities for BOTH from trusted resolver
      const inspectA = await resolver.inspectPending(gateTokenA, abortController.signal);
      if (inspectA.kind !== 'inspected') throw new Error('Expected inspectPending A to succeed');
      const { authority: authA, subject: subjA } = inspectA;

      const inspectB = await resolver.inspectPending(gateTokenB, abortController.signal);
      if (inspectB.kind !== 'inspected') throw new Error('Expected inspectPending B to succeed');
      const { authority: authB, subject: subjB } = inspectB;

      // Subject runId comes strictly from the issued boundary (no fallback run-1)
      expect(subjA.runId).toBeDefined();
      expect(subjB.runId).toBeDefined();

      const decision: GateResolutionDecision = {
        kind: 'approved',
        rationale: 'Step rubric satisfied in evaluation.',
      };

      // Capture before state for Session A
      const sessionDataBeforeA = (await sharedCtx.v2.sessionStore.load(subjA.sessionId))._unsafeUnwrap();
      const eventsBeforeA = [...sessionDataBeforeA.events];
      expect(subjA.gateNodeId).toEqual(expect.any(String));
      expect(eventsBeforeA.flatMap(e => e.kind === 'node_created' && e.data.nodeKind === 'gate_checkpoint' ? [e.scope.nodeId] : [])).toEqual([subjA.gateNodeId]);
      const journalBefore = await snapshotJournal(dataDir.sessionsDir());
      const eventsBeforeB = (await sharedCtx.v2.sessionStore.load(subjB.sessionId))._unsafeUnwrap().events;
      expect(subjA.sessionId).not.toBe(subjB.sessionId);
      expect(eventsBeforeB.flatMap(e => e.kind === 'node_created' && e.data.nodeKind === 'gate_checkpoint' ? [e.scope.nodeId] : [])).toEqual([subjB.gateNodeId]);
      expect(subjA.gateNodeId).not.toBe(subjB.gateNodeId);

      // Pre-decision topology baseline for Session A
      const topologyBeforeA = eventsBeforeA.filter(e => e.kind === 'node_created' || e.kind === 'edge_created');

      // 1. Refusal: Wrong pair valid authority authA + foreign subject subjB
      const wrongPairResult = await resolver.resolveGate(authA, subjB, decision, abortController.signal);
      expect(wrongPairResult.kind).toBe('refused');
      if (wrongPairResult.kind === 'refused') {
        expect(['invalid_authority', 'subject_mismatch']).toContain(wrongPairResult.reason);
      }
      const eventsAfterWrongPair = (await sharedCtx.v2.sessionStore.load(subjA.sessionId))._unsafeUnwrap().events;
      expect(eventsAfterWrongPair).toEqual(eventsBeforeA);
      expect((await sharedCtx.v2.sessionStore.load(subjB.sessionId))._unsafeUnwrap().events).toEqual(eventsBeforeB);
      expect(await snapshotJournal(dataDir.sessionsDir())).toEqual(journalBefore);

      // 2. Refusal: Tampered authority
      const tamperedAuth = 'tampered-auth-token-xyz' as GateAuthorityRef;
      const tamperedResult = await resolver.resolveGate(tamperedAuth, subjA, decision, abortController.signal);
      expect(tamperedResult.kind).toBe('refused');
      if (tamperedResult.kind === 'refused') {
        expect(tamperedResult.reason).toBe('invalid_authority');
      }
      const eventsAfterTampered = (await sharedCtx.v2.sessionStore.load(subjA.sessionId))._unsafeUnwrap().events;
      expect(eventsAfterTampered).toEqual(eventsBeforeA);
      expect(await snapshotJournal(dataDir.sessionsDir())).toEqual(journalBefore);

      // 3. Refusal: Same subject modified revision
      const staleRevSubject: GateSubject = { ...subjA, workRevision: 'stale-rev-999' as WorkRevisionRef };
      const staleRevResult = await resolver.resolveGate(authA, staleRevSubject, decision, abortController.signal);
      expect(staleRevResult.kind).toBe('refused');
      if (staleRevResult.kind === 'refused') {
        expect(staleRevResult.reason).toBe('stale_revision');
      }
      const eventsAfterStaleRev = (await sharedCtx.v2.sessionStore.load(subjA.sessionId))._unsafeUnwrap().events;
      expect(eventsAfterStaleRev).toEqual(eventsBeforeA);
      expect(await snapshotJournal(dataDir.sessionsDir())).toEqual(journalBefore);

      // 4. Refusal: Same subject modified occurrence
      const badOccSubject: GateSubject = { ...subjA, gateNodeId: subjB.gateNodeId };
      const badOccResult = await resolver.resolveGate(authA, badOccSubject, decision, abortController.signal);
      expect(badOccResult.kind).toBe('refused');
      if (badOccResult.kind === 'refused') {
        expect(badOccResult.reason).toBe('subject_mismatch');
      }
      const eventsAfterBadOcc = (await sharedCtx.v2.sessionStore.load(subjA.sessionId))._unsafeUnwrap().events;
      expect(eventsAfterBadOcc).toEqual(eventsBeforeA);
      expect(await snapshotJournal(dataDir.sessionsDir())).toEqual(journalBefore);

      // 5. Refusal: Same subject modified runId
      const badRunSubject: GateSubject = { ...subjA, runId: asRunId('foreign-run-identity') };
      const badRunResult = await resolver.resolveGate(authA, badRunSubject, decision, abortController.signal);
      expect(badRunResult.kind).toBe('refused');
      if (badRunResult.kind === 'refused') {
        expect(badRunResult.reason).toBe('subject_mismatch');
      }
      const eventsAfterBadRun = (await sharedCtx.v2.sessionStore.load(subjA.sessionId))._unsafeUnwrap().events;
      expect(eventsAfterBadRun).toEqual(eventsBeforeA);
      expect(await snapshotJournal(dataDir.sessionsDir())).toEqual(journalBefore);

      let activeResolver: TrustedGateResolverPort = resolver;
      let activeAuthA: GateAuthorityRef = authA;
      let activeSubjA: GateSubject = subjA;

      if (mode === 'held') {
        // 6. Uncertainty evaluation on Session A: recorded as observation, gate remains held without advancement
        const uncertainDecision: GateResolutionDecision = {
          kind: 'uncertain',
          rationale: 'Evaluator findings ambiguous; observation recorded for pending gate.',
        };
        const uncertainResult = await resolver.resolveGate(authA, subjA, uncertainDecision, abortController.signal);
        expect(uncertainResult.kind).toBe('held');
        if (uncertainResult.kind !== 'held') throw new Error('Expected held outcome for uncertain decision');
        expect(uncertainResult.disposition).toBe('uncertain');
        expect((uncertainResult as { continueToken?: unknown }).continueToken).toBeUndefined();
        expect(typeof uncertainResult.receipt).toBe('string');
        expect(uncertainResult.subject).toEqual(subjA);

        // Verify retained notes and compare node_created/edge_created topology events against pre-decision baseline
        const sessionAfterUncertain = (await sharedCtx.v2.sessionStore.load(subjA.sessionId))._unsafeUnwrap();
        const topologyAfterUncertainA = sessionAfterUncertain.events.filter(
          e => e.kind === 'node_created' || e.kind === 'edge_created'
        );
        expect(topologyAfterUncertainA).toEqual(topologyBeforeA);
        const notesEventsAfterUncertain = sessionAfterUncertain.events.flatMap(e =>
          e.kind === 'node_output_appended' && e.data.payload.payloadKind === 'notes'
            ? [e.data.payload.notesMarkdown] : []);
        expect(notesEventsAfterUncertain).toEqual([notesA]);

        // Exact uncertainty replay: returns identical receipt, no writes / unchanged journal
        const journalAfterUncertain = await snapshotJournal(dataDir.sessionsDir());
        const eventsAfterUncertain = [...sessionAfterUncertain.events];
        const replayUncertainResult = await resolver.resolveGate(authA, subjA, uncertainDecision, abortController.signal);
        expect(replayUncertainResult.kind).toBe('replay');
        if (replayUncertainResult.kind !== 'replay') throw new Error('Expected replay outcome for uncertainty');
        expect(replayUncertainResult.disposition).toBe('uncertain');
        if (replayUncertainResult.disposition === 'uncertain') {
          expect(replayUncertainResult.receipt).toBe(uncertainResult.receipt);
          expect(replayUncertainResult.subject).toEqual(subjA);
          expect((replayUncertainResult as { continueToken?: unknown }).continueToken).toBeUndefined();
        }
        expect((await sharedCtx.v2.sessionStore.load(subjA.sessionId))._unsafeUnwrap().events).toEqual(eventsAfterUncertain);
        expect(await snapshotJournal(dataDir.sessionsDir())).toEqual(journalAfterUncertain);

        // Close first resolver with timeout and confirmed closed BEFORE creating second; untrack only upon confirmed close
        if (resolver) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const closed: RuntimeCloseResult = await Promise.race([
              resolver.close(AbortSignal.timeout(2500)),
              new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Resolver close timed out')), 3000); }),
            ]);
            if (closed.kind !== 'closed') throw new Error(`Resolver close incomplete: ${closed.reason}`);
            resolver = undefined;
          } finally { if (timer) clearTimeout(timer); }
        }

        // Recompose trusted resolver with same actual context (not process crash)
        resolver2 = await createResolver(
          { toolContext: sharedCtx },
          abortController.signal,
        );

        // Replay uncertain observation after recomposition too, assert original receipt and unchanged journal
        const journalBeforeRecomposeReplay = await snapshotJournal(dataDir.sessionsDir());
        const eventsBeforeRecomposeReplay = (await sharedCtx.v2.sessionStore.load(subjA.sessionId))._unsafeUnwrap().events;
        const replayAfterRecompose = await resolver2.resolveGate(authA, subjA, uncertainDecision, abortController.signal);
        expect(replayAfterRecompose.kind).toBe('replay');
        if (replayAfterRecompose.kind !== 'replay') throw new Error('Expected replay outcome for uncertainty after recomposition');
        expect(replayAfterRecompose.disposition).toBe('uncertain');
        if (replayAfterRecompose.disposition === 'uncertain') {
          expect(replayAfterRecompose.receipt).toBe(uncertainResult.receipt);
          expect(replayAfterRecompose.subject).toEqual(subjA);
          expect((replayAfterRecompose as { continueToken?: unknown }).continueToken).toBeUndefined();
        }
        expect((await sharedCtx.v2.sessionStore.load(subjA.sessionId))._unsafeUnwrap().events).toEqual(eventsBeforeRecomposeReplay);
        expect(await snapshotJournal(dataDir.sessionsDir())).toEqual(journalBeforeRecomposeReplay);

        // Reinspect pending same subject then approve. Use current active resolver and auth.
        const reinspectA = await resolver2.inspectPending(gateTokenA, abortController.signal);
        expect(reinspectA.kind).toBe('inspected');
        if (reinspectA.kind !== 'inspected') throw new Error('Expected gate to remain pending after uncertainty observation');
        expect(reinspectA.subject).toEqual(subjA);

        activeResolver = resolver2;
        activeAuthA = reinspectA.authority;
        activeSubjA = reinspectA.subject;
      }

      // 7. Rightful approval on active revision: confirms approved with stable receipt + actual next continueToken
      const acceptedResult = await activeResolver.resolveGate(activeAuthA, activeSubjA, decision, abortController.signal);
      expect(acceptedResult.kind).toBe('accepted');
      if (acceptedResult.kind !== 'accepted') throw new Error('Expected accepted outcome');
      expect(acceptedResult.disposition).toBe('approved');
      expect(typeof acceptedResult.receipt).toBe('string');
      expect(typeof acceptedResult.continueToken).toBe('string');
      expect(acceptedResult.subject).toEqual(subjA);

      // Real next token must advance actual after-gate step to completed via existing continue API
      const successorNotes = 'Successor completed notes: after-gate-complete-7741';
      const continueSuccessor = await handleV2ContinueWorkflow({
        intent: 'advance',
        continueToken: acceptedResult.continueToken,
        output: { notesMarkdown: successorNotes },
      }, sharedCtx);
      if (continueSuccessor.type !== 'success') throw new Error('Successor continue failed');
      const successorResponse = CompleteResponseSchema.parse(unwrapHelper.unwrapResponse(continueSuccessor.data));
      expect(successorResponse.isComplete).toBe(true);

      // Check exact original and successor notes from events (not just event count) - R18 desired assertion
      const sessionAfterAdvance = (await sharedCtx.v2.sessionStore.load(subjA.sessionId))._unsafeUnwrap();
      const exactNotes = sessionAfterAdvance.events.flatMap(e =>
        e.kind === 'node_output_appended' && e.data.payload.payloadKind === 'notes'
          ? [e.data.payload.notesMarkdown] : []);
      expect(exactNotes).toEqual([notesA, successorNotes]);

      // Replay same receipt: no extra changes, returns identical receipt
      const eventsAfterSuccessor = [...sessionAfterAdvance.events];
      const journalAfterSuccessor = await snapshotJournal(dataDir.sessionsDir());
      const replayResult = await activeResolver.resolveGate(activeAuthA, activeSubjA, decision, abortController.signal);
      expect(replayResult.kind).toBe('replay');
      if (replayResult.kind === 'replay') {
        expect(replayResult.receipt).toBe(acceptedResult.receipt);
        expect(replayResult.disposition).toBe('approved');
        expect(replayResult.subject).toEqual(subjA);
        expect(replayResult.continueToken).toBe(acceptedResult.continueToken);
      }
      const eventsAfterReplay = (await sharedCtx.v2.sessionStore.load(subjA.sessionId))._unsafeUnwrap().events;
      expect(eventsAfterReplay).toEqual(eventsAfterSuccessor);
      expect(await snapshotJournal(dataDir.sessionsDir())).toEqual(journalAfterSuccessor);

      if (mode === 'held') {
        // 8. Rejection on Session B: conditional only held
        // Assert session B events unchanged after A completes before rejection
        const sessionBBeforeReject = (await sharedCtx.v2.sessionStore.load(subjB.sessionId))._unsafeUnwrap();
        expect(sessionBBeforeReject.events).toEqual(eventsBeforeB);
        const topologyBeforeB = eventsBeforeB.filter(e => e.kind === 'node_created' || e.kind === 'edge_created');

        const rejectedDecision: GateResolutionDecision = {
          kind: 'rejected',
          rationale: 'Step rubric failed; work rejected.',
        };
        const rejectedResult = await activeResolver.resolveGate(authB, subjB, rejectedDecision, abortController.signal);
        expect(rejectedResult.kind).toBe('held');
        if (rejectedResult.kind !== 'held') throw new Error('Expected held outcome for rejection');
        expect(rejectedResult.disposition).toBe('rejected');
        expect(typeof rejectedResult.receipt).toBe('string');
        expect(rejectedResult.subject).toEqual(subjB);
        expect((rejectedResult as { continueToken?: unknown }).continueToken).toBeUndefined();

        // Check held exact original notes in Session B, no continuation
        const sessionBAfterReject = (await sharedCtx.v2.sessionStore.load(subjB.sessionId))._unsafeUnwrap();
        const notesBAfterReject = sessionBAfterReject.events.flatMap(e =>
          e.kind === 'node_output_appended' && e.data.payload.payloadKind === 'notes'
            ? [e.data.payload.notesMarkdown] : []);
        expect(notesBAfterReject).toEqual([notesB]);

        // Compare node_created/edge_created topology events against pre-decision baseline for B rejection
        const topologyAfterRejectB = sessionBAfterReject.events.filter(
          e => e.kind === 'node_created' || e.kind === 'edge_created'
        );
        expect(topologyAfterRejectB).toEqual(topologyBeforeB);

        // Replay same receipt, no writes
        const journalAfterReject = await snapshotJournal(dataDir.sessionsDir());
        const eventsBAfterReject = [...sessionBAfterReject.events];
        const replayRejectedResult = await activeResolver.resolveGate(authB, subjB, rejectedDecision, abortController.signal);
        expect(replayRejectedResult.kind).toBe('replay');
        if (replayRejectedResult.kind !== 'replay') throw new Error('Expected replay outcome for rejection');
        expect(replayRejectedResult.disposition).toBe('rejected');
        if (replayRejectedResult.disposition === 'rejected') {
          expect(replayRejectedResult.receipt).toBe(rejectedResult.receipt);
          expect(replayRejectedResult.subject).toEqual(subjB);
          expect((replayRejectedResult as { continueToken?: unknown }).continueToken).toBeUndefined();
        }
        expect((await sharedCtx.v2.sessionStore.load(subjB.sessionId))._unsafeUnwrap().events).toEqual(eventsBAfterReject);
        expect(await snapshotJournal(dataDir.sessionsDir())).toEqual(journalAfterReject);

        // Conflicting later approval refuses without mutation
        const conflictingApproval: GateResolutionDecision = {
          kind: 'approved',
          rationale: 'Contradictory later approval on rejected revision',
        };
        const conflictResult = await activeResolver.resolveGate(authB, subjB, conflictingApproval, abortController.signal);
        expect(conflictResult.kind).toBe('refused');
        if (conflictResult.kind === 'refused') {
          expect(conflictResult.reason).toBe('conflicting_decision');
        }
        expect((await sharedCtx.v2.sessionStore.load(subjB.sessionId))._unsafeUnwrap().events).toEqual(eventsBAfterReject);
        expect(await snapshotJournal(dataDir.sessionsDir())).toEqual(journalAfterReject);
      } else {
        // In direct mode: verify Session B remained untouched throughout Session A advancement
        const sessionBDirect = (await sharedCtx.v2.sessionStore.load(subjB.sessionId))._unsafeUnwrap();
        expect(sessionBDirect.events).toEqual(eventsBeforeB);
      }

    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      const resolversToClose = [resolver, resolver2].filter((r): r is TrustedGateResolverPort => r !== undefined);
      const cleanupErrors: unknown[] = [];
      for (const r of resolversToClose) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const closed: RuntimeCloseResult = await Promise.race([
            r.close(AbortSignal.timeout(2500)),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Resolver close timed out')), 3000); }),
          ]);
          if (closed.kind !== 'closed') throw new Error(`Resolver close incomplete: ${closed.reason}`);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        } finally { if (timer) clearTimeout(timer); }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, `Retained fixture ${data.root}`, { cause: primaryError });
      }
      if (!primaryError) await data.cleanup();
    }
  });
});
