/**
 * Tests for the three behavioral gaps identified in code review:
 *
 * Gap 1: Drift detection was accidentally cached — loadProjectBindings must
 *         be used for resume-time drift so file changes mid-process are seen.
 *
 * Gap 2: Override removal was not detected as drift — session compiled with
 *         an explicit project override, override later deleted, should warn.
 *
 * Gap 3: Binding resolution was tied to process.cwd() — multi-workspace setups
 *         could silently resolve bindings from the wrong project.
 */

import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadProjectBindings, getProjectBindings } from '../../../src/application/services/compiler/binding-registry.js';
import { detectBindingDrift } from '../../../src/v2/durable-core/domain/binding-drift.js';
import { resolveDefinitionSteps } from '../../../src/application/services/workflow-compiler.js';

// ---------------------------------------------------------------------------
// Gap 1: Drift uses uncached reads
// ---------------------------------------------------------------------------

describe('Gap 1: drift detection uses uncached file reads', () => {
  it('loadProjectBindings always reads current disk state (no cache)', () => {
    const dir = join(tmpdir(), `wr-gap1-${Date.now()}`);
    mkdirSync(join(dir, '.workrail'), { recursive: true });
    const bindingsPath = join(dir, '.workrail', 'bindings.json');

    // Write initial bindings
    writeFileSync(bindingsPath, JSON.stringify({ design_review: 'routine-v1' }), 'utf-8');

    const first = loadProjectBindings('any-workflow', dir);
    expect(first.get('design_review')).toBe('routine-v1');

    // Modify the file mid-process — simulates user changing .workrail/bindings.json
    writeFileSync(bindingsPath, JSON.stringify({ design_review: 'routine-v2' }), 'utf-8');

    // loadProjectBindings must reflect the new value — it must NOT be cached
    const second = loadProjectBindings('any-workflow', dir);
    expect(second.get('design_review')).toBe('routine-v2');

    rmSync(dir, { recursive: true, force: true });
  });

  it('getProjectBindings (cached) does NOT see mid-process file changes — confirming it is NOT used for drift', () => {
    // This test documents the intentional difference: getProjectBindings is cached
    // (correct for compile-time performance) and drift detection must NOT use it.
    const dir = join(tmpdir(), `wr-gap1b-${Date.now()}`);
    mkdirSync(join(dir, '.workrail'), { recursive: true });
    const bindingsPath = join(dir, '.workrail', 'bindings.json');

    writeFileSync(bindingsPath, JSON.stringify({ 'cached-wf': { my_slot: 'initial-value' } }), 'utf-8');

    const workflowId = `cached-wf-${Date.now()}`; // unique ID to avoid sharing cache with other tests
    writeFileSync(
      bindingsPath,
      JSON.stringify({ [workflowId]: { my_slot: 'initial-value' } }),
      'utf-8',
    );

    const first = getProjectBindings(workflowId, dir);
    expect(first.get('my_slot')).toBe('initial-value');

    // Modify the file
    writeFileSync(
      bindingsPath,
      JSON.stringify({ [workflowId]: { my_slot: 'updated-value' } }),
      'utf-8',
    );

    // getProjectBindings returns the cached value — confirms why drift must use loadProjectBindings
    const second = getProjectBindings(workflowId, dir);
    expect(second.get('my_slot')).toBe('initial-value'); // still cached

    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Gap 2: Override removal is detected as drift
// ---------------------------------------------------------------------------

describe('Gap 2: override removal is detected as drift', () => {
  it('emits BINDING_DRIFT when an override is removed from bindings.json', () => {
    // pinnedOverrides contains ONLY project-sourced slots.
    // Removing the override means the slot now falls back to the extensionPoint default.
    const pinnedOverrides = { design_review: 'my-team-routine' };
    const currentBindings = new Map<string, string>(); // override deleted

    const warnings = detectBindingDrift(pinnedOverrides, currentBindings);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.slotId).toBe('design_review');
    expect(warnings[0]!.pinnedValue).toBe('my-team-routine');
    expect(warnings[0]!.currentValue).toBe('default'); // sentinel for removed override
  });

  it('does NOT emit drift for slots that were always at their workflow default', () => {
    // pinnedOverrides is EMPTY when no project overrides existed at compile time.
    // Even if the current bindings are also empty, that is not drift.
    const pinnedOverrides: Record<string, string> = {}; // no overrides at compile time
    const currentBindings = new Map<string, string>(); // still no overrides

    const warnings = detectBindingDrift(pinnedOverrides, currentBindings);
    expect(warnings).toHaveLength(0);
  });

  it('resolveDefinitionSteps correctly separates resolvedBindings from resolvedOverrides', () => {
    // Verify the compiler correctly populates resolvedOverrides (project-sourced only)
    // vs resolvedBindings (all, including defaults).
    const dir = join(tmpdir(), `wr-gap2-${Date.now()}`);
    mkdirSync(join(dir, '.workrail'), { recursive: true });

    const workflowId = `gap2-wf-${Date.now()}`;
    // Only override 'slot_a' — 'slot_b' will use the workflow default
    writeFileSync(
      join(dir, '.workrail', 'bindings.json'),
      JSON.stringify({ [workflowId]: { slot_a: 'project-override-a' } }),
      'utf-8',
    );

    const result = resolveDefinitionSteps(
      [{ id: 'step-1', title: 'Test', prompt: '{{wr.bindings.slot_a}} and {{wr.bindings.slot_b}}' }],
      [],
      [
        { slotId: 'slot_a', purpose: 'Slot A', default: 'default-a' },
        { slotId: 'slot_b', purpose: 'Slot B', default: 'default-b' },
      ],
      workflowId,
      dir,
    );

    expect(result.isOk()).toBe(true);
    const { resolvedBindings, resolvedOverrides } = result._unsafeUnwrap();

    // resolvedBindings has both slots
    expect(resolvedBindings.get('slot_a')).toBe('project-override-a');
    expect(resolvedBindings.get('slot_b')).toBe('default-b');

    // resolvedOverrides only has the project-sourced slot
    expect(resolvedOverrides.get('slot_a')).toBe('project-override-a');
    expect(resolvedOverrides.has('slot_b')).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Gap 3: Workspace-aware binding resolution via baseDir
// ---------------------------------------------------------------------------

describe('Gap 3: workspace-aware binding resolution via baseDir', () => {
  it('resolveDefinitionSteps uses baseDir-specific bindings, not process.cwd()', () => {
    const dirA = join(tmpdir(), `wr-ws-a-${Date.now()}`);
    const dirB = join(tmpdir(), `wr-ws-b-${Date.now()}`);
    mkdirSync(join(dirA, '.workrail'), { recursive: true });
    mkdirSync(join(dirB, '.workrail'), { recursive: true });

    const workflowId = `ws-test-${Date.now()}`;

    // Workspace A overrides to 'team-a-routine'
    writeFileSync(
      join(dirA, '.workrail', 'bindings.json'),
      JSON.stringify({ [workflowId]: { design_review: 'team-a-routine' } }),
      'utf-8',
    );
    // Workspace B overrides to 'team-b-routine'
    writeFileSync(
      join(dirB, '.workrail', 'bindings.json'),
      JSON.stringify({ [workflowId]: { design_review: 'team-b-routine' } }),
      'utf-8',
    );

    const steps = [{ id: 'step-1', title: 'Test', prompt: '{{wr.bindings.design_review}}' }];
    const extensionPoints = [{ slotId: 'design_review', purpose: 'Review', default: 'default-review' }];

    const resultA = resolveDefinitionSteps(steps, [], extensionPoints, workflowId, dirA);
    const resultB = resolveDefinitionSteps(steps, [], extensionPoints, workflowId, dirB);

    expect(resultA.isOk()).toBe(true);
    expect(resultB.isOk()).toBe(true);

    // Each workspace gets its own override — not contaminated by the other's cwd
    expect(resultA._unsafeUnwrap().resolvedBindings.get('design_review')).toBe('team-a-routine');
    expect(resultB._unsafeUnwrap().resolvedBindings.get('design_review')).toBe('team-b-routine');

    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it('falls back to extensionPoint default when baseDir has no bindings.json', () => {
    const emptyDir = join(tmpdir(), `wr-ws-empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });

    const workflowId = `ws-empty-${Date.now()}`;
    const steps = [{ id: 'step-1', title: 'Test', prompt: '{{wr.bindings.design_review}}' }];
    const extensionPoints = [{ slotId: 'design_review', purpose: 'Review', default: 'fallback-routine' }];

    const result = resolveDefinitionSteps(steps, [], extensionPoints, workflowId, emptyDir);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().resolvedBindings.get('design_review')).toBe('fallback-routine');
    // No overrides — resolvedOverrides must be empty
    expect(result._unsafeUnwrap().resolvedOverrides.size).toBe(0);

    rmSync(emptyDir, { recursive: true, force: true });
  });
});
