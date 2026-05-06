/**
 * Contract test: coordinator-assembled context reaches the agent system prompt.
 *
 * This test pins the contract between the coordinator output layer and the
 * daemon prompt layer. Each part works in isolation (unit tested elsewhere);
 * this test verifies the seams between them don't silently drop context.
 *
 * Chain under test:
 *   buildContextSummary(phaseArtifacts, targetPhase)   [coordinator output]
 *     -> assembledContextSummary string
 *     -> WorkflowTrigger.context { assembledContextSummary }  [spawnSession constructs this]
 *     -> buildSessionContext(trigger, contextBundle, ...)      [daemon]
 *     -> SessionContext.systemPrompt                           [what the agent sees]
 *
 * If anything in the middle silently drops or transforms the context, this
 * test fails. The unit tests on either end would still pass.
 */

import { describe, it, expect } from 'vitest';
import { buildContextSummary } from '../../src/coordinators/context-assembly.js';
import { buildSessionContext } from '../../src/daemon/core/session-context.js';
import { DAEMON_SOUL_DEFAULT } from '../../src/daemon/core/system-prompt.js';
import type { WorkflowTrigger } from '../../src/daemon/types.js';
import type { ContextBundle } from '../../src/daemon/context-loader.js';
import type { DiscoveryHandoffArtifactV1 } from '../../src/v2/durable-core/schemas/artifacts/discovery-handoff.js';
import type { ShapingHandoffArtifactV1 } from '../../src/v2/durable-core/schemas/artifacts/shaping-handoff.js';
import type { CodingHandoffArtifactV1 } from '../../src/v2/durable-core/schemas/artifacts/coding-handoff.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKSPACE = '/workspace/my-project';

function makeDiscoveryArtifact(overrides: Partial<DiscoveryHandoffArtifactV1> = {}): DiscoveryHandoffArtifactV1 {
  return {
    kind: 'wr.discovery_handoff',
    selectedDirection: 'Use a discriminated union for state transitions',
    keyInvariants: ['No mutation after init', 'Errors are Result types'],
    implementationConstraints: ['Must not change the public API'],
    ...overrides,
  };
}

function makeShapingArtifact(overrides: Partial<ShapingHandoffArtifactV1> = {}): ShapingHandoffArtifactV1 {
  return {
    kind: 'wr.shaping_handoff',
    selectedShape: 'Typed state machine with assertNever guards',
    appetite: 'small',
    keyConstraints: ['No breaking changes', 'Backward-compatible with v1 sessions'],
    outOfScope: ['Migration tool', 'Console visualization'],
    rabbitHoles: ['Full event sourcing would require engine changes'],
    validationChecklist: ['All transitions are exhaustive', 'Error paths return Result'],
    ...overrides,
  };
}

function makeCodingArtifact(overrides: Partial<CodingHandoffArtifactV1> = {}): CodingHandoffArtifactV1 {
  return {
    kind: 'wr.coding_handoff',
    filesChanged: ['src/daemon/state/session-state.ts', 'src/daemon/workflow-runner.ts'],
    keyDecisions: ['Used discriminated union over class hierarchy for testability'],
    knownLimitations: ['Does not handle concurrent token updates'],
    ...overrides,
  };
}

function makeContextBundle(): ContextBundle {
  return {
    soulContent: DAEMON_SOUL_DEFAULT,
    workspaceRules: [],
    sessionHistory: [],
  };
}

function makeTrigger(assembledContextSummary: string): WorkflowTrigger {
  return {
    workflowId: 'wr.coding-task',
    goal: 'Implement state machine refactor',
    workspacePath: WORKSPACE,
    context: { assembledContextSummary },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('context chain contract: coordinator output reaches agent system prompt', () => {
  it('discovery -> shaping: shaping agent system prompt contains discovery selected direction', () => {
    const discovery = makeDiscoveryArtifact();
    const summary = buildContextSummary([discovery], 'shaping');

    expect(summary.length).toBeGreaterThan(0);

    const trigger = makeTrigger(summary);
    const { systemPrompt } = buildSessionContext(trigger, makeContextBundle(), 'Step 1', WORKSPACE);

    expect(systemPrompt).toContain('## Prior Context');
    expect(systemPrompt).toContain(discovery.selectedDirection);
    expect(systemPrompt).toContain('No mutation after init');
    expect(systemPrompt).toContain('Must not change the public API');
  });

  it('discovery + shaping -> coding: coding agent system prompt contains constraints and shape', () => {
    const discovery = makeDiscoveryArtifact();
    const shaping = makeShapingArtifact();
    const summary = buildContextSummary([discovery, shaping], 'coding');

    const trigger = makeTrigger(summary);
    const { systemPrompt } = buildSessionContext(trigger, makeContextBundle(), 'Step 1', WORKSPACE);

    expect(systemPrompt).toContain('## Prior Context');
    expect(systemPrompt).toContain(shaping.selectedShape);
    expect(systemPrompt).toContain('No breaking changes');
    expect(systemPrompt).toContain('Must not change the public API');
  });

  it('discovery + shaping + coding -> review: review agent system prompt contains validation checklist and key decisions', () => {
    const discovery = makeDiscoveryArtifact();
    const shaping = makeShapingArtifact();
    const coding = makeCodingArtifact();
    const summary = buildContextSummary([discovery, shaping, coding], 'review');

    const trigger = makeTrigger(summary);
    const { systemPrompt } = buildSessionContext(trigger, makeContextBundle(), 'Step 1', WORKSPACE);

    expect(systemPrompt).toContain('## Prior Context');
    expect(systemPrompt).toContain('All transitions are exhaustive');
    expect(systemPrompt).toContain('Used discriminated union over class hierarchy for testability');
    expect(systemPrompt).toContain('No breaking changes');
  });

  it('shaping + coding -> fix: fix agent system prompt contains files changed and coding decisions', () => {
    const shaping = makeShapingArtifact();
    const coding = makeCodingArtifact();
    const summary = buildContextSummary([shaping, coding], 'fix');

    const trigger = makeTrigger(summary);
    const { systemPrompt } = buildSessionContext(trigger, makeContextBundle(), 'Step 1', WORKSPACE);

    expect(systemPrompt).toContain('## Prior Context');
    expect(systemPrompt).toContain('src/daemon/state/session-state.ts');
    expect(systemPrompt).toContain('Used discriminated union over class hierarchy for testability');
    expect(systemPrompt).toContain('All transitions are exhaustive');
  });

  it('empty phase artifacts produce no ## Prior Context section', () => {
    const summary = buildContextSummary([], 'coding');
    expect(summary).toBe('');

    const trigger: WorkflowTrigger = {
      workflowId: 'wr.coding-task',
      goal: 'Implement something',
      workspacePath: WORKSPACE,
    };
    const { systemPrompt } = buildSessionContext(trigger, makeContextBundle(), 'Step 1', WORKSPACE);

    expect(systemPrompt).not.toContain('## Prior Context');
  });

  it('context survives spawnSession trigger construction shape', () => {
    // Verifies the trigger shape spawnSession builds (coordinator-deps.ts:304-310)
    // threads context through to the system prompt correctly.
    const summary = 'Selected direction: use discriminated unions. Constraint: no breaking changes.';
    const spawnSessionTrigger: WorkflowTrigger = {
      workflowId: 'wr.coding-task',
      goal: 'Implement the feature',
      workspacePath: WORKSPACE,
      context: { assembledContextSummary: summary },
    };

    const { systemPrompt } = buildSessionContext(
      spawnSessionTrigger,
      makeContextBundle(),
      'Step 1: Do the work.',
      WORKSPACE,
    );

    expect(systemPrompt).toContain('## Prior Context');
    expect(systemPrompt).toContain('use discriminated unions');
    expect(systemPrompt).toContain('no breaking changes');
  });
});
