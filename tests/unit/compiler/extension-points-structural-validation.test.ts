/**
 * Tests for extensionPoints structural validation in ValidationEngine.
 *
 * Covers the new rules added to validateWorkflow():
 * 1. Per-entry: non-empty slotId, purpose, default
 * 2. Unique slotId values
 * 3. Binding tokens reference only declared slots (when extensionPoints present)
 * 4. Binding tokens with no extensionPoints declared = error
 * 5. Loop body steps are also checked for binding tokens
 */
import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { container } from 'tsyringe';
import { ValidationEngine } from '../../../src/application/services/validation-engine.js';
import { EnhancedLoopValidator } from '../../../src/application/services/enhanced-loop-validator.js';
import type { Workflow } from '../../../src/types/workflow.js';
import type { WorkflowDefinition, ExtensionPoint } from '../../../src/types/workflow-definition.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): Workflow {
  return {
    definition: {
      id: 'test-workflow',
      title: 'Test Workflow',
      description: 'Test',
      steps: [
        { id: 'step1', title: 'Step 1', prompt: 'Do something.' },
      ],
      ...overrides,
    } as WorkflowDefinition,
    source: { kind: 'bundled' },
  } as Workflow;
}

function ep(slotId: string, opts: Partial<ExtensionPoint> = {}): ExtensionPoint {
  return {
    slotId,
    purpose: `Purpose for ${slotId}`,
    default: `default-routine-for-${slotId}`,
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let engine: ValidationEngine;

beforeEach(() => {
  container.clearInstances();
  engine = new ValidationEngine(container.resolve(EnhancedLoopValidator));
});

afterEach(() => {
  container.clearInstances();
});

// ---------------------------------------------------------------------------
// Per-entry field validation
// ---------------------------------------------------------------------------

describe('extensionPoints — per-entry field validation', () => {
  it('passes with a valid extensionPoint entry', () => {
    const wf = makeWorkflow({ extensionPoints: [ep('design_review')] });
    const result = engine.validateWorkflow(wf);
    expect(result.issues.filter(i => i.includes('extensionPoint'))).toHaveLength(0);
  });

  it('flags missing slotId', () => {
    const bad = { slotId: '', purpose: 'ok', default: 'ok' } as ExtensionPoint;
    const wf = makeWorkflow({ extensionPoints: [bad] });
    const result = engine.validateWorkflow(wf);
    expect(result.issues.some(i => i.includes('missing or empty slotId'))).toBe(true);
  });

  it('flags missing purpose', () => {
    const bad = { slotId: 'my_slot', purpose: '', default: 'ok' } as ExtensionPoint;
    const wf = makeWorkflow({ extensionPoints: [bad] });
    const result = engine.validateWorkflow(wf);
    expect(result.issues.some(i => i.includes('purpose must be a non-empty string'))).toBe(true);
  });

  it('flags missing default', () => {
    const bad = { slotId: 'my_slot', purpose: 'ok', default: '' } as ExtensionPoint;
    const wf = makeWorkflow({ extensionPoints: [bad] });
    const result = engine.validateWorkflow(wf);
    expect(result.issues.some(i => i.includes('default must be a non-empty string'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Uniqueness
// ---------------------------------------------------------------------------

describe('extensionPoints — slotId uniqueness', () => {
  it('passes when all slotIds are unique', () => {
    const wf = makeWorkflow({ extensionPoints: [ep('slot_a'), ep('slot_b')] });
    const result = engine.validateWorkflow(wf);
    expect(result.issues.filter(i => i.includes('duplicate'))).toHaveLength(0);
  });

  it('flags duplicate slotIds', () => {
    const wf = makeWorkflow({ extensionPoints: [ep('design_review'), ep('design_review')] });
    const result = engine.validateWorkflow(wf);
    expect(result.issues.some(i => i.includes("duplicate slotId 'design_review'"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-check: binding tokens vs declared extensionPoints
// ---------------------------------------------------------------------------

describe('extensionPoints — binding token cross-check', () => {
  it('passes when token references a declared slot', () => {
    const wf = makeWorkflow({
      extensionPoints: [ep('design_review')],
      steps: [{ id: 'step1', title: 'Step 1', prompt: 'Run {{wr.bindings.design_review}}.' } as any],
    });
    const result = engine.validateWorkflow(wf);
    expect(result.issues.filter(i => i.includes('binding token'))).toHaveLength(0);
  });

  it('flags a binding token referencing an undeclared slot', () => {
    const wf = makeWorkflow({
      extensionPoints: [ep('slot_a')],
      steps: [{ id: 'step1', title: 'Step 1', prompt: 'Run {{wr.bindings.missing_slot}}.' } as any],
    });
    const result = engine.validateWorkflow(wf);
    // Message: "Step 'step1': binding token '{{wr.bindings.missing_slot}}' references undeclared slot. Declared slots: [slot_a]"
    expect(result.issues.some(i => i.includes('missing_slot') && i.includes('undeclared'))).toBe(true);
    expect(result.issues.some(i => i.includes('slot_a'))).toBe(true); // lists known slots
  });

  it('flags a binding token when workflow declares no extensionPoints', () => {
    const wf = makeWorkflow({
      steps: [{ id: 'step1', title: 'Step 1', prompt: 'Run {{wr.bindings.design_review}}.' } as any],
    });
    const result = engine.validateWorkflow(wf);
    expect(result.issues.some(i => i.includes('no extensionPoints'))).toBe(true);
  });

  it('does not flag a plain prompt with no binding tokens (no extensionPoints)', () => {
    const wf = makeWorkflow();
    const result = engine.validateWorkflow(wf);
    expect(result.issues.filter(i => i.includes('extensionPoint') || i.includes('binding'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Loop body coverage
// ---------------------------------------------------------------------------

describe('extensionPoints — loop body coverage', () => {
  it('flags binding tokens in inline loop body steps when no extensionPoints declared', () => {
    // type: 'loop' is required — isLoopStepDefinition checks step.type === 'loop'
    const wf = makeWorkflow({
      steps: [{
        id: 'loop1', type: 'loop', title: 'Loop',
        loop: { type: 'for', count: 3, maxIterations: 3 },
        body: [
          { id: 'body-step', title: 'Body', prompt: 'Run {{wr.bindings.review}}.' },
        ],
      } as any],
    });
    const result = engine.validateWorkflow(wf);
    // Message: "Step 'body-step' (loop body): uses {{wr.bindings.*}} token but workflow declares no extensionPoints"
    expect(result.issues.some(i => i.includes('no extensionPoints'))).toBe(true);
  });

  it('flags binding tokens in loop body referencing undeclared slot', () => {
    const wf = makeWorkflow({
      extensionPoints: [ep('slot_a')],
      steps: [{
        id: 'loop1', type: 'loop', title: 'Loop',
        loop: { type: 'for', count: 3, maxIterations: 3 },
        body: [
          { id: 'body-step', title: 'Body', prompt: 'Run {{wr.bindings.missing_slot}}.' },
        ],
      } as any],
    });
    const result = engine.validateWorkflow(wf);
    // Message: "Step 'body-step': binding token '{{wr.bindings.missing_slot}}' references undeclared slot..."
    expect(result.issues.some(i => i.includes('missing_slot') && i.includes('undeclared'))).toBe(true);
  });

  it('passes when loop body tokens reference declared slots', () => {
    const wf = makeWorkflow({
      extensionPoints: [ep('review')],
      steps: [{
        id: 'loop1', type: 'loop', title: 'Loop',
        loop: { type: 'for', count: 3, maxIterations: 3 },
        body: [
          { id: 'body-step', title: 'Body', prompt: 'Run {{wr.bindings.review}}.' },
        ],
      } as any],
    });
    const result = engine.validateWorkflow(wf);
    expect(result.issues.filter(i => i.includes('binding'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Regression: uppercase / mixed-case slot IDs
// ---------------------------------------------------------------------------

describe('extensionPoints — mixed-case slot IDs', () => {
  it('flags uppercase slotId token as undeclared (no matching extensionPoint)', () => {
    // If someone writes {{wr.bindings.MySlot}} but only declares slotId: 'MySlot'
    // the cross-check should match correctly (both are exact string comparison)
    const wf = makeWorkflow({
      extensionPoints: [{ slotId: 'MySlot', purpose: 'ok', default: 'my-routine' }],
      steps: [{ id: 'step1', title: 'Step 1', prompt: 'Run {{wr.bindings.MySlot}}.' } as any],
    });
    const result = engine.validateWorkflow(wf);
    // Should NOT flag it — declared slot matches token exactly
    expect(result.issues.filter(i => i.includes('binding token') || i.includes('undeclared'))).toHaveLength(0);
  });

  it('flags {{wr.bindings.MissingUpper}} when only lower-case slot declared', () => {
    const wf = makeWorkflow({
      extensionPoints: [ep('my_slot')],
      steps: [{ id: 'step1', title: 'Step 1', prompt: 'Run {{wr.bindings.MissingUpper}}.' } as any],
    });
    const result = engine.validateWorkflow(wf);
    expect(result.issues.some(i => i.includes('MissingUpper') || i.includes('undeclared'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// promptBlocks coverage — binding tokens inside structured blocks
// ---------------------------------------------------------------------------

describe('extensionPoints — promptBlocks token scanning', () => {
  it('flags undeclared token in promptBlocks.goal (extensionPoints declared)', () => {
    const wf = makeWorkflow({
      extensionPoints: [ep('slot_a')],
      steps: [{
        id: 'step1', title: 'Step 1',
        promptBlocks: { goal: 'Run {{wr.bindings.missing_slot}}.' },
      } as any],
    });
    const result = engine.validateWorkflow(wf);
    expect(result.issues.some(i => i.includes('missing_slot') && i.includes('undeclared'))).toBe(true);
  });

  it('passes when promptBlocks.goal token references a declared slot', () => {
    const wf = makeWorkflow({
      extensionPoints: [ep('slot_a')],
      steps: [{
        id: 'step1', title: 'Step 1',
        promptBlocks: { goal: 'Run {{wr.bindings.slot_a}}.' },
      } as any],
    });
    const result = engine.validateWorkflow(wf);
    expect(result.issues.filter(i => i.includes('binding token') || i.includes('undeclared'))).toHaveLength(0);
  });

  it('flags token in promptBlocks.procedure item when no extensionPoints declared', () => {
    const wf = makeWorkflow({
      steps: [{
        id: 'step1', title: 'Step 1',
        promptBlocks: { procedure: ['First, run {{wr.bindings.review}}.'] },
      } as any],
    });
    const result = engine.validateWorkflow(wf);
    expect(result.issues.some(i => i.includes('no extensionPoints'))).toBe(true);
  });

  it('flags token in promptBlocks.outputRequired value when no extensionPoints declared', () => {
    const wf = makeWorkflow({
      steps: [{
        id: 'step1', title: 'Step 1',
        promptBlocks: { outputRequired: { result: 'Must use {{wr.bindings.review}}.' } },
      } as any],
    });
    const result = engine.validateWorkflow(wf);
    expect(result.issues.some(i => i.includes('no extensionPoints'))).toBe(true);
  });
});
