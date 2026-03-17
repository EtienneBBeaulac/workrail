/**
 * Template Registry — Tests
 *
 * Tests both the empty registry and routine-populated registry.
 */
import { describe, it, expect } from 'vitest';
import {
  createTemplateRegistry,
  createRoutineExpander,
  routineIdToTemplateId,
} from '../../../src/application/services/compiler/template-registry.js';
import type { WorkflowDefinition, WorkflowStepDefinition } from '../../../src/types/workflow-definition.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoutineDefinition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'routine-test',
    name: 'Test Routine',
    description: 'A test routine',
    version: '1.0.0',
    steps: [
      { id: 'step-1', title: 'Step 1', prompt: 'Do the first thing.' },
      { id: 'step-2', title: 'Step 2', prompt: 'Do the second thing.' },
    ],
    ...overrides,
  } as WorkflowDefinition;
}

// ---------------------------------------------------------------------------
// routineIdToTemplateId
// ---------------------------------------------------------------------------

describe('routineIdToTemplateId', () => {
  it('strips routine- prefix and adds wr.templates.routine. prefix', () => {
    expect(routineIdToTemplateId('routine-tension-driven-design'))
      .toBe('wr.templates.routine.tension-driven-design');
  });

  it('handles IDs without routine- prefix', () => {
    expect(routineIdToTemplateId('context-gathering'))
      .toBe('wr.templates.routine.context-gathering');
  });
});

// ---------------------------------------------------------------------------
// createRoutineExpander
// ---------------------------------------------------------------------------

describe('createRoutineExpander', () => {
  it('creates an expander that maps routine steps to workflow steps', () => {
    const definition = makeRoutineDefinition();
    const result = createRoutineExpander('routine-test', definition);
    expect(result.isOk()).toBe(true);

    const expander = result._unsafeUnwrap();
    const expandResult = expander('phase-0', {});
    expect(expandResult.isOk()).toBe(true);

    const steps = expandResult._unsafeUnwrap();
    expect(steps).toHaveLength(2);
    expect(steps[0]!.id).toBe('phase-0.step-1');
    expect(steps[0]!.title).toBe('Step 1');
    expect(steps[0]!.prompt).toBe('Do the first thing.');
    expect(steps[1]!.id).toBe('phase-0.step-2');
  });

  it('preserves agentRole from routine steps', () => {
    const definition = makeRoutineDefinition({
      steps: [
        { id: 'step-1', title: 'Step 1', prompt: 'Do it.', agentRole: 'You are an investigator.' },
      ],
    });
    const expander = createRoutineExpander('routine-test', definition)._unsafeUnwrap();
    const steps = expander('caller', {})._unsafeUnwrap();
    expect(steps[0]!.agentRole).toBe('You are an investigator.');
  });

  it('preserves requireConfirmation from routine steps', () => {
    const definition = makeRoutineDefinition({
      steps: [
        { id: 'step-1', title: 'Step 1', prompt: 'Do it.', requireConfirmation: true },
      ],
    });
    const expander = createRoutineExpander('routine-test', definition)._unsafeUnwrap();
    const steps = expander('caller', {})._unsafeUnwrap();
    expect(steps[0]!.requireConfirmation).toBe(true);
  });

  describe('arg substitution', () => {
    it('substitutes single-brace args in prompts', () => {
      const definition = makeRoutineDefinition({
        steps: [
          { id: 'step-1', title: 'Step 1', prompt: 'Create `{deliverableName}` with results.' },
        ],
      });
      const expander = createRoutineExpander('routine-test', definition)._unsafeUnwrap();
      const steps = expander('caller', { deliverableName: 'output.md' })._unsafeUnwrap();
      expect(steps[0]!.prompt).toBe('Create `output.md` with results.');
    });

    it('substitutes args in titles', () => {
      const definition = makeRoutineDefinition({
        steps: [
          { id: 'step-1', title: 'Create {deliverableName}', prompt: 'Do it.' },
        ],
      });
      const expander = createRoutineExpander('routine-test', definition)._unsafeUnwrap();
      const steps = expander('caller', { deliverableName: 'report.md' })._unsafeUnwrap();
      expect(steps[0]!.title).toBe('Create report.md');
    });

    it('leaves double-brace {{contextVar}} untouched', () => {
      const definition = makeRoutineDefinition({
        steps: [
          { id: 'step-1', title: 'Step 1', prompt: 'Use {{contextSummary}} and {deliverableName}.' },
        ],
      });
      const expander = createRoutineExpander('routine-test', definition)._unsafeUnwrap();
      const steps = expander('caller', { deliverableName: 'out.md' })._unsafeUnwrap();
      expect(steps[0]!.prompt).toBe('Use {{contextSummary}} and out.md.');
    });

    it('fails on missing args with TEMPLATE_EXPAND_FAILED', () => {
      const definition = makeRoutineDefinition({
        steps: [
          { id: 'step-deliver', title: 'Deliver', prompt: 'Create {deliverableName} with {format}.' },
        ],
      });
      const expander = createRoutineExpander('routine-test', definition)._unsafeUnwrap();
      const result = expander('caller', {});
      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.code).toBe('TEMPLATE_EXPAND_FAILED');
      expect(error.message).toContain('MISSING_TEMPLATE_ARG');
      expect(error.message).toContain('deliverableName');
      expect(error.message).toContain('format');
    });

    it('fails when only some args are provided', () => {
      const definition = makeRoutineDefinition({
        steps: [
          { id: 'step-1', title: 'Step', prompt: 'Use {a} and {b}.' },
        ],
      });
      const expander = createRoutineExpander('routine-test', definition)._unsafeUnwrap();
      const result = expander('caller', { a: 'alpha' });
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain("'b'");
    });

    it('rejects non-primitive arg values (objects would produce [object Object])', () => {
      const definition = makeRoutineDefinition({
        steps: [
          { id: 'step-1', title: 'Step', prompt: 'Use {data}.' },
        ],
      });
      const expander = createRoutineExpander('routine-test', definition)._unsafeUnwrap();
      const result = expander('caller', { data: { nested: true } });
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('INVALID_TEMPLATE_ARG_TYPE');
      expect(result._unsafeUnwrapErr().message).toContain('string, number, or boolean');
    });

    it('accepts number and boolean arg values', () => {
      const definition = makeRoutineDefinition({
        steps: [
          { id: 'step-1', title: 'Step', prompt: 'Count: {count}, flag: {enabled}.' },
        ],
      });
      const expander = createRoutineExpander('routine-test', definition)._unsafeUnwrap();
      const steps = expander('caller', { count: 42, enabled: true })._unsafeUnwrap();
      expect(steps[0]!.prompt).toBe('Count: 42, flag: true.');
    });
  });

  describe('metaGuidance injection', () => {
    it('injects routine metaGuidance as step-level guidance', () => {
      const definition = makeRoutineDefinition({
        metaGuidance: ['Be thorough.', 'Be honest.'],
        steps: [
          { id: 'step-1', title: 'Step 1', prompt: 'Do it.' },
        ],
      });
      const expander = createRoutineExpander('routine-test', definition)._unsafeUnwrap();
      const steps = expander('caller', {})._unsafeUnwrap();
      expect(steps[0]!.guidance).toEqual(['Be thorough.', 'Be honest.']);
    });

    it('merges metaGuidance with existing step guidance', () => {
      const definition = makeRoutineDefinition({
        metaGuidance: ['Global guidance.'],
        steps: [
          { id: 'step-1', title: 'Step 1', prompt: 'Do it.', guidance: ['Step-specific guidance.'] },
        ],
      });
      const expander = createRoutineExpander('routine-test', definition)._unsafeUnwrap();
      const steps = expander('caller', {})._unsafeUnwrap();
      expect(steps[0]!.guidance).toEqual(['Step-specific guidance.', 'Global guidance.']);
    });

    it('preserves step guidance when no metaGuidance', () => {
      const definition = makeRoutineDefinition({
        steps: [
          { id: 'step-1', title: 'Step 1', prompt: 'Do it.', guidance: ['Existing.'] },
        ],
      });
      const expander = createRoutineExpander('routine-test', definition)._unsafeUnwrap();
      const steps = expander('caller', {})._unsafeUnwrap();
      expect(steps[0]!.guidance).toEqual(['Existing.']);
    });
  });

  describe('validation', () => {
    it('rejects routines with templateCall in steps', () => {
      const definition = makeRoutineDefinition({
        steps: [
          {
            id: 'step-1',
            title: 'Step 1',
            prompt: 'Do it.',
            templateCall: { templateId: 'wr.templates.routine.other' },
          } as WorkflowStepDefinition,
        ],
      });
      const result = createRoutineExpander('routine-test', definition);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('Recursive routine injection is not allowed');
    });

    it('fails on steps missing prompt', () => {
      const definition = makeRoutineDefinition({
        steps: [
          { id: 'step-1', title: 'Step 1' } as WorkflowStepDefinition,
        ],
      });
      const expander = createRoutineExpander('routine-test', definition)._unsafeUnwrap();
      const result = expander('caller', {});
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain("missing required field 'prompt'");
    });

    it('fails on steps missing title', () => {
      const definition = makeRoutineDefinition({
        steps: [
          { id: 'step-1', prompt: 'Do it.' } as WorkflowStepDefinition,
        ],
      });
      const expander = createRoutineExpander('routine-test', definition)._unsafeUnwrap();
      const result = expander('caller', {});
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain("missing required field 'title'");
    });
  });

  it('is deterministic: same input always produces same output', () => {
    const definition = makeRoutineDefinition();
    const expander = createRoutineExpander('routine-test', definition)._unsafeUnwrap();
    const a = expander('caller', {})._unsafeUnwrap();
    const b = expander('caller', {})._unsafeUnwrap();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('does not include preconditions or clarificationPrompts in expanded steps', () => {
    const definition = makeRoutineDefinition({
      preconditions: ['Must have context'],
      clarificationPrompts: ['What problem?'],
      steps: [
        { id: 'step-1', title: 'Step 1', prompt: 'Do it.' },
      ],
    });
    const expander = createRoutineExpander('routine-test', definition)._unsafeUnwrap();
    const steps = expander('caller', {})._unsafeUnwrap();
    // preconditions and clarificationPrompts are workflow-level, not step-level
    // They should not appear anywhere in the expanded steps
    const serialized = JSON.stringify(steps);
    expect(serialized).not.toContain('preconditions');
    expect(serialized).not.toContain('clarificationPrompts');
    expect(serialized).not.toContain('Must have context');
    expect(serialized).not.toContain('What problem?');
  });

  // Note: this path cannot occur through the real loading pipeline because
  // hasWorkflowDefinitionShape() requires steps.length > 0. Kept as a
  // defensive test for direct createRoutineExpander() callers.
  it('handles routine with empty steps array (defensive)', () => {
    const definition = makeRoutineDefinition({ steps: [] });
    const expander = createRoutineExpander('routine-test', definition)._unsafeUnwrap();
    const steps = expander('caller', {})._unsafeUnwrap();
    expect(steps).toHaveLength(0);
  });

  it('succeeds when prompts have no arg placeholders', () => {
    const definition = makeRoutineDefinition({
      steps: [
        { id: 'step-1', title: 'Step 1', prompt: 'No placeholders here.' },
      ],
    });
    const expander = createRoutineExpander('routine-test', definition)._unsafeUnwrap();
    const steps = expander('caller', {})._unsafeUnwrap();
    expect(steps[0]!.prompt).toBe('No placeholders here.');
  });

  it('does not set agentRole or guidance when routine step has neither', () => {
    const definition = makeRoutineDefinition({
      steps: [
        { id: 'step-1', title: 'Step 1', prompt: 'Plain step.' },
      ],
    });
    const expander = createRoutineExpander('routine-test', definition)._unsafeUnwrap();
    const steps = expander('caller', {})._unsafeUnwrap();
    expect(steps[0]!.agentRole).toBeUndefined();
    expect(steps[0]!.guidance).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createTemplateRegistry (empty)
// ---------------------------------------------------------------------------

describe('TemplateRegistry (empty)', () => {
  const registry = createTemplateRegistry();

  it('returns UNKNOWN_TEMPLATE for any template ID (registry is empty)', () => {
    const result = registry.resolve('wr.templates.something');
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('UNKNOWN_TEMPLATE');
    expect(error.templateId).toBe('wr.templates.something');
    expect(error.message).toContain('(none)');
  });

  it('returns UNKNOWN_TEMPLATE for empty string', () => {
    const result = registry.resolve('');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('UNKNOWN_TEMPLATE');
  });

  it('has() returns false for all IDs (registry is empty)', () => {
    expect(registry.has('wr.templates.something')).toBe(false);
    expect(registry.has('')).toBe(false);
  });

  it('knownIds() returns empty array', () => {
    expect(registry.knownIds()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createTemplateRegistry (with routine expanders)
// ---------------------------------------------------------------------------

describe('TemplateRegistry (with routine expanders)', () => {
  const definition = makeRoutineDefinition();
  const expander = createRoutineExpander('routine-test', definition)._unsafeUnwrap();
  const routineExpanders = new Map([
    ['wr.templates.routine.test', expander],
  ]);
  const registry = createTemplateRegistry(routineExpanders);

  it('resolves routine-derived templates', () => {
    const result = registry.resolve('wr.templates.routine.test');
    expect(result.isOk()).toBe(true);
  });

  it('has() returns true for routine-derived templates', () => {
    expect(registry.has('wr.templates.routine.test')).toBe(true);
  });

  it('knownIds() includes routine-derived templates', () => {
    expect(registry.knownIds()).toContain('wr.templates.routine.test');
  });

  it('still returns UNKNOWN_TEMPLATE for unknown IDs', () => {
    const result = registry.resolve('wr.templates.nonexistent');
    expect(result.isErr()).toBe(true);
  });

  it('expanded steps work end-to-end through the registry', () => {
    const expanderResult = registry.resolve('wr.templates.routine.test');
    expect(expanderResult.isOk()).toBe(true);
    const steps = expanderResult._unsafeUnwrap()('my-step', {})._unsafeUnwrap();
    expect(steps).toHaveLength(2);
    expect(steps[0]!.id).toBe('my-step.step-1');
    expect(steps[1]!.id).toBe('my-step.step-2');
  });
});
