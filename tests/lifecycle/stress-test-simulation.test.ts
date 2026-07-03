import { createTestValidationPipelineDeps } from '../helpers/v2-test-helpers.js';
import { startWorkflowForTest } from '../helpers/v2-start-workflow-helper.js';
import 'reflect-metadata';
import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { createHash } from 'crypto';

import { executeContinueWorkflow } from '../../src/mcp/handlers/v2-execution/index.js';
import type { ToolContext } from '../../src/mcp/types.js';
import type { V2StartWorkflowInput, V2ContinueWorkflowInput } from '../../src/mcp/v2/tools.js';

import { createWorkflow } from '../../src/types/workflow.js';
import { createProjectDirectorySource } from '../../src/types/workflow-source.js';

import { LocalDataDirV2 } from '../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../src/v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../../src/v2/infra/local/sha256/index.js';
import { LocalSessionEventLogStoreV2 } from '../../src/v2/infra/local/session-store/index.js';
import { LocalSessionLockV2 } from '../../src/v2/infra/local/session-lock/index.js';
import { NodeCryptoV2 } from '../../src/v2/infra/local/crypto/index.js';
import { LocalSnapshotStoreV2 } from '../../src/v2/infra/local/snapshot-store/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../../src/v2/infra/local/pinned-workflow-store/index.js';
import { ExecutionSessionGateV2 } from '../../src/v2/usecases/execution-session-gate.js';

import { unsafeTokenCodecPorts } from '../../src/v2/durable-core/tokens/index.js';
import { InMemoryTokenAliasStoreV2 } from '../../src/v2/infra/in-memory/token-alias-store/index.js';
import { NodeHmacSha256V2 } from '../../src/v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../../src/v2/infra/local/base64url/index.js';
import { LocalKeyringV2 } from '../../src/v2/infra/local/keyring/index.js';
import { NodeRandomEntropyV2 } from '../../src/v2/infra/local/random-entropy/index.js';
import { NodeTimeClockV2 } from '../../src/v2/infra/local/time-clock/index.js';
import { IdFactoryV2 } from '../../src/v2/infra/local/id-factory/index.js';
import { Bech32mAdapterV2 } from '../../src/v2/infra/local/bech32m/index.js';
import { Base32AdapterV2 } from '../../src/v2/infra/local/base32/index.js';

import { parseContinueTokenOrFail } from '../../src/mcp/handlers/v2-token-ops.js';
import { DomainEventV1Schema } from '../../src/v2/durable-core/schemas/session/events.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-breaker-stress-'));
}

async function mkCtxWithWorkflow(workflowId: string, definition: any): Promise<ToolContext> {
  const wf = createWorkflow(
    definition as any,
    createProjectDirectorySource(path.join(os.tmpdir(), 'workrail-project'))
  );

  const dataDir = new LocalDataDirV2(process.env);
  const fsPort = new NodeFileSystemV2();
  const sha256 = new NodeSha256V2();
  const crypto = new NodeCryptoV2();
  const sessionStore = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256);
  const clock = new NodeTimeClockV2();
  const lockPort = new LocalSessionLockV2(dataDir, fsPort, clock);
  const gate = new ExecutionSessionGateV2(lockPort, sessionStore);
  const snapshotStore = new LocalSnapshotStoreV2(dataDir, fsPort, crypto);
  const pinnedStore = new LocalPinnedWorkflowStoreV2(dataDir, fsPort);
  const hmac = new NodeHmacSha256V2();
  const base64url = new NodeBase64UrlV2();
  const entropy = new NodeRandomEntropyV2();
  const idFactory = new IdFactoryV2(entropy);
  const base32 = new Base32AdapterV2();
  const bech32m = new Bech32mAdapterV2();
  const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);
  const keyringRes = await keyringPort.loadOrCreate();
  if (keyringRes.isErr()) throw new Error(`keyring load failed: ${keyringRes.error.code}`);

  const tokenCodecPorts = unsafeTokenCodecPorts({
    keyring: keyringRes.value,
    hmac,
    base64url,
    base32,
    bech32m,
  });

  return {
    workflowService: {
      listWorkflowSummaries: async () => [],
      getWorkflowById: async (id: string) => (id === workflowId ? wf : null),
      getNextStep: async () => {
        throw new Error('not used');
      },
      validateStepOutput: async () => ({ valid: true, issues: [], suggestions: [] }),
    } as any,
    featureFlags: null as any,
    sessionManager: null,
    httpServer: null,
    v2: {
      gate,
      sessionStore,
      snapshotStore,
      pinnedStore,
      sha256,
      crypto,
      entropy,
      idFactory,
      tokenCodecPorts,
      tokenAliasStore: new InMemoryTokenAliasStoreV2(),
      validationPipelineDeps: createTestValidationPipelineDeps(),
      sessionEventLogStore: sessionStore,
    },
  };
}

describe('WorkRail Engine Stress Test & Simulation', () => {
  afterEach(() => {
    delete process.env.WORKRAIL_DATA_DIR;
  });

  const workflowId = 'stress-test';
  const workflowDef = {
    id: workflowId,
    name: 'Stress Test Workflow',
    description: 'Thoroughly stress tests edge cases, circuit breakers, and deduplication',
    version: '1.0.0',
    steps: [
      {
        id: 'coding-step',
        title: 'Coding Step',
        prompt: 'Submit coding handoff.',
        outputContract: {
          contractRef: 'wr.contracts.coding_handoff',
        },
      },
      { id: 'done-step', title: 'Done', prompt: 'All finished.' },
    ],
  };

  it('Scenario 1: Session Rehydration with Missing Run Context defaults limit to 10', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;

    try {
      const ctx = await mkCtxWithWorkflow(workflowId, workflowDef);

      // 1. Start autonomous session
      const startRes = await startWorkflowForTest(
        { workflowId, workspacePath: root, goal: 'stress context rehydration' } as V2StartWorkflowInput,
        ctx,
        { is_autonomous: 'true', triggerSource: 'daemon' }
      );
      expect(startRes.isOk()).toBe(true);
      if (!startRes.isOk()) return;

      const continueToken = startRes.value.response.continueToken;

      // Extract sessionId using the public parser API
      const parsedTokenRes = await parseContinueTokenOrFail(
        continueToken,
        ctx.v2.tokenCodecPorts,
        ctx.v2.tokenAliasStore
      );
      expect(parsedTokenRes.isOk()).toBe(true);
      if (!parsedTokenRes.isOk()) return;

      const sessionId = String(parsedTokenRes.value.sessionId);

      // 2. Perform 3 failed attempts (so depth = 3)
      let currentToken = continueToken;
      let retryToken = '';
      for (let attempt = 1; attempt <= 3; attempt++) {
        const tokenToUse = attempt === 1 ? currentToken : retryToken;
        const res = await executeContinueWorkflow(
          { continueToken: tokenToUse, output: { notesMarkdown: `fail ${attempt}`, artifacts: [{ kind: 'wr.coding_handoff', version: 1 }] } } as V2ContinueWorkflowInput,
          ctx
        );
        expect(res.isOk()).toBe(true);
        if (!res.isOk()) return;
        currentToken = res.value.response.continueToken;
        retryToken = res.value.response.retryContinueToken!;
      }

      // 3. Modifying the event log to simulate missing/corrupted CONTEXT_SET event.
      // We will locate and edit the segments in the events/ directory in-place, and update manifest digests.
      const sessionDir = path.join(root, 'sessions', sessionId);
      const manifestPath = path.join(sessionDir, 'manifest.jsonl');
      const manifestContent = await fs.readFile(manifestPath, 'utf-8');
      const manifestLines = manifestContent.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

      const eventsDir = path.join(sessionDir, 'events');
      const files = await fs.readdir(eventsDir);

      for (const file of files) {
        if (file.endsWith('.jsonl')) {
          const filePath = path.join(eventsDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const lines = content.trim().split('\n').filter(Boolean);

          let fileModified = false;
          const updatedLines = lines.map((line) => {
            const evt = JSON.parse(line);
            if (evt.kind === 'context_set') {
              fileModified = true;
              const updatedContext = { ...evt.data.context };
              delete updatedContext.is_autonomous;
              return JSON.stringify({
                ...evt,
                data: {
                  ...evt.data,
                  context: updatedContext,
                },
              });
            }
            return line;
          });

          if (fileModified) {
            // Validate in memory first
            for (let i = 0; i < updatedLines.length; i++) {
              const parsed = JSON.parse(updatedLines[i]!);
              const validated = DomainEventV1Schema.safeParse(parsed);
              if (!validated.success) {
                console.error(`DIAGNOSTIC: Zod validation failed in memory for line ${i} of segment ${file}:`, validated.error.format());
                console.error("Payload:", updatedLines[i]);
              }
            }

            const newContentBytes = Buffer.from(updatedLines.join('\n') + '\n');
            await fs.writeFile(filePath, newContentBytes);

            // Update digest in the manifest for closed segment
            const relPath = `events/${file}`;
            const segRecord = manifestLines.find(m => m.kind === 'segment_closed' && m.segmentRelPath === relPath);
            if (segRecord) {
              const newDigest = 'sha256:' + createHash('sha256').update(newContentBytes).digest('hex');
              segRecord.sha256 = newDigest;
              segRecord.bytes = newContentBytes.length;
            }
          }
        }
      }

      // Rewrite manifest.jsonl with updated metadata
      const newManifestContent = manifestLines.map(l => JSON.stringify(l)).join('\n') + '\n';
      await fs.writeFile(manifestPath, newManifestContent);

      // 4. Perform the 4th attempt.
      // Under a pure autonomous run, the 4th attempt should fail immediately because limit is 3.
      // BUT because we stripped the context_set event's is_autonomous flag, isAutonomous defaults to false (limit = 10).
      // Therefore, the 4th attempt should NOT fail, but instead gracefully succeed and return a blocked status!
      const fourthAttemptRes = await executeContinueWorkflow(
        { continueToken: retryToken, output: { notesMarkdown: 'fourth attempt notes', artifacts: [{ kind: 'wr.coding_handoff', version: 1 }] } } as V2ContinueWorkflowInput,
        ctx
      );

      if (fourthAttemptRes.isErr()) {
        console.error("fourthAttemptRes error:", fourthAttemptRes.error);
      }

      expect(fourthAttemptRes.isOk()).toBe(true);
      if (!fourthAttemptRes.isOk()) return;
      expect(fourthAttemptRes.value.response.kind).toBe('blocked');
      expect(fourthAttemptRes.value.response.continueToken).toBeDefined();

    } finally {
      await fs.rm(root, { recursive: true, force: true });
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });

  it('Scenario 2: Empty Artifacts Payload returns elegant suggested fixes', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;

    try {
      const ctx = await mkCtxWithWorkflow(workflowId, workflowDef);

      // Start workflow
      const startRes = await startWorkflowForTest(
        { workflowId, workspacePath: root, goal: 'empty artifacts payload test' } as V2StartWorkflowInput,
        ctx,
        { triggerSource: 'mcp' }
      );
      expect(startRes.isOk()).toBe(true);
      if (!startRes.isOk()) return;

      const continueToken = startRes.value.response.continueToken;

      // 1. Test artifacts: [] (empty array)
      const resEmptyArray = await executeContinueWorkflow(
        { continueToken, output: { notesMarkdown: 'recap notes', artifacts: [] } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(resEmptyArray.isOk()).toBe(true);
      if (!resEmptyArray.isOk()) return;
      expect(resEmptyArray.value.response.kind).toBe('blocked');
      const emptyArrBlocker = (resEmptyArray.value.response as any).blockers.blockers[0];
      expect(emptyArrBlocker.message).toBe('Missing required output (contractRef=wr.contracts.coding_handoff).');
      expect(emptyArrBlocker.suggestedFix).toContain("continue_workflow's output.artifacts parameter");

      // 2. Test artifacts: undefined (missing)
      const resUndefined = await executeContinueWorkflow(
        { continueToken, output: { notesMarkdown: 'recap notes' } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(resUndefined.isOk()).toBe(true);
      if (!resUndefined.isOk()) return;
      expect(resUndefined.value.response.kind).toBe('blocked');
      const undefinedBlocker = (resUndefined.value.response as any).blockers.blockers[0];
      expect(undefinedBlocker.message).toBe('Missing required output (contractRef=wr.contracts.coding_handoff).');
      expect(undefinedBlocker.suggestedFix).toContain("continue_workflow's output.artifacts parameter");

    } finally {
      await fs.rm(root, { recursive: true, force: true });
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });

  it('Scenario 3: Rapid Successive Advancing checks both in-process re-entrancy and sequential idempotency', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;

    try {
      const ctx = await mkCtxWithWorkflow(workflowId, workflowDef);

      // Start workflow
      const startRes = await startWorkflowForTest(
        { workflowId, workspacePath: root, goal: 'rapid advancement test' } as V2StartWorkflowInput,
        ctx,
        { triggerSource: 'mcp' }
      );
      expect(startRes.isOk()).toBe(true);
      if (!startRes.isOk()) return;

      const continueToken = startRes.value.response.continueToken;

      // 1. In-process concurrent overlap check.
      // Making concurrent identical advance calls with the exact same continueToken.
      // The in-process ExecutionSessionGateV2 should reject the concurrent re-entrant call with SESSION_LOCK_REENTRANT.
      const [res1, res2] = await Promise.all([
        executeContinueWorkflow(
          { continueToken, output: { notesMarkdown: 'concurrent check', artifacts: [] } } as V2ContinueWorkflowInput,
          ctx
        ),
        executeContinueWorkflow(
          { continueToken, output: { notesMarkdown: 'concurrent check', artifacts: [] } } as V2ContinueWorkflowInput,
          ctx
        ),
      ]);

      // Exactly one must succeed, and the other must fail with SESSION_LOCK_REENTRANT
      const successCount = (res1.isOk() ? 1 : 0) + (res2.isOk() ? 1 : 0);
      expect(successCount).toBe(1);

      const failedRes = res1.isErr() ? res1 : res2;
      const errorDetail = failedRes.error as any;
      expect(errorDetail.kind).toBe('advance_execution_failed');
      expect(errorDetail.cause.code).toBe('SESSION_LOCK_REENTRANT');
      expect(errorDetail.cause.message).toContain('Re-entrant gate call for session:');

      // 2. Sequential rapid calls (sequential idempotency check).
      // If we call executeContinueWorkflow sequentially (waiting for the first to complete),
      // the second call should return a cached idempotent replay of the first response instead of failing!
      const freshStartRes = await startWorkflowForTest(
        { workflowId, workspacePath: root, goal: 'sequential idempotency check' } as V2StartWorkflowInput,
        ctx,
        { triggerSource: 'mcp' }
      );
      expect(freshStartRes.isOk()).toBe(true);
      if (!freshStartRes.isOk()) return;

      const freshToken = freshStartRes.value.response.continueToken;

      const seqRes1 = await executeContinueWorkflow(
        { continueToken: freshToken, output: { notesMarkdown: 'sequential check', artifacts: [] } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(seqRes1.isOk()).toBe(true);
      if (!seqRes1.isOk()) return;

      const seqRes2 = await executeContinueWorkflow(
        { continueToken: freshToken, output: { notesMarkdown: 'sequential check', artifacts: [] } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(seqRes2.isOk()).toBe(true);
      if (!seqRes2.isOk()) return;

      // Both should succeed and return identical blocker tokens, representing perfect idempotent replay!
      expect(seqRes1.value.response.kind).toBe('blocked');
      expect(seqRes2.value.response.kind).toBe('blocked');
      expect(seqRes1.value.response.continueToken).toBe(seqRes2.value.response.continueToken);
      expect(seqRes1.value.response.retryContinueToken).toBe(seqRes2.value.response.retryContinueToken);

    } finally {
      await fs.rm(root, { recursive: true, force: true });
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });
});
