import 'reflect-metadata';
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join, relative } from 'node:path';
import * as os from 'node:os';
import { bootstrap, resetContainer } from '../../src/di/container.js';
import { createToolContext } from '../../src/mcp/server.js';
import { requireV2Context } from '../../src/mcp/types.js';
import { executeStartWorkflow } from '../../src/v2/usecases/start-workflow.js';
import { executeContinueWorkflow } from '../../src/mcp/handlers/v2-execution/index.js';
import { makeCompleteStepTool } from '../../src/daemon/tools/continue-workflow.js';
import { DAEMON_SESSIONS_DIR } from '../../src/daemon/tools/_shared.js';
import { asSessionId } from '../../src/v2/durable-core/ids/index.js';

const firstNotes = 'First task substantive notes documenting the execution evidence in detail for step 1.';
const secondNotes = 'Second task substantive notes documenting the execution evidence in detail for step 2.';

function scanJournalsSync(directory: string, rootDir: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fs.existsSync(directory)) {
    throw new Error(`Directory does not exist for journal scanning: ${directory}`);
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(result, scanJournalsSync(file, rootDir));
    } else if (entry.name.endsWith('.jsonl')) {
      result[relative(rootDir, file)] = fs.readFileSync(file, 'utf8');
    }
  }
  return result;
}

async function scanJournals(directory: string, rootDir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(result, await scanJournals(file, rootDir));
    } else if (entry.name.endsWith('.jsonl')) {
      result[relative(rootDir, file)] = await fsp.readFile(file, 'utf8');
    }
  }
  return result;
}

function extractNotesFromJournalSnapshot(snapshot: Record<string, string>): string[] {
  const notes: string[] = [];
  for (const content of Object.values(snapshot)) {
    for (const line of content.trim().split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.kind === 'node_output_appended' && parsed.data?.payload?.payloadKind === 'notes') {
          notes.push(parsed.data.payload.notesMarkdown as string);
        }
      } catch {
        // Skip non-JSON or partial lines
      }
    }
  }
  return notes;
}

function extractNotesFromEvents(events: readonly any[]): string[] {
  return events
    .filter((e): e is Extract<any, { kind: 'node_output_appended' }> =>
      e.kind === 'node_output_appended' && e.data?.payload?.payloadKind === 'notes',
    )
    .map(e => e.data.payload.notesMarkdown as string);
}

it('exercises daemon crash recovery and invocation replay against real engine and durable sidecar', async () => {
  const root = process.env.WORKRAIL_RESTART_ROOT;
  const phase = process.env.WORKRAIL_RESTART_PHASE;
  const caseType = process.env.WORKRAIL_RESTART_CASE ?? 'duplicate';

  if (!root || !['write', 'read'].includes(phase ?? '')) {
    throw new Error('Use daemon-restart.py to run this fixture in isolated subprocesses');
  }

  // Verify HOME isolation: DAEMON_SESSIONS_DIR must be strictly under owned temporary root
  const expectedHome = join(root, 'home');
  expect(os.homedir(), 'os.homedir() must match isolated temporary HOME').toBe(expectedHome);
  expect(DAEMON_SESSIONS_DIR.startsWith(expectedHome), 'DAEMON_SESSIONS_DIR must be under temporary HOME').toBe(true);

  const workflowsDir = join(root, 'workflows');
  const dataDir = join(root, 'data');
  process.env.WORKFLOW_STORAGE_PATH = workflowsDir;
  process.env.WORKRAIL_DATA_DIR = dataDir;

  if (phase === 'write') {
    // 1. Prepare synthetic two-step notes workflow
    await fsp.mkdir(workflowsDir, { recursive: true });
    await fsp.mkdir(dataDir, { recursive: true });
    const workflowPath = join(workflowsDir, 'two-step-notes.json');
    await fsp.writeFile(
      workflowPath,
      JSON.stringify(
        {
          id: 'two-step-notes',
          name: 'Two-step Notes Workflow',
          version: '1.0.0',
          description: 'Workflow with two sequential tasks requiring substantive notes',
          steps: [
            { id: 'first', title: 'First Task', prompt: 'Perform first task and record notes.' },
            { id: 'second', title: 'Second Task', prompt: 'Perform second task and record notes.' },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    // 2. Bootstrap DI container and acquire real V2 context
    resetContainer();
    await bootstrap({ runtimeMode: { kind: 'cli' } });
    const rawCtx = await createToolContext();
    const guard = requireV2Context(rawCtx);
    if (!guard.ok) throw new Error('Failed to acquire real V2ToolContext');
    const ctx = guard.ctx;

    // 3. Start real workflow directly without onboarding injection
    const daemonSessionId = randomUUID();
    const deps = {
      gate: ctx.v2.gate,
      sessionStore: ctx.v2.sessionStore,
      snapshotStore: ctx.v2.snapshotStore,
      pinnedStore: ctx.v2.pinnedStore,
      crypto: ctx.v2.crypto,
      tokenCodecPorts: ctx.v2.tokenCodecPorts,
      idFactory: ctx.v2.idFactory,
      validationPipelineDeps: ctx.v2.validationPipelineDeps,
      tokenAliasStore: ctx.v2.tokenAliasStore,
      entropy: ctx.v2.entropy,
      resolvedRootUris: ctx.v2.resolvedRootUris,
      rememberedRootsStore: ctx.v2.rememberedRootsStore,
      managedSourceStore: ctx.v2.managedSourceStore,
      workspaceResolver: ctx.v2.workspaceResolver,
      fallbackWorkflowReader: ctx.workflowService,
      featureFlags: ctx.featureFlags,
    };
    const startResult = await executeStartWorkflow(
      deps,
      { workflowId: 'two-step-notes', goal: 'Test invocation replay crash boundary', injectOnboarding: false },
    );
    if (startResult.isErr()) {
      throw new Error(`Start workflow failed: ${JSON.stringify(startResult.error)}`);
    }

    const initialToken = startResult.value.continueToken;
    const workrailSessionId = startResult.value.sessionId;
    let currentToken = initialToken;

    // 4. Instantiate real complete_step tool
    const tool = makeCompleteStepTool(
      daemonSessionId,
      ctx,
      () => currentToken,
      (stepText, token, stepId) => {
        // Enforce: barrier must NOT be kickoff; successor pending step must be 'second'
        if (stepId !== 'second') {
          throw new Error(`onAdvance stepId must be 'second', received: '${stepId}'`);
        }
        currentToken = token;

        // Snapshot sidecar and journal synchronously
        const sidecarPath = join(DAEMON_SESSIONS_DIR, `${daemonSessionId}.json`);
        if (!fs.existsSync(sidecarPath)) {
          throw new Error(`Durable sidecar file missing at barrier: ${sidecarPath}`);
        }
        const sidecarRaw = fs.readFileSync(sidecarPath, 'utf8');
        const sidecarProof = JSON.parse(sidecarRaw);
        if (sidecarProof.continueToken !== token) {
          throw new Error('Sidecar continueToken does not match onAdvance successor token');
        }

        const journalSnapshot = scanJournalsSync(dataDir, root);
        if (Object.keys(journalSnapshot).length === 0) {
          throw new Error('Journal snapshot must not be empty at barrier');
        }

        // Verify actual first task notes materialized exactly once via node_output_appended
        const materializedNotes = extractNotesFromJournalSnapshot(journalSnapshot);
        if (materializedNotes.length !== 1 || materializedNotes[0] !== firstNotes) {
          throw new Error(`Barrier validation failed: expected exact [firstNotes], got: ${JSON.stringify(materializedNotes)}`);
        }

        // Write acknowledged barrier atomically
        const barrierPath = join(root, 'barrier.json');
        const tmpBarrier = `${barrierPath}.tmp`;
        const barrierPayload = {
          ready: true,
          daemonSessionId,
          workrailSessionId,
          initialToken,
          successorToken: token,
          successorPendingStepId: stepId,
          sidecarProof,
          journalSnapshot,
          recordedAt: Date.now(),
        };
        fs.writeFileSync(tmpBarrier, JSON.stringify(barrierPayload, null, 2), 'utf8');
        fs.renameSync(tmpBarrier, barrierPath);

        // Block synchronously until parent kills this process group with SIGKILL
        const sab = new SharedArrayBuffer(4);
        const int32 = new Int32Array(sab);
        while (true) {
          Atomics.wait(int32, 0, 0, 1000);
        }
      },
      () => {
        throw new Error('onComplete should not be called in writer phase for step 1');
      },
      (token) => { currentToken = token; },
      { CompleteStepParams: {} },
      executeContinueWorkflow,
    );

    // 5. Execute model-call-1 for first task. This will enter onAdvance, write barrier, and block.
    const signal = new AbortController().signal;
    await tool.execute('model-call-1', { notes: firstNotes }, signal);

  } else if (phase === 'read') {
    // 1. Verify barrier exists and inspect durable sidecar
    const barrierPath = join(root, 'barrier.json');
    if (!fs.existsSync(barrierPath)) {
      throw new Error(`Barrier file missing in reader phase: ${barrierPath}`);
    }
    const barrier = JSON.parse(await fsp.readFile(barrierPath, 'utf8'));

    // Reconstruct adapter strictly from durable sidecar on disk (no in-memory token passing from parent)
    const sidecarFiles = (await fsp.readdir(DAEMON_SESSIONS_DIR)).filter(f => f.endsWith('.json'));
    expect(sidecarFiles.length, 'Durable sidecar must be present in DAEMON_SESSIONS_DIR').toBeGreaterThan(0);
    const sidecarPath = join(DAEMON_SESSIONS_DIR, `${barrier.daemonSessionId}.json`);
    const sidecarRaw = await fsp.readFile(sidecarPath, 'utf8');
    const sidecar = JSON.parse(sidecarRaw);
    expect(sidecar.continueToken).toBe(barrier.successorToken);

    // Bootstrap DI and real V2 context in reader
    resetContainer();
    await bootstrap({ runtimeMode: { kind: 'cli' } });
    const rawCtx = await createToolContext();
    const guard = requireV2Context(rawCtx);
    if (!guard.ok) throw new Error('Failed to acquire real V2ToolContext in reader');
    const ctx = guard.ctx;

    let currentToken = sidecar.continueToken;
    let completed = false;
    let advanceCount = 0;
    let lastAdvancedStepId: string | undefined = undefined;

    const tool = makeCompleteStepTool(
      barrier.daemonSessionId,
      ctx,
      () => currentToken,
      (stepText, token, stepId) => {
        currentToken = token;
        advanceCount++;
        lastAdvancedStepId = stepId;
      },
      () => {
        completed = true;
      },
      (token) => { currentToken = token; },
      { CompleteStepParams: {} },
      executeContinueWorkflow,
    );

    const signal = new AbortController().signal;

    if (caseType === 'fresh') {
      // Control case:
      // 1. Explicitly rehydrate and deliver second task
      const rehydrateResult = await executeContinueWorkflow(
        { continueToken: currentToken, intent: 'rehydrate' },
        ctx,
      );
      expect(rehydrateResult.isOk()).toBe(true);
      const rehydrated = rehydrateResult._unsafeUnwrap().response;
      expect(rehydrated.pending?.stepId).toBe('second');
      expect(rehydrated.pending?.prompt).toContain('second task');
      if (rehydrated.continueToken) currentToken = rehydrated.continueToken;

      // 2. Perform second task via model-call-2
      const execResult = await tool.execute('model-call-2', { notes: secondNotes }, signal);

      // 3. Inspect durable session store
      const truthResult = await ctx.v2.sessionStore.load(asSessionId(barrier.workrailSessionId));
      expect(truthResult.isOk()).toBe(true);
      const truth = truthResult._unsafeUnwrap();
      const materializedNotes = extractNotesFromEvents(truth.events);

      // Record observation before assertions
      const observation = {
        caseType,
        toolResult: {
          isComplete: (execResult.details as any)?.isComplete,
          kind: (execResult.details as any)?.kind,
        },
        onCompleteCalled: completed,
        advanceCount,
        rehydratedPendingStepId: rehydrated.pending?.stepId,
        materializedNotes,
      };
      await fsp.writeFile(join(root, 'reader-observation.json'), JSON.stringify(observation, null, 2), 'utf8');

      // Assertions:
      expect(completed, 'Fresh case must trigger onComplete').toBe(true);
      expect((execResult.details as any)?.isComplete, 'Fresh case result must be complete').toBe(true);
      expect(materializedNotes, 'Fresh case must materialize exact [firstNotes, secondNotes]').toEqual([firstNotes, secondNotes]);

      // Original journal prefix preserved
      const currentJournals = await scanJournals(dataDir, root);
      for (const [relPath, origContent] of Object.entries(barrier.journalSnapshot as Record<string, string>)) {
        const currentContent = currentJournals[relPath];
        expect(currentContent, `Journal file ${relPath} must exist`).toBeDefined();
        expect(currentContent.startsWith(origContent), `Original journal prefix preserved for ${relPath}`).toBe(true);
      }

    } else if (caseType === 'duplicate') {
      // Duplicate redelivery case:
      // Model (harness) resends original model-call-1 with firstNotes payload
      const execResult = await tool.execute('model-call-1', { notes: firstNotes }, signal);

      // Inspect durable session store
      const truthResult = await ctx.v2.sessionStore.load(asSessionId(barrier.workrailSessionId));
      expect(truthResult.isOk()).toBe(true);
      const truth = truthResult._unsafeUnwrap();
      const materializedNotes = extractNotesFromEvents(truth.events);

      // Record observation BEFORE asserting invariant, so a failing duplicate leaves full durable evidence
      const observation = {
        caseType,
        toolResult: {
          isComplete: (execResult.details as any)?.isComplete,
          kind: (execResult.details as any)?.kind,
        },
        onCompleteCalled: completed,
        advanceCount,
        lastAdvancedStepId,
        materializedNotes,
      };
      await fsp.writeFile(join(root, 'reader-observation.json'), JSON.stringify(observation, null, 2), 'utf8');

      // Verify original journal prefix was preserved across interruption
      const currentJournals = await scanJournals(dataDir, root);
      for (const [relPath, origContent] of Object.entries(barrier.journalSnapshot as Record<string, string>)) {
        const currentContent = currentJournals[relPath];
        expect(currentContent, `Journal file ${relPath} must exist`).toBeDefined();
        expect(currentContent.startsWith(origContent), `Original journal prefix preserved for ${relPath}`).toBe(true);
      }

      // Desired invariant for duplicate:
      // Redelivery MUST NOT consume second task or append second task notes.
      // Second task should still be pending, onComplete must not be called, and notes must remain [firstNotes].
      expect(completed, 'Duplicate redelivery must not trigger onComplete').toBe(false);
      expect((execResult.details as any)?.isComplete, 'Duplicate redelivery must not complete workflow').toBe(false);
      expect(materializedNotes, 'Duplicate redelivery must not consume second task or append duplicate notes').toEqual([firstNotes]);
    }
  }
});
