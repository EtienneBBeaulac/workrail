/** Acceptance probe for authorized gate resolution at trusted daemon/engine boundary.
 *
 * Covers:
 * - Producer: Grounded on actual parked engine gate with real session_created event.
 *   Note: Producer notes currently lost on gate checkpoint is known R18; baseline control does not claim retention pass.
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

/** Loads the proposed production resolver factory. Fails via explicit assertion when absent. */
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
      // Note: Producer notes currently lost on gate checkpoint is known R18;
      // this baseline producer control does not claim notes retention.
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

// Real correction is the producer of the stale evaluation; no raw revision edits.
it.each(['pending', 'uncertain', 'rejected'] as const)('trusted gate correction (%s): retained revision, stale decision refusal and fresh evaluation', async disposition => {
  const createResolver = await loadProductionGateResolver();
  const correctorPath = resolve(process.cwd(), 'src/daemon/trusted-gate-corrector.ts');
  try { await stat(correctorPath); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      expect.fail('runtime_unavailable: src/daemon/trusted-gate-corrector.ts');
    }
    throw error;
  }
  const module = await import(/* @vite-ignore */ correctorPath) as {
    createTrustedGateCorrector?: import('../../src/v2/ports/trusted-gate-correction.port.js').CreateTrustedGateCorrector;
  };
  if (typeof module.createTrustedGateCorrector !== 'function') throw new Error('Missing createTrustedGateCorrector export');
  const createCorrector = module.createTrustedGateCorrector;
  const { v2Helpers, startHelper, unwrapHelper } = await loadTestHelpers();
  const data = await v2Helpers.mkV2TestDataDir('workrail-gate-correction-');
  const resources: Array<{ close(signal: AbortSignal): Promise<RuntimeCloseResult> }> = [];
  let primaryError: unknown;
  try {
    const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: data.root });
    const base = await v2Helpers.createV2ToolContext(dataDir);
    if (!base.v2) throw new Error('Missing v2 context');
    const workflow = createWorkflow({
      id: 'gate-correction', name: 'Gate correction', description: 'Retained revision control', version: '1.0.0',
      steps: [
        { id: 'gated', title: 'Gated', prompt: 'Record work.', requireConfirmation: true },
        { id: 'after', title: 'After', prompt: 'Record successor.' },
      ],
    }, createBundledSource());
    const ctx = { ...base, v2: base.v2, featureFlags: new EnvironmentFeatureFlagProvider(),
      workflowService: { ...base.workflowService, getWorkflowById: async () => workflow } };
    const signal = new AbortController().signal;
    const started = await startHelper.startWorkflowForTest({ workflowId: workflow.definition.id, workspacePath: data.root, goal: 'Correct retained work' }, ctx, { is_autonomous: 'true' });
    if (started.type !== 'success') throw new Error(started.error);
    const first = StepResponseSchema.parse(unwrapHelper.unwrapResponse(started.data));
    const originalNotes = `Original evaluated work ${disposition}`;
    const parked = await handleV2ContinueWorkflow({ intent: 'advance', continueToken: first.continueToken, output: { notesMarkdown: originalNotes } }, ctx);
    if (parked.type !== 'success') throw new Error('Expected gate checkpoint');
    const gate = GateResponseSchema.parse(unwrapHelper.unwrapResponse(parked.data));
    expect(gate.kind).toBe('gate_checkpoint');
    const resolver = await createResolver({ toolContext: ctx }, signal); resources.push(resolver);
    const oldEvaluation = await resolver.inspectPending(gate.gateToken, signal);
    if (oldEvaluation.kind !== 'inspected') throw new Error('Expected original evaluation subject');
    if (disposition !== 'pending') {
      const held = await resolver.resolveGate(oldEvaluation.authority, oldEvaluation.subject, { kind: disposition, rationale: 'Needs correction' }, signal);
      expect(held.kind).toBe('held');
    }
    const corrector = await createCorrector({ toolContext: ctx }, signal); resources.push(corrector);
    const target = await corrector.inspectCorrectionTarget(gate.gateToken, signal);
    if (target.kind !== 'eligible') throw new Error('Expected correctable target');
    expect(target.subject).toEqual(oldEvaluation.subject);
    expect(target.priorDisposition).toBe(disposition);
    const before = (await ctx.v2.sessionStore.load(target.subject.sessionId))._unsafeUnwrap().events;
    const beforeBytes = await snapshotJournal(dataDir.sessionsDir());
    const invalid = await corrector.submitCorrection(target.authority, target.subject, { kind: 'notes', notesMarkdown: '' }, signal);
    expect(invalid).toMatchObject({ kind: 'refused', reason: 'validation_failed' });
    expect(await snapshotJournal(dataDir.sessionsDir())).toEqual(beforeBytes);
    const output = { kind: 'notes' as const, notesMarkdown: `Corrected evaluated work ${disposition}` };
    const corrected = await corrector.submitCorrection(target.authority, target.subject, output, signal);
    if (corrected.kind !== 'accepted') throw new Error('Expected accepted correction');
    expect(corrected.priorSubject).toEqual(target.subject);
    expect(corrected.newSubject.sessionId).toBe(target.subject.sessionId);
    expect(corrected.newSubject.runId).toBe(target.subject.runId);
    expect(corrected.newSubject.stepId).toBe(target.subject.stepId);
    expect(corrected.newSubject.gateNodeId).not.toBe(target.subject.gateNodeId);
    expect(corrected.newSubject.workRevision).not.toBe(target.subject.workRevision);
    expect('continueToken' in corrected).toBe(false);
    expect('authority' in corrected).toBe(false);
    expect(await resolver.inspectPending(gate.gateToken, signal)).toMatchObject({ kind: 'refused', reason: 'not_pending' });
    expect(await corrector.inspectCorrectionTarget(gate.gateToken, signal)).toMatchObject({ kind: 'refused', reason: 'stale_revision' });
    const after = (await ctx.v2.sessionStore.load(target.subject.sessionId))._unsafeUnwrap().events;
    expect(after.slice(0, before.length)).toEqual(before);
    const newGateNodes = after.slice(before.length).filter(e => e.kind === 'node_created');
    expect(newGateNodes).toHaveLength(1);
    expect(newGateNodes[0]).toMatchObject({
      scope: { runId: corrected.newSubject.runId, nodeId: corrected.newSubject.gateNodeId },
      data: { nodeKind: 'gate_checkpoint' },
    });
    const notes = (events: typeof after) => events.flatMap(e => e.kind === 'node_output_appended' && e.data.payload.payloadKind === 'notes' ? [e.data.payload.notesMarkdown] : []);
    expect(notes(after)).toEqual([originalNotes, output.notesMarkdown]);
    const afterBytes = await snapshotJournal(dataDir.sessionsDir());
    const late = await resolver.resolveGate(oldEvaluation.authority, oldEvaluation.subject, { kind: 'approved', rationale: 'Late evaluation of original work' }, signal);
    expect(late).toMatchObject({ kind: 'refused', reason: 'stale_revision' });
    expect(await snapshotJournal(dataDir.sessionsDir())).toEqual(afterBytes);
    const conflict = await corrector.submitCorrection(target.authority, target.subject, { kind: 'notes', notesMarkdown: 'Different correction for consumed base' }, signal);
    expect(conflict).toMatchObject({ kind: 'refused', reason: 'conflicting_correction' });
    expect(await snapshotJournal(dataDir.sessionsDir())).toEqual(afterBytes);
    const fresh = await resolver.inspectPending(corrected.reviewGateToken, signal);
    if (fresh.kind !== 'inspected') throw new Error('Expected fresh evaluation subject');
    expect(fresh.subject).toEqual(corrected.newSubject);
    const approved = await resolver.resolveGate(fresh.authority, fresh.subject, { kind: 'approved', rationale: 'Evaluated corrected retained work' }, signal);
    if (approved.kind !== 'accepted') throw new Error('Expected corrected revision approval');
    const successorNotes = `Successor after corrected work ${disposition}`;
    const done = await handleV2ContinueWorkflow({ intent: 'advance', continueToken: approved.continueToken, output: { notesMarkdown: successorNotes } }, ctx);
    if (done.type !== 'success') throw new Error('Expected successor completion');
    expect(CompleteResponseSchema.parse(unwrapHelper.unwrapResponse(done.data)).isComplete).toBe(true);
    expect(notes((await ctx.v2.sessionStore.load(target.subject.sessionId))._unsafeUnwrap().events)).toEqual([originalNotes, output.notesMarkdown, successorNotes]);
    const completedBytes = await snapshotJournal(dataDir.sessionsDir());
    const recomposed = await createCorrector({ toolContext: ctx }, signal); resources.push(recomposed);
    const replay = await recomposed.submitCorrection(target.authority, target.subject, output, signal);
    expect(replay).toEqual({ ...corrected, kind: 'replay' });
    expect(await snapshotJournal(dataDir.sessionsDir())).toEqual(completedBytes);
  } catch (error) { primaryError = error; throw error; }
  finally {
    const errors: unknown[] = [];
    for (const resource of resources.reverse()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([resource.close(AbortSignal.timeout(2500)), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Correction cleanup timeout')), 3000); })]);
        if (result.kind !== 'closed') throw new Error(`Incomplete correction cleanup: ${result.reason}`);
      } catch (error) { errors.push(error); }
      finally { if (timer) clearTimeout(timer); }
    }
    if (errors.length) throw new AggregateError(errors, `Retained fixture ${data.root}`, { cause: primaryError });
    if (!primaryError) await data.cleanup();
  }
});

import type {
  CreateTrustedGateCorrector,
  GateCorrectionAuthorityRef,
  GateCorrectionCommitFaultSeam,
  TrustedGateCorrectorPort,
} from '../../src/v2/ports/trusted-gate-correction.port.js';
import { readVerdictArtifact } from '../../src/coordinators/pr-review.js';
import { type ReviewVerdictArtifactV1 } from '../../src/v2/durable-core/schemas/artifacts/review-verdict.js';
async function loadProductionGateCorrector(): Promise<CreateTrustedGateCorrector> {
  const p = resolve(process.cwd(), 'src/daemon/trusted-gate-corrector.ts');
  try { await stat(p); } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'ENOENT') {
      expect.fail('runtime_unavailable: src/daemon/trusted-gate-corrector.ts');
    }
    throw e;
  }
  const mod = await import(/* @vite-ignore */ p) as { createTrustedGateCorrector?: CreateTrustedGateCorrector };
  const factory = mod.createTrustedGateCorrector;
  if (typeof factory !== 'function') expect.fail('runtime_error: missing createTrustedGateCorrector');
  return factory;
}

const snapshotState = async (dir: LocalDataDirV2): Promise<Record<string, string>> => ({
  ...(await snapshotJournal(dir.sessionsDir())),
  ...(await snapshotJournal(dir.snapshotsDir())),
});

async function safeClose(r: { close(s: AbortSignal): Promise<RuntimeCloseResult> }): Promise<void> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      r.close(AbortSignal.timeout(2500)),
      new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error('Close timeout')), 3000); }),
    ]);
    if (res.kind !== 'closed') throw new Error(`Close incomplete: ${res.reason}`);
  } finally { if (t) clearTimeout(t); }
}

interface Harness {
  data: { root: string; cleanup: () => Promise<void> };
  ctx: V2ToolContext & { v2: NonNullable<V2ToolContext['v2']> };
  signal: AbortSignal;
  unwrapHelper: { unwrapResponse(d: unknown): Record<string, unknown> };
  resolver: TrustedGateResolverPort;
  corrector: TrustedGateCorrectorPort;
  createCorrector: CreateTrustedGateCorrector;
  track<T extends { close(s: AbortSignal): Promise<RuntimeCloseResult> }>(r: T): T;
  park(workflowId: string, goal: string, output: { notesMarkdown?: string; artifacts?: readonly ReviewVerdictArtifactV1[] }): Promise<{ continueToken: string; gateToken: string }>;
  snapshot(): Promise<Record<string, string>>;
  close(resource: { close(s: AbortSignal): Promise<RuntimeCloseResult> }): Promise<void>;
  cleanup(err?: unknown): Promise<void>;
}

async function setupHarness(prefix: string, workflow: ReturnType<typeof createWorkflow>): Promise<Harness> {
  const [createResolver, createCorrector, { v2Helpers, startHelper, unwrapHelper }] = await Promise.all([
    loadProductionGateResolver(), loadProductionGateCorrector(), loadTestHelpers(),
  ]);
  const data = await v2Helpers.mkV2TestDataDir(prefix);
  const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: data.root });
  const base = await v2Helpers.createV2ToolContext(dataDir);
  if (!base.v2) throw new Error('Missing v2');
  const ctx: V2ToolContext & { v2: NonNullable<V2ToolContext['v2']> } = {
    ...base, v2: base.v2, featureFlags: new EnvironmentFeatureFlagProvider(),
    workflowService: { ...base.workflowService, getWorkflowById: async () => workflow },
  };
  const signal = new AbortController().signal;
  const resources: Array<{ close(s: AbortSignal): Promise<RuntimeCloseResult> }> = [];
  const track = <T extends { close(s: AbortSignal): Promise<RuntimeCloseResult> }>(r: T): T => { resources.push(r); return r; };
  try {
  const resolver = track(await createResolver({ toolContext: ctx }, signal));
  const corrector = track(await createCorrector({ toolContext: ctx }, signal));
  return {
    data, ctx, signal, unwrapHelper, resolver, corrector, createCorrector, track,
    snapshot: () => snapshotState(dataDir),
    async park(workflowId, goal, output) {
      const s = await startHelper.startWorkflowForTest({ workflowId, workspacePath: data.root, goal }, ctx, { is_autonomous: 'true' });
      if (s.type !== 'success') throw new Error(s.error);
      const continueToken = StepResponseSchema.parse(unwrapHelper.unwrapResponse(s.data)).continueToken;
      const p = await handleV2ContinueWorkflow({ intent: 'advance', continueToken, output: { ...output, artifacts: output.artifacts ? [...output.artifacts] : undefined } }, ctx);
      if (p.type !== 'success') throw new Error('Park failed');
      return { continueToken, gateToken: GateResponseSchema.parse(unwrapHelper.unwrapResponse(p.data)).gateToken };
    },
    async close(resource) {
      await safeClose(resource);
      const index = resources.indexOf(resource);
      if (index >= 0) resources.splice(index, 1);
    },
    async cleanup(primaryError?: unknown) {
      const errs: unknown[] = [];
      for (const r of resources.reverse()) {
        try { await safeClose(r); } catch (e) { errs.push(e); }
      }
      if (errs.length) throw new AggregateError(errs, `Retained fixture ${data.root}`, { cause: primaryError });
      if (!primaryError) await data.cleanup();
    },
  };
  } catch (primaryError) {
    const errors: unknown[] = [];
    for (const resource of resources.reverse()) { try { await safeClose(resource); } catch (e) { errors.push(e); } }
    if (errors.length) throw new AggregateError(errors, `Retained startup fixture ${data.root}`, { cause: primaryError });
    throw primaryError;
  }
}

it('trusted correction boundaries: wrong pair/tampered/eval authority refused, eligibility enforced, completes', async () => {
  const workflow = createWorkflow({
    id: 'gate-boundaries', name: 'Boundaries', description: 'Boundaries', version: '1.0.0',
    steps: [{ id: 'gated', title: 'Gated', prompt: 'Prompt', requireConfirmation: true }, { id: 'after', title: 'After', prompt: 'After' }],
  }, createBundledSource());
  const h = await setupHarness('workrail-gate-boundaries-', workflow);
  let primaryError: unknown;
  try {
    const [notesA, notesB] = ['Original notes A: 101', 'Original notes B: 202'];
    const gateA = await h.park(workflow.definition.id, 'Session A', { notesMarkdown: notesA });
    const gateB = await h.park(workflow.definition.id, 'Session B', { notesMarkdown: notesB });
    const targetA = await h.corrector.inspectCorrectionTarget(gateA.gateToken, h.signal);
    const targetB = await h.corrector.inspectCorrectionTarget(gateB.gateToken, h.signal);
    if (targetA.kind !== 'eligible' || targetB.kind !== 'eligible') throw new Error('Expected eligible');
    const bytesBefore = await h.snapshot();

    // 1. Wrong pair authA + subjectB -> invalid_authority (auth is cryptographically/logically bound to subject A)
    const wrongPair = await h.corrector.submitCorrection(targetA.authority, targetB.subject, { kind: 'notes', notesMarkdown: 'wrong' }, h.signal);
    expect(wrongPair).toMatchObject({ kind: 'refused', reason: 'invalid_authority' });
    expect(await h.snapshot()).toEqual(bytesBefore);

    // 2. Evaluation authority cast as correction authority -> invalid_authority
    const evalA = await h.resolver.inspectPending(gateA.gateToken, h.signal);
    if (evalA.kind !== 'inspected') throw new Error('Expected inspected');
    const castEval = await h.corrector.submitCorrection(evalA.authority as unknown as GateCorrectionAuthorityRef, targetA.subject, { kind: 'notes', notesMarkdown: 'cast' }, h.signal);
    expect(castEval).toMatchObject({ kind: 'refused', reason: 'invalid_authority' });
    expect(await h.snapshot()).toEqual(bytesBefore);

    // 3. Tampered authority -> invalid_authority
    const tampered = await h.corrector.submitCorrection('tampered-auth' as GateCorrectionAuthorityRef, targetA.subject, { kind: 'notes', notesMarkdown: 'tampered' }, h.signal);
    expect(tampered).toMatchObject({ kind: 'refused', reason: 'invalid_authority' });
    expect(await h.snapshot()).toEqual(bytesBefore);

    // 4. Rightful approval of A via resolver
    const approvedA = await h.resolver.resolveGate(evalA.authority, evalA.subject, { kind: 'approved', rationale: 'Approved A' }, h.signal);
    if (approvedA.kind !== 'accepted') throw new Error('Expected accepted');

    // 5. Correction cap cannot correct approved -> ineligible_gate_state & already_approved
    const approvedBytes = await h.snapshot();
    expect(await h.corrector.inspectCorrectionTarget(gateA.gateToken, h.signal)).toMatchObject({ kind: 'refused', reason: 'already_approved' });
    expect(await h.corrector.submitCorrection(targetA.authority, targetA.subject, { kind: 'notes', notesMarkdown: 'late' }, h.signal)).toMatchObject({ kind: 'refused', reason: 'ineligible_gate_state' });

    expect(await h.snapshot()).toEqual(approvedBytes);

    // 6. Complete after step via continue; inspect -> session_completed; submit -> ineligible_gate_state without bytes changed
    const doneA = await handleV2ContinueWorkflow({ intent: 'advance', continueToken: approvedA.continueToken, output: { notesMarkdown: 'done' } }, h.ctx);
    if (doneA.type !== 'success') throw new Error('Successor A failed');
    expect(CompleteResponseSchema.parse(h.unwrapHelper.unwrapResponse(doneA.data)).isComplete).toBe(true);
    const bytesBeforeLate = await h.snapshot();
    expect(await h.corrector.inspectCorrectionTarget(gateA.gateToken, h.signal)).toMatchObject({ kind: 'refused', reason: 'session_completed' });
    expect(await h.corrector.submitCorrection(targetA.authority, targetA.subject, { kind: 'notes', notesMarkdown: 'late' }, h.signal)).toMatchObject({ kind: 'refused', reason: 'ineligible_gate_state' });
    expect(await h.snapshot()).toEqual(bytesBeforeLate);

    // 7. B still corrects validly and retains notes
    const outputB = { kind: 'notes' as const, notesMarkdown: 'Corrected notes B: 303' };
    const correctedB = await h.corrector.submitCorrection(targetB.authority, targetB.subject, outputB, h.signal);
    expect(correctedB.kind).toBe('accepted');
    const sessionB = (await h.ctx.v2.sessionStore.load(targetB.subject.sessionId))._unsafeUnwrap();
    const notesBList = sessionB.events.flatMap(e => e.kind === 'node_output_appended' && e.data.payload.payloadKind === 'notes' ? [e.data.payload.notesMarkdown] : []);
    expect(notesBList).toEqual([notesB, outputB.notesMarkdown]);
  } catch (err) { primaryError = err; throw err; } finally { await h.cleanup(primaryError); }
});

it('trusted correction reconciliation: fault seam unconfirmed, idempotent replay, contract validation, and scoped artifact read', async () => {
  const workflow = createWorkflow({
    id: 'gate-reconciliation', name: 'Reconciliation', description: 'Reconciliation', version: '1.0.0',
    steps: [
      { id: 'gated', title: 'Review Gate', prompt: 'Review', requireConfirmation: true, outputContract: { contractRef: 'wr.contracts.review_verdict', required: true } },
      { id: 'after', title: 'After', prompt: 'After' },
    ],
  }, createBundledSource());
  const h = await setupHarness('workrail-gate-reconcile-', workflow);
  let primaryError: unknown;
  try {
    const origArtifact: ReviewVerdictArtifactV1 = {
      kind: 'wr.review_verdict', verdict: 'blocking', confidence: 'high',
      findings: [{ severity: 'critical', summary: 'Original blocking defect' }], summary: 'Original blocking verdict',
    };
    const parked = await h.park(workflow.definition.id, 'Reconciliation', { notesMarkdown: 'Orig notes', artifacts: [origArtifact] });
    const oldEval = await h.resolver.inspectPending(parked.gateToken, h.signal);
    if (oldEval.kind !== 'inspected') throw new Error('Expected original evaluation');
    const target = await h.corrector.inspectCorrectionTarget(parked.gateToken, h.signal);
    if (target.kind !== 'eligible') throw new Error('Expected eligible target');

    // Boundary validation: missing required artifact -> validation_failed without writes
    const bytesBeforeVal = await h.snapshot();
    const missing = await h.corrector.submitCorrection(target.authority, target.subject, { kind: 'notes', notesMarkdown: 'Notes only' }, h.signal);
    expect(missing).toMatchObject({ kind: 'refused', reason: 'validation_failed' });
    expect(await h.snapshot()).toEqual(bytesBeforeVal);

    const correctedArtifact: ReviewVerdictArtifactV1 = {
      kind: 'wr.review_verdict', verdict: 'minor', confidence: 'low',
      findings: [{ severity: 'minor', summary: 'Enriched finding', findingCategory: 'correctness', file: 'src/main.ts', startLine: 24 }],
      summary: 'Corrected minor verdict',
    };
    const validOutput = { kind: 'artifacts' as const, artifacts: [correctedArtifact] as const, notesMarkdown: 'Corrected supervisor notes' };

    // Fault seam injection: suppresses ack once -> returns unconfirmed commit_uncertain
    let faultCount = 0;
    let durableAtSeam = false;
    const faultSeam: GateCorrectionCommitFaultSeam = {
      async afterCommit(committedSubject) {
        faultCount++;
        expect(committedSubject.sessionId).toBe(target.subject.sessionId);
        expect(committedSubject.gateNodeId).not.toBe(target.subject.gateNodeId);
        const durable = (await h.ctx.v2.sessionStore.load(target.subject.sessionId))._unsafeUnwrap().events;
        const committedArtifacts = durable.flatMap(e => e.kind === 'node_output_appended' &&
          e.scope.nodeId === committedSubject.gateNodeId && e.data.payload.payloadKind === 'artifact_ref'
            ? [e.data.payload.content] : []);
        expect(committedArtifacts).toEqual([correctedArtifact]);
        durableAtSeam = true;
        return 'suppress_acknowledgement';
      },
    };
    const correctorFault = h.track(await h.createCorrector({ toolContext: h.ctx, faultSeam }, h.signal));
    const priorEvents = [...(await h.ctx.v2.sessionStore.load(target.subject.sessionId))._unsafeUnwrap().events];
    const unconfirmed = await correctorFault.submitCorrection(target.authority, target.subject, validOutput, h.signal);
    expect(unconfirmed).toEqual({ kind: 'unconfirmed', reason: 'commit_uncertain' });
    expect(faultCount).toBe(1);
    expect(durableAtSeam).toBe(true);

    // Store retains both artifacts once, exact history prefix
    const sessionAfterFault = (await h.ctx.v2.sessionStore.load(target.subject.sessionId))._unsafeUnwrap();
    expect(sessionAfterFault.events.slice(0, priorEvents.length)).toEqual(priorEvents);
    const allArtifacts = sessionAfterFault.events.flatMap(e =>
      e.kind === 'node_output_appended' && e.data.payload.payloadKind === 'artifact_ref' ? [e.data.payload.content] : []);
    expect(allArtifacts).toEqual([origArtifact, correctedArtifact]);
    const committedBytes = await h.snapshot();

    // Close corrector bounded before fresh factory without fault
    await h.close(correctorFault);
    const correctorFresh = h.track(await h.createCorrector({ toolContext: h.ctx }, h.signal));

    // Repeat same bound input -> replay stable receipt, new subject, and no additional bytes
    const bytesBeforeReplay = await h.snapshot();
    expect(bytesBeforeReplay).toEqual(committedBytes);
    const replay = await correctorFresh.submitCorrection(target.authority, target.subject, validOutput, h.signal);
    if (replay.kind !== 'replay') throw new Error('Expected replay');
    expect(replay.newSubject.gateNodeId).not.toBe(target.subject.gateNodeId);
    expect(await h.snapshot()).toEqual(bytesBeforeReplay);

    // Repeat replay identical no writes
    const replay2 = await correctorFresh.submitCorrection(target.authority, target.subject, validOutput, h.signal);
    expect(replay2).toEqual(replay);
    expect(await h.snapshot()).toEqual(bytesBeforeReplay);

    // Conflicting payload same base refused conflicting_correction
    const conflictOutput = { kind: 'artifacts' as const, artifacts: [{ ...correctedArtifact, summary: 'Conflict' }] as const };
    const conflict = await correctorFresh.submitCorrection(target.authority, target.subject, conflictOutput, h.signal);
    expect(conflict).toMatchObject({ kind: 'refused', reason: 'conflicting_correction' });
    expect(await h.snapshot()).toEqual(bytesBeforeReplay);

    // Fresh resolver inspectPending matches newSubject
    const freshEval = await h.resolver.inspectPending(replay.reviewGateToken, h.signal);
    if (freshEval.kind !== 'inspected') throw new Error('Expected inspected fresh');
    expect(freshEval.subject).toEqual(replay.newSubject);

    // Old authority approval refused stale_revision
    const staleApproval = await h.resolver.resolveGate(oldEval.authority, oldEval.subject, { kind: 'approved', rationale: 'Old' }, h.signal);
    expect(staleApproval).toMatchObject({ kind: 'refused', reason: 'stale_revision' });
    expect(await h.snapshot()).toEqual(bytesBeforeReplay);

    // New approval + actual successor complete
    const newApproval = await h.resolver.resolveGate(freshEval.authority, freshEval.subject, { kind: 'approved', rationale: 'New' }, h.signal);
    if (newApproval.kind !== 'accepted') throw new Error('Expected new accepted');
    const done = await handleV2ContinueWorkflow({ intent: 'advance', continueToken: newApproval.continueToken, output: { notesMarkdown: 'successor done' } }, h.ctx);
    if (done.type !== 'success') throw new Error('Successor failed');
    expect(CompleteResponseSchema.parse(h.unwrapHelper.unwrapResponse(done.data)).isComplete).toBe(true);

    // Scoped artifact reading via actual exported readVerdictArtifact
    const sessionFinal = (await h.ctx.v2.sessionStore.load(target.subject.sessionId))._unsafeUnwrap();
    const extractArtifacts = (filter: (nodeId: string) => boolean) => sessionFinal.events.flatMap(e =>
      e.kind === 'node_output_appended' && e.data.payload.payloadKind === 'artifact_ref' && filter(e.scope.nodeId)
        ? [e.data.payload.content] : []);

    const oldArtifacts = extractArtifacts(id => id !== replay.newSubject.gateNodeId);
    expect(oldArtifacts).toEqual([origArtifact]);
    const origVerdict = readVerdictArtifact(oldArtifacts);
    expect(origVerdict).toMatchObject({ severity: 'blocking', findingSummaries: ['Original blocking defect'] });

    const newArtifacts = extractArtifacts(id => id === replay.newSubject.gateNodeId);
    expect(newArtifacts).toEqual([correctedArtifact]);
    const newVerdict = readVerdictArtifact(newArtifacts);
    expect(newVerdict).not.toBeNull();
    expect(newVerdict?.severity).toBe('minor');
    expect(newVerdict?.findingSummaries).toEqual(['Enriched finding']);
    expect(newVerdict?.raw).toBeDefined();
    expect(JSON.parse(newVerdict!.raw)).toEqual(correctedArtifact);
    expect(faultCount).toBe(1);
  } catch (err) { primaryError = err; throw err; } finally { await h.cleanup(primaryError); }
});

import type {
  CreateTrustedRunStopper,
  RunStopAuthorityRef,
  RunStopCommitFaultSeam,
  RunStopReceiptRef,
  TrustedRunStopperPort,
} from '../../src/v2/ports/trusted-run-stop.port.js';
async function loadProductionRunStopper(): Promise<CreateTrustedRunStopper> {
  const p = resolve(process.cwd(), 'src/daemon/trusted-run-stop.ts');
  try { await stat(p); } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'ENOENT') {
      expect.fail('runtime_unavailable: src/daemon/trusted-run-stop.ts');
    }
    throw e;
  }
  const mod = await import(/* @vite-ignore */ p) as { createTrustedRunStopper?: CreateTrustedRunStopper };
  if (typeof mod.createTrustedRunStopper !== 'function') expect.fail('runtime_error: missing createTrustedRunStopper');
  return mod.createTrustedRunStopper;
}

it.each(['normal', 'lost_ack'] as const)('trusted run stop: %s', async (mode) => {
  const createStopper = await loadProductionRunStopper();
  const workflow = createWorkflow({
    id: 'gate-run-stop', name: 'Stop', description: 'Run stop', version: '1.0.0',
    steps: [{ id: 'gated', title: 'Gated', prompt: 'Prompt', requireConfirmation: true }, { id: 'after', title: 'After', prompt: 'After' }],
  }, createBundledSource());
  const h = await setupHarness('workrail-run-stop-', workflow);
  let primaryError: unknown;
  try {
    const [notesA, notesB] = ['Original notes A: 401', 'Original notes B: 402'];
    const gateA = await h.park(workflow.definition.id, 'Session A', { notesMarkdown: notesA });
    const gateB = await h.park(workflow.definition.id, 'Session B', { notesMarkdown: notesB });

    let seamObserved = false;
    const faultSeam: RunStopCommitFaultSeam | undefined = mode === 'lost_ack' ? {
      async afterCommit(subject) {
        const events = (await h.ctx.v2.sessionStore.load(subject.sessionId))._unsafeUnwrap().events;
        expect(events.at(-1)).toMatchObject({
          kind: 'run_stopped', scope: { runId: subject.runId },
          data: expect.objectContaining({ receipt: expect.any(String), reason: 'cancelled', detail: 'Stop A detail' }),
        });
        seamObserved = true;
        return 'suppress_acknowledgement';
      },
    } : undefined;

    const stopper = h.track(await createStopper({ toolContext: h.ctx, faultSeam }, h.signal));
    const targetStopA = await stopper.inspectTarget(gateA.gateToken, h.signal);
    const targetStopB = await stopper.inspectTarget(gateB.gateToken, h.signal);
    if (targetStopA.kind !== 'eligible' || targetStopB.kind !== 'eligible') throw new Error('Expected eligible stop targets');

    const evalA = await h.resolver.inspectPending(gateA.gateToken, h.signal);
    const evalB = await h.resolver.inspectPending(gateB.gateToken, h.signal);
    if (evalA.kind !== 'inspected' || evalB.kind !== 'inspected') throw new Error('Expected inspected eval targets');

    const corrTargetA = await h.corrector.inspectCorrectionTarget(gateA.gateToken, h.signal);
    if (corrTargetA.kind !== 'eligible') throw new Error('Expected eligible corr target');
    const correctedNotesA = 'Corrected notes A: 501';
    const correctedA = await h.corrector.submitCorrection(corrTargetA.authority, corrTargetA.subject, { kind: 'notes', notesMarkdown: correctedNotesA }, h.signal);
    if (correctedA.kind !== 'accepted') throw new Error('Expected accepted correction');

    const freshEvalA = await h.resolver.inspectPending(correctedA.reviewGateToken, h.signal);
    const freshCorrA = await h.corrector.inspectCorrectionTarget(correctedA.reviewGateToken, h.signal);
    if (freshEvalA.kind !== 'inspected' || freshCorrA.kind !== 'eligible') throw new Error('Expected fresh targets');

    const snapRefusals = await h.snapshot();
    const wrongPair = await stopper.stop(targetStopA.authority, targetStopB.subject, 'Stop A detail', h.signal);
    expect(wrongPair).toMatchObject({ kind: 'refused', reason: 'subject_mismatch' });
    expect(await h.snapshot()).toEqual(snapRefusals);

    const castEval = await stopper.stop(evalA.authority as unknown as RunStopAuthorityRef, targetStopA.subject, 'Stop A detail', h.signal);
    expect(castEval).toMatchObject({ kind: 'refused', reason: 'invalid_authority' });
    expect(await h.snapshot()).toEqual(snapRefusals);

    const eventsBeforeStopA = (await h.ctx.v2.sessionStore.load(targetStopA.subject.sessionId))._unsafeUnwrap().events;
    const stopAResult = await stopper.stop(targetStopA.authority, targetStopA.subject, 'Stop A detail', h.signal);
    if (mode === 'lost_ack') {
      expect(stopAResult).toEqual({ kind: 'unconfirmed', reason: 'commit_uncertain' });
      expect(seamObserved).toBe(true);
    } else {
      expect(stopAResult).toMatchObject({ kind: 'stopped', reason: 'cancelled', detail: 'Stop A detail', subject: targetStopA.subject });
    }

    const eventsAfterStopA = (await h.ctx.v2.sessionStore.load(targetStopA.subject.sessionId))._unsafeUnwrap().events;
    expect(eventsAfterStopA.slice(0, eventsBeforeStopA.length)).toEqual(eventsBeforeStopA);
    expect(eventsAfterStopA.length).toBe(eventsBeforeStopA.length + 1);
    const stopRecord = eventsAfterStopA[eventsAfterStopA.length - 1];
    expect(stopRecord).toMatchObject({
      kind: 'run_stopped', scope: { runId: targetStopA.subject.runId },
      data: expect.objectContaining({ receipt: expect.any(String), reason: 'cancelled', detail: 'Stop A detail' }),
    });
    const canonicalReceipt = z.object({ data: z.object({ receipt: z.string().min(1) }) }).parse(stopRecord).data.receipt;
    if (stopAResult.kind === 'stopped') expect(stopAResult.receipt).toBe(canonicalReceipt);

    await h.close(stopper);
    const freshStopper = h.track(await createStopper({ toolContext: h.ctx }, h.signal));

    const snapBeforeReplay = await h.snapshot();
    const replaySame = await freshStopper.stop(targetStopA.authority, targetStopA.subject, 'Stop A detail', h.signal);
    expect(replaySame).toEqual({ kind: 'replay', receipt: canonicalReceipt, subject: targetStopA.subject, reason: 'cancelled', detail: 'Stop A detail' });
    expect(await h.snapshot()).toEqual(snapBeforeReplay);

    const replayDiff = await freshStopper.stop(targetStopA.authority, targetStopA.subject, 'Different detail', h.signal);
    expect(replayDiff).toEqual({ kind: 'replay', receipt: canonicalReceipt, subject: targetStopA.subject, reason: 'cancelled', detail: 'Stop A detail' });
    expect(await h.snapshot()).toEqual(snapBeforeReplay);

    const inspectStoppedA = await freshStopper.inspectTarget(correctedA.reviewGateToken, h.signal);
    expect(inspectStoppedA).toEqual({ kind: 'already_stopped', receipt: canonicalReceipt, subject: targetStopA.subject, reason: 'cancelled', detail: 'Stop A detail' });
    expect(await h.snapshot()).toEqual(snapBeforeReplay);
    expect('authority' in inspectStoppedA).toBe(false);

    expect(await h.resolver.resolveGate(freshEvalA.authority, freshEvalA.subject, { kind: 'approved', rationale: 'late' }, h.signal)).toMatchObject({ kind: 'refused', reason: 'session_cancelled' });
    expect(await h.resolver.inspectPending(correctedA.reviewGateToken, h.signal)).toMatchObject({ kind: 'refused', reason: 'session_cancelled' });
    expect(await h.corrector.inspectCorrectionTarget(correctedA.reviewGateToken, h.signal)).toMatchObject({ kind: 'cancelled', reason: 'session_cancelled' });
    expect(await h.corrector.submitCorrection(freshCorrA.authority, freshCorrA.subject, { kind: 'notes', notesMarkdown: 'late' }, h.signal)).toMatchObject({ kind: 'refused', reason: 'session_cancelled' });
    expect(await h.snapshot()).toEqual(snapBeforeReplay);

    const approvedB = await h.resolver.resolveGate(evalB.authority, evalB.subject, { kind: 'approved', rationale: 'Approved B' }, h.signal);
    if (approvedB.kind !== 'accepted') throw new Error('Expected accepted B');
    const doneB = await handleV2ContinueWorkflow({ intent: 'advance', continueToken: approvedB.continueToken, output: { notesMarkdown: 'done B' } }, h.ctx);
    if (doneB.type !== 'success') throw new Error('Successor B failed');
    expect(CompleteResponseSchema.parse(h.unwrapHelper.unwrapResponse(doneB.data)).isComplete).toBe(true);

    const snapCompletedB = await h.snapshot();
    const stopBResult = await freshStopper.stop(targetStopB.authority, targetStopB.subject, 'Stop B detail', h.signal);
    expect(stopBResult).toEqual({ kind: 'already_completed', subject: targetStopB.subject });
    expect(await h.snapshot()).toEqual(snapCompletedB);

    const notesC = 'Original notes C: 601';
    const gateC = await h.park(workflow.definition.id, 'Session C', { notesMarkdown: notesC });
    const targetStopC = await freshStopper.inspectTarget(gateC.gateToken, h.signal);
    if (targetStopC.kind !== 'eligible') throw new Error('Expected eligible stop C');
    const stopCResult = await freshStopper.stop(targetStopC.authority, targetStopC.subject, 'Stop C detail', h.signal);
    if (stopCResult.kind !== 'stopped') throw new Error('Expected stopped C');

    const snapBeforeAdvanceC = await h.snapshot();
    const advanceC = await handleV2ContinueWorkflow({ intent: 'advance', continueToken: gateC.gateToken, output: { notesMarkdown: 'New notes C' } }, h.ctx);
    expect(advanceC).toMatchObject({
      type: 'error', code: 'PRECONDITION_FAILED', retry: { kind: 'not_retryable' },
      details: { kind: 'run_stopped', receipt: stopCResult.receipt, subject: targetStopC.subject, reason: 'cancelled', detail: 'Stop C detail' },
    });
    expect(await h.snapshot()).toEqual(snapBeforeAdvanceC);

    const notesAEvents = (await h.ctx.v2.sessionStore.load(targetStopA.subject.sessionId))._unsafeUnwrap().events.flatMap(e =>
      e.kind === 'node_output_appended' && e.data.payload.payloadKind === 'notes' ? [e.data.payload.notesMarkdown] : []);
    expect(notesAEvents).toEqual([notesA, correctedNotesA]);

    const notesCEvents = (await h.ctx.v2.sessionStore.load(targetStopC.subject.sessionId))._unsafeUnwrap().events.flatMap(e =>
      e.kind === 'node_output_appended' && e.data.payload.payloadKind === 'notes' ? [e.data.payload.notesMarkdown] : []);
    expect(notesCEvents).toEqual([notesC]);
  } catch (err) { primaryError = err; throw err; } finally { await h.cleanup(primaryError);
  }
});

it('serializes duplicate correction and stop submissions without duplicate effects', async () => {
  const workflow = createWorkflow({ id: 'gate-concurrent-supervision', name: 'Concurrent', description: 'Concurrent supervision', version: '1.0.0',
    steps: [{ id: 'gated', title: 'Gated', prompt: 'Prompt', requireConfirmation: true }, { id: 'after', title: 'After', prompt: 'After' }] }, createBundledSource());
  const h = await setupHarness('workrail-concurrent-supervision-', workflow);
  let primaryError: unknown;
  try {
    const gate = await h.park(workflow.definition.id, 'Concurrent corrections', { notesMarkdown: 'Original evidence' });
    const target = await h.corrector.inspectCorrectionTarget(gate.gateToken, h.signal);
    if (target.kind !== 'eligible') throw new Error('Expected correction target');
    const second = h.track(await h.createCorrector({ toolContext: h.ctx }, h.signal));
    const output = { kind: 'notes' as const, notesMarkdown: 'Corrected evidence' };
    const results = await Promise.all([h.corrector, second].map(port => port.submitCorrection(target.authority, target.subject, output, h.signal)));
    expect(results.filter(result => result.kind === 'accepted')).toHaveLength(1);
    const reconciled = await Promise.all([h.corrector, second].map(port => port.submitCorrection(target.authority, target.subject, output, h.signal)));
    // A contender may be refused while the lock is held; sequential reconciliation must be stable.
    const replay = await second.submitCorrection(target.authority, target.subject, output, h.signal);
    expect(replay.kind).toBe('replay');
    expect(reconciled.some(result => result.kind === 'replay')).toBe(true);
    if (replay.kind !== 'replay') throw new Error('Expected correction replay');
    const createStopper = await loadProductionRunStopper();
    const stopper = h.track(await createStopper({ toolContext: h.ctx }, h.signal));
    const otherStopper = h.track(await createStopper({ toolContext: h.ctx }, h.signal));
    const stopTarget = await stopper.inspectTarget(replay.reviewGateToken, h.signal);
    if (stopTarget.kind !== 'eligible') throw new Error('Expected stop target');
    const stopped = await Promise.all([stopper, otherStopper].map(port => port.stop(stopTarget.authority, stopTarget.subject, 'Stop once', h.signal)));
    expect(stopped.filter(result => result.kind === 'stopped')).toHaveLength(1);
    const stableStop = await otherStopper.stop(stopTarget.authority, stopTarget.subject, 'Different later detail', h.signal);
    expect(stableStop).toMatchObject({ kind: 'replay', detail: 'Stop once' });
    const events = (await h.ctx.v2.sessionStore.load(target.subject.sessionId))._unsafeUnwrap().events;
    expect(events.filter(event => event.kind === 'gate_correction_recorded')).toHaveLength(1);
    expect(events.filter(event => event.kind === 'run_stopped')).toHaveLength(1);
    expect(events.flatMap(event => event.kind === 'node_output_appended' && event.data.payload.payloadKind === 'notes' ? [event.data.payload.notesMarkdown] : [])).toEqual(['Original evidence', 'Corrected evidence']);
  } catch (err) { primaryError = err; throw err; } finally { await h.cleanup(primaryError); }
});

import { ResultAsync } from 'neverthrow';
import { parseContinueTokenOrFail, mintSingleShortToken } from '../../src/v2/usecases/v2-token-ops.js';

it.each(['uncertain', 'approved'] as const)('resolution remains unconfirmed after a committed %s append rejects', async kind => {
  const workflow = createWorkflow({ id: 'resolution-ack-loss', name: 'Ack loss', description: 'Ack loss', version: '1.0.0',
    steps: [{ id: 'gated', title: 'Gated', prompt: 'Prompt', requireConfirmation: true }, { id: 'after', title: 'After', prompt: 'After' }] }, createBundledSource());
  const h = await setupHarness('workrail-resolution-ack-loss-', workflow);
  let primaryError: unknown;
  try {
    const gate = await h.park(workflow.definition.id, 'Resolution ack loss', { notesMarkdown: 'Evidence' });
    const inspected = await h.resolver.inspectPending(gate.gateToken, h.signal);
    if (inspected.kind !== 'inspected') throw new Error('Expected pending gate');
    const original = h.ctx.v2.sessionStore;
    const createResolver = await loadProductionGateResolver();
    const faulty = h.track(await createResolver({ toolContext: { ...h.ctx, v2: { ...h.ctx.v2, sessionStore: {
      ...original, load: original.load.bind(original),
      append: (...args) => original.append(...args).andThen(() => new ResultAsync(Promise.reject(new Error('Lost acknowledgement after commit')))),
    } } } }, h.signal));
    const decision = { kind, rationale: 'Reviewed' };
    expect(await faulty.resolveGate(inspected.authority, inspected.subject, decision, h.signal)).toEqual({ kind: 'unconfirmed', reason: 'commit_uncertain' });
    const beforeReplay = await h.snapshot();
    expect(await h.resolver.resolveGate(inspected.authority, inspected.subject, decision, h.signal)).toMatchObject({ kind: 'replay', disposition: kind });
    expect(await h.snapshot()).toEqual(beforeReplay);
  } catch (err) { primaryError = err; throw err; } finally { await h.cleanup(primaryError); }
});

it('cannot resolve a stranded gate after another branch completes the run', async () => {
  const workflow = createWorkflow({ id: 'completed-gate-branch', name: 'Completed branch', description: 'Completed branch', version: '1.0.0',
    steps: [{ id: 'gated', title: 'Gated', prompt: 'Prompt', requireConfirmation: true }, { id: 'after', title: 'After', prompt: 'After' }] }, createBundledSource());
  const h = await setupHarness('workrail-completed-gate-', workflow);
  let primaryError: unknown;
  try {
    const gate = await h.park(workflow.definition.id, 'Original branch', { notesMarkdown: 'Original evidence' });
    const old = await h.resolver.inspectPending(gate.gateToken, h.signal);
    if (old.kind !== 'inspected') throw new Error('Expected pending original gate');
    const v2 = h.ctx.v2;
    const parsed = (await parseContinueTokenOrFail(gate.continueToken, v2.tokenCodecPorts, v2.tokenAliasStore))._unsafeUnwrap();
    const fork = (await mintSingleShortToken({ kind: 'continue', entry: { sessionId: parsed.sessionId, runId: parsed.runId,
      nodeId: parsed.nodeId, attemptId: String(v2.idFactory.mintAttemptId()), workflowHashRef: String(parsed.workflowHashRef) },
      ports: v2.tokenCodecPorts, aliasStore: v2.tokenAliasStore, entropy: v2.entropy }))._unsafeUnwrap();
    const parked = await handleV2ContinueWorkflow({ intent: 'advance', continueToken: fork, output: { notesMarkdown: 'Fork evidence' } }, h.ctx);
    if (parked.type !== 'success') throw new Error('Expected fork gate');
    const target = await h.resolver.inspectPending(GateResponseSchema.parse(h.unwrapHelper.unwrapResponse(parked.data)).gateToken, h.signal);
    if (target.kind !== 'inspected') throw new Error('Expected fork target');
    const approved = await h.resolver.resolveGate(target.authority, target.subject, { kind: 'approved', rationale: 'Fork reviewed' }, h.signal);
    if (approved.kind !== 'accepted') throw new Error('Expected approval');
    const done = await handleV2ContinueWorkflow({ intent: 'advance', continueToken: approved.continueToken, output: { notesMarkdown: 'Done' } }, h.ctx);
    if (done.type !== 'success') throw new Error('Expected completion');
    expect(CompleteResponseSchema.parse(h.unwrapHelper.unwrapResponse(done.data)).isComplete).toBe(true);
    const beforeLate = await h.snapshot();
    expect(await h.resolver.inspectPending(gate.gateToken, h.signal)).toMatchObject({ kind: 'refused', reason: 'not_pending' });
    expect(await h.resolver.resolveGate(old.authority, old.subject, { kind: 'approved', rationale: 'Late' }, h.signal)).toMatchObject({ kind: 'refused', reason: 'conflicting_decision' });
    expect(await h.snapshot()).toEqual(beforeLate);
  } catch (err) { primaryError = err; throw err; } finally { await h.cleanup(primaryError); }
});

it('reports correction cancellation before append without stopping the run', async () => {
  const workflow = createWorkflow({ id: 'correction-precommit-cancel', name: 'Cancel', description: 'Cancel', version: '1.0.0',
    steps: [{ id: 'gated', title: 'Gated', prompt: 'Prompt', requireConfirmation: true }] }, createBundledSource());
  const h = await setupHarness('workrail-correction-cancel-', workflow);
  let primaryError: unknown;
  try {
    const gate = await h.park(workflow.definition.id, 'Cancellation', { notesMarkdown: 'Original' });
    const target = await h.corrector.inspectCorrectionTarget(gate.gateToken, h.signal);
    if (target.kind !== 'eligible') throw new Error('Expected correction target');
    const controller = new AbortController();
    const snapshots = h.ctx.v2.snapshotStore;
    const corrector = h.track(await h.createCorrector({ toolContext: { ...h.ctx, v2: { ...h.ctx.v2, snapshotStore: {
      ...snapshots, getExecutionSnapshotV1: snapshots.getExecutionSnapshotV1.bind(snapshots),
      putExecutionSnapshotV1: snapshot => snapshots.putExecutionSnapshotV1(snapshot).map(ref => { controller.abort(); return ref; }),
    } } } }, h.signal));
    const before = (await h.ctx.v2.sessionStore.load(target.subject.sessionId))._unsafeUnwrap().events;
    expect(await corrector.submitCorrection(target.authority, target.subject, { kind: 'notes', notesMarkdown: 'Cancelled' }, controller.signal))
      .toEqual({ kind: 'cancelled', reason: 'operation_aborted' });
    expect((await h.ctx.v2.sessionStore.load(target.subject.sessionId))._unsafeUnwrap().events).toEqual(before);
    expect(await h.corrector.inspectCorrectionTarget(gate.gateToken, h.signal)).toMatchObject({ kind: 'eligible' });
  } catch (err) { primaryError = err; throw err; } finally { await h.cleanup(primaryError); }
});

it('serializes duplicate approvals and refuses replay after durable stop', async () => {
  const workflow = createWorkflow({ id: 'concurrent-resolution', name: 'Concurrent resolution', description: 'Concurrent resolution', version: '1.0.0',
    steps: [{ id: 'gated', title: 'Gated', prompt: 'Prompt', requireConfirmation: true }, { id: 'after', title: 'After', prompt: 'After' }] }, createBundledSource());
  const h = await setupHarness('workrail-concurrent-resolution-', workflow);
  let primaryError: unknown;
  try {
    const gate = await h.park(workflow.definition.id, 'Concurrent approval', { notesMarkdown: 'Evidence' });
    const target = await h.resolver.inspectPending(gate.gateToken, h.signal);
    if (target.kind !== 'inspected') throw new Error('Expected pending gate');
    const createResolver = await loadProductionGateResolver();
    const other = h.track(await createResolver({ toolContext: h.ctx }, h.signal));
    const decision = { kind: 'approved' as const, rationale: 'Approved once' };
    const results = await Promise.all([h.resolver, other].map(port => port.resolveGate(target.authority, target.subject, decision, h.signal)));
    expect(results.filter(result => result.kind === 'accepted')).toHaveLength(1);
    const replay = await other.resolveGate(target.authority, target.subject, decision, h.signal);
    expect(replay.kind).toBe('replay');
    const beforeStop = (await h.ctx.v2.sessionStore.load(target.subject.sessionId))._unsafeUnwrap().events;
    expect(beforeStop.filter(event => event.kind === 'gate_resolution_recorded')).toHaveLength(1);
    const createStopper = await loadProductionRunStopper();
    const stopper = h.track(await createStopper({ toolContext: h.ctx }, h.signal));
    const stopTarget = await stopper.inspectTarget(gate.gateToken, h.signal);
    if (stopTarget.kind !== 'eligible') throw new Error('Expected active run');
    expect(await stopper.stop(stopTarget.authority, stopTarget.subject, 'Stop after approval', h.signal)).toMatchObject({ kind: 'stopped' });
    const stopped = await h.snapshot();
    expect(await other.resolveGate(target.authority, target.subject, decision, h.signal)).toMatchObject({ kind: 'refused', reason: 'session_cancelled' });
    expect(await h.snapshot()).toEqual(stopped);
  } catch (err) { primaryError = err; throw err; } finally { await h.cleanup(primaryError); }
});
