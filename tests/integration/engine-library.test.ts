/**
 * Integration test for the WorkRail library engine.
 *
 * Verifies: factory init, start workflow, continue (rehydrate + advance),
 * branded token types, discriminated union response shapes, and close().
 */

import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { resetContainer } from '../../src/di/container.js';
import { createWorkRailEngine } from '../../src/engine/index.js';
import type { WorkRailEngine, StepResponse, StateToken, AckToken } from '../../src/engine/index.js';

describe('WorkRail library engine', () => {
  let dataDir: string;
  let engine: WorkRailEngine;

  beforeEach(() => {
    resetContainer();
  });

  beforeAll(async () => {
    // Use a temp directory for durable state — isolated per test run
    dataDir = path.join(os.tmpdir(), `workrail-engine-test-${Date.now()}`);
    fs.mkdirSync(dataDir, { recursive: true });
  });

  afterAll(async () => {
    if (engine) await engine.close();
    // Clean up temp directory
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates engine with typed result (not thrown)', async () => {
    const result = await createWorkRailEngine({ dataDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    engine = result.value;
  });

  it('lists workflows', async () => {
    const result = await createWorkRailEngine({ dataDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    engine = result.value;

    const listResult = await engine.listWorkflows();
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;

    expect(listResult.value.workflows.length).toBeGreaterThan(0);
    const bugInvestigation = listResult.value.workflows.find(w => w.workflowId === 'bug-investigation');
    expect(bugInvestigation).toBeDefined();
    expect(bugInvestigation!.name).toBeTruthy();
    expect(bugInvestigation!.description).toBeTruthy();
  });

  it('starts a workflow and receives discriminated ok response', async () => {
    const result = await createWorkRailEngine({ dataDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    engine = result.value;

    const startResult = await engine.startWorkflow('bug-investigation');
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const response: StepResponse = startResult.value;

    // Discriminated union: kind is 'ok'
    expect(response.kind).toBe('ok');

    // Branded tokens are strings at runtime but typed at compile time
    expect(typeof response.stateToken).toBe('string');
    expect(response.stateToken.length).toBeGreaterThan(0);
    expect(typeof response.ackToken).toBe('string');

    // Pending step with prompt
    expect(response.pending).not.toBeNull();
    expect(response.pending!.stepId).toBeTruthy();
    expect(response.pending!.title).toBeTruthy();
    expect(response.pending!.prompt).toBeTruthy();

    // Preferences
    expect(response.preferences.autonomy).toBeTruthy();
    expect(response.preferences.riskPolicy).toBeTruthy();

    // Not complete on first step
    expect(response.isComplete).toBe(false);
    expect(response.nextIntent).toBe('perform_pending_then_continue');
  });

  it('rehydrates (continue without ack) to recover current step', async () => {
    const result = await createWorkRailEngine({ dataDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    engine = result.value;

    const startResult = await engine.startWorkflow('bug-investigation');
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const stateToken: StateToken = startResult.value.stateToken;

    // Rehydrate: null ackToken
    const rehydrateResult = await engine.continueWorkflow(stateToken, null);
    expect(rehydrateResult.ok).toBe(true);
    if (!rehydrateResult.ok) return;

    // Same step returned (rehydrate recovers, doesn't advance)
    expect(rehydrateResult.value.pending?.stepId).toBe(startResult.value.pending?.stepId);
    expect(rehydrateResult.value.nextIntent).toBe('rehydrate_only');
  });

  it('advances with ack and output', async () => {
    const result = await createWorkRailEngine({ dataDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    engine = result.value;

    const startResult = await engine.startWorkflow('bug-investigation');
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const stateToken: StateToken = startResult.value.stateToken;
    const ackToken: AckToken = startResult.value.ackToken!;
    const firstStepId = startResult.value.pending!.stepId;

    // Advance with notes
    const advanceResult = await engine.continueWorkflow(stateToken, ackToken, {
      notesMarkdown: '## Step completed\nDid the investigation.',
    });

    expect(advanceResult.ok).toBe(true);
    if (!advanceResult.ok) return;

    // Should be on a different step (or blocked, either is valid)
    if (advanceResult.value.kind === 'ok' && advanceResult.value.pending) {
      // Advanced to next step
      expect(advanceResult.value.pending.stepId).not.toBe(firstStepId);
    }
    // Response is well-typed
    expect(typeof advanceResult.value.stateToken).toBe('string');
  });

  it('returns typed error for nonexistent workflow', async () => {
    const result = await createWorkRailEngine({ dataDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    engine = result.value;

    const startResult = await engine.startWorkflow('nonexistent-workflow-12345');
    expect(startResult.ok).toBe(false);
    if (startResult.ok) return;

    expect(startResult.error.kind).toBe('workflow_not_found');
    if (startResult.error.kind === 'workflow_not_found') {
      expect(startResult.error.workflowId).toBe('nonexistent-workflow-12345');
    }
  });

  it('returns typed error for invalid token', async () => {
    const result = await createWorkRailEngine({ dataDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    engine = result.value;

    const continueResult = await engine.continueWorkflow(
      'invalid-token' as StateToken,
      null,
    );
    expect(continueResult.ok).toBe(false);
  });
});
