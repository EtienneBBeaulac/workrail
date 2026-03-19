/**
 * Tests for resolveBindingsPass
 *
 * Verifies that {{wr.bindings.slotId}} tokens in step prompts and promptBlocks
 * are resolved correctly at compile time.
 */
import { describe, it, expect } from 'vitest';
import { resolveBindingsPass } from '../../../src/application/services/compiler/resolve-bindings.js';
import type { ExtensionPoint } from '../../../src/types/workflow-definition.js';
import type { WorkflowStepDefinition, LoopStepDefinition } from '../../../src/types/workflow-definition.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(id: string, overrides: Partial<WorkflowStepDefinition> = {}): WorkflowStepDefinition {
  return { id, title: id, ...overrides } as WorkflowStepDefinition;
}

function ep(slotId: string, defaultId: string): ExtensionPoint {
  return { slotId, purpose: `test slot for ${slotId}`, default: defaultId };
}

const NO_PROJECT_BINDINGS = new Map<string, string>();

// ---------------------------------------------------------------------------
// Happy path — raw prompt strings
// ---------------------------------------------------------------------------

describe('resolveBindingsPass — raw prompt strings', () => {
  it('replaces a single token with the extensionPoint default', () => {
    const steps = [makeStep('s1', { prompt: 'Delegate to {{wr.bindings.design_review}}.' })];
    const result = resolveBindingsPass(steps, [ep('design_review', 'routine-design-review')], NO_PROJECT_BINDINGS);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().steps[0].prompt).toBe('Delegate to routine-design-review.');
  });

  it('replaces multiple tokens in the same prompt', () => {
    const steps = [makeStep('s1', {
      prompt: 'First: {{wr.bindings.slot_a}}. Second: {{wr.bindings.slot_b}}.',
    })];
    const extensionPoints = [ep('slot_a', 'routine-a'), ep('slot_b', 'routine-b')];
    const result = resolveBindingsPass(steps, extensionPoints, NO_PROJECT_BINDINGS);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().steps[0].prompt).toBe('First: routine-a. Second: routine-b.');
  });

  it('project binding override takes precedence over extensionPoint default', () => {
    const steps = [makeStep('s1', { prompt: 'Delegate to {{wr.bindings.design_review}}.' })];
    const projectBindings = new Map([['design_review', 'my-team-design-review']]);
    const result = resolveBindingsPass(steps, [ep('design_review', 'routine-design-review')], projectBindings);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().steps[0].prompt).toBe('Delegate to my-team-design-review.');
  });

  it('step without binding tokens is returned unchanged', () => {
    const steps = [makeStep('s1', { prompt: 'No bindings here.' })];
    const result = resolveBindingsPass(steps, [], NO_PROJECT_BINDINGS);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().steps[0].prompt).toBe('No bindings here.');
  });

  it('step without a prompt is returned unchanged', () => {
    const steps = [makeStep('s1')];
    const result = resolveBindingsPass(steps, [], NO_PROJECT_BINDINGS);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().steps[0].prompt).toBeUndefined();
  });

  it('captures the resolved slotId in the resolvedBindings manifest', () => {
    const steps = [makeStep('s1', { prompt: 'Delegate to {{wr.bindings.design_review}}.' })];
    const result = resolveBindingsPass(steps, [ep('design_review', 'routine-design-review')], NO_PROJECT_BINDINGS);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().resolvedBindings.get('design_review')).toBe('routine-design-review');
  });
});

// ---------------------------------------------------------------------------
// Happy path — promptBlocks string values
// ---------------------------------------------------------------------------

describe('resolveBindingsPass — promptBlocks string values', () => {
  it('replaces token in promptBlocks.goal string value', () => {
    const steps = [makeStep('s1', {
      promptBlocks: {
        goal: 'Delegate to {{wr.bindings.design_review}} for the review phase.',
      },
    })];
    const result = resolveBindingsPass(steps, [ep('design_review', 'routine-design-review')], NO_PROJECT_BINDINGS);
    expect(result.isOk()).toBe(true);
    const blocks = result._unsafeUnwrap().steps[0].promptBlocks;
    expect(blocks?.goal).toBe('Delegate to routine-design-review for the review phase.');
  });

  it('replaces token in promptBlocks.constraints string values', () => {
    const steps = [makeStep('s1', {
      promptBlocks: {
        constraints: ['Use {{wr.bindings.design_review}} for review.', 'No unilateral decisions.'],
      },
    })];
    const result = resolveBindingsPass(steps, [ep('design_review', 'routine-design-review')], NO_PROJECT_BINDINGS);
    expect(result.isOk()).toBe(true);
    const blocks = result._unsafeUnwrap().steps[0].promptBlocks;
    expect((blocks?.constraints as string[])[0]).toBe('Use routine-design-review for review.');
    expect((blocks?.constraints as string[])[1]).toBe('No unilateral decisions.');
  });

  it('replaces token in promptBlocks.outputRequired values', () => {
    const steps = [makeStep('s1', {
      promptBlocks: {
        outputRequired: { reviewBy: 'Use {{wr.bindings.design_review}}' },
      },
    })];
    const result = resolveBindingsPass(steps, [ep('design_review', 'routine-design-review')], NO_PROJECT_BINDINGS);
    expect(result.isOk()).toBe(true);
    const blocks = result._unsafeUnwrap().steps[0].promptBlocks;
    expect(blocks?.outputRequired?.['reviewBy']).toBe('Use routine-design-review');
  });

  it('leaves PromptPart arrays unchanged (not string PromptValues)', () => {
    const steps = [makeStep('s1', {
      promptBlocks: {
        goal: [{ kind: 'text', text: 'This is a text part with {{wr.bindings.x}}.' }],
      },
    })];
    // Token inside a PromptPart array text is NOT replaced — only plain string PromptValues
    // are scanned. PromptPart arrays are processed separately by resolveRefsPass.
    const result = resolveBindingsPass(steps, [ep('x', 'routine-x')], NO_PROJECT_BINDINGS);
    expect(result.isOk()).toBe(true);
    // The PromptPart array is passed through unchanged
    const goal = result._unsafeUnwrap().steps[0].promptBlocks?.goal;
    expect(Array.isArray(goal)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Loop body traversal
// ---------------------------------------------------------------------------

describe('resolveBindingsPass — loop body traversal', () => {
  it('resolves binding tokens in inline loop body steps', () => {
    const bodyStep = makeStep('body-step', {
      prompt: 'Delegate to {{wr.bindings.final_verification}}.',
    });
    const loopStep: LoopStepDefinition = {
      id: 'loop-1',
      title: 'loop',
      type: 'loop',
      loop: { type: 'while', maxIterations: 5 },
      body: [bodyStep],
    };

    const result = resolveBindingsPass(
      [loopStep],
      [ep('final_verification', 'routine-final-verification')],
      NO_PROJECT_BINDINGS,
    );
    expect(result.isOk()).toBe(true);
    const resolvedLoop = result._unsafeUnwrap().steps[0] as LoopStepDefinition;
    const resolvedBody = resolvedLoop.body as WorkflowStepDefinition[];
    expect(resolvedBody[0].prompt).toBe('Delegate to routine-final-verification.');
  });

  it('string-body loops are not traversed (the referenced step is in the top-level array)', () => {
    const referencedStep = makeStep('ref-step', {
      prompt: 'Delegate to {{wr.bindings.design_review}}.',
    });
    const loopStep: LoopStepDefinition = {
      id: 'loop-1',
      title: 'loop',
      type: 'loop',
      loop: { type: 'while', maxIterations: 5 },
      body: 'ref-step', // string body reference
    };

    const result = resolveBindingsPass(
      [referencedStep, loopStep],
      [ep('design_review', 'routine-design-review')],
      NO_PROJECT_BINDINGS,
    );
    expect(result.isOk()).toBe(true);
    // The referenced step IS in the top-level array and gets resolved
    expect(result._unsafeUnwrap().steps[0].prompt).toBe('Delegate to routine-design-review.');
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('resolveBindingsPass — error handling', () => {
  it('fails fast on unknown binding slot with helpful message', () => {
    const steps = [makeStep('s1', { prompt: 'Delegate to {{wr.bindings.missing_slot}}.' })];
    const result = resolveBindingsPass(steps, [ep('design_review', 'routine-x')], NO_PROJECT_BINDINGS);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.code).toBe('UNKNOWN_BINDING_SLOT');
    expect(e.stepId).toBe('s1');
    expect(e.slotId).toBe('missing_slot');
    expect(e.message).toContain('design_review'); // lists known slots
    expect(e.message).toContain('missing_slot');
  });

  it('fails with clear message when no extensionPoints are declared', () => {
    const steps = [makeStep('s1', { prompt: '{{wr.bindings.typo}}' })];
    const result = resolveBindingsPass(steps, [], NO_PROJECT_BINDINGS);
    expect(result.isErr()).toBe(true);
    const e = result._unsafeUnwrapErr();
    expect(e.code).toBe('UNKNOWN_BINDING_SLOT');
    expect(e.message).toContain('no extensionPoints');
  });

  it('fails on unknown slot in inline loop body step', () => {
    const bodyStep = makeStep('body-step', { prompt: '{{wr.bindings.missing}}.' });
    const loopStep: LoopStepDefinition = {
      id: 'loop-1',
      title: 'loop',
      type: 'loop',
      loop: { type: 'while', maxIterations: 3 },
      body: [bodyStep],
    };
    const result = resolveBindingsPass([loopStep], [], NO_PROJECT_BINDINGS);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().stepId).toBe('body-step');
  });
});

// ---------------------------------------------------------------------------
// Resolved bindings manifest
// ---------------------------------------------------------------------------

describe('resolveBindingsPass — resolvedBindings manifest', () => {
  it('returns empty manifest when no tokens are present', () => {
    const steps = [makeStep('s1', { prompt: 'No tokens.' })];
    const result = resolveBindingsPass(steps, [], NO_PROJECT_BINDINGS);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().resolvedBindings.size).toBe(0);
  });

  it('records project override in the manifest (not the extensionPoint default)', () => {
    const steps = [makeStep('s1', { prompt: '{{wr.bindings.design_review}}' })];
    const projectBindings = new Map([['design_review', 'team-design-review']]);
    const result = resolveBindingsPass(steps, [ep('design_review', 'default-design-review')], projectBindings);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().resolvedBindings.get('design_review')).toBe('team-design-review');
  });
});
