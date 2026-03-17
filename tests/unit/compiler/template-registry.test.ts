/**
 * Template Registry — Tests
 */
import { describe, it, expect } from 'vitest';
import {
  createTemplateRegistry,
  createRoutineExpander,
  routineIdToTemplateId,
} from '../../../src/application/services/compiler/template-registry.js';
import type { WorkflowDefinition } from '../../../src/types/workflow-definition.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoutineDefinition(
  overrides: Partial<WorkflowDefinition> & { steps: WorkflowDefinition['steps'] },
): WorkflowDefinition {
  return {
    id: overrides.id ?? 'routine-test',
    name: overrides.name ?? 'Test Routine',
    description: overrides.description ?? 'A test routine',
    version: overrides.version ?? '1.0.0',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Empty registry (backward compat)
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
// routineIdToTemplateId
// ---------------------------------------------------------------------------

describe('routineIdToTemplateId', () => {
  it('strips routine- prefix and adds wr.templates.routine. prefix', () => {
    expect(routineIdToTemplateId('routine-tension-driven-design')).toBe('wr.templates.routine.tension-driven-design');
  });

  it('handles ID without routine- prefix', () => {
    expect(routineIdToTemplateId('my-routine')).toBe('wr.templates.routine.my-routine');
  });
});

// ---------------------------------------------------------------------------
// createRoutineExpander
// ---------------------------------------------------------------------------

describe('createRoutineExpander', () => {
  it('maps routine steps to workflow steps with ID prefixing', () => {
    const routine = makeRoutineDefinition({
      steps: [
        { id: 'step-1', title: 'Step 1', prompt: 'Do step 1.' },
        { id: 'step-2', title: 'Step 2', prompt: 'Do step 2.' },
      ],
    });

    const expanderResult = createRoutineExpander('routine-test', routine);
    expect(expanderResult.isOk()).toBe(true);

    const result = expanderResult.value('phase-0', {});
    expect(result.isOk()).toBe(true);
    const steps = result._unsafeUnwrap();
    expect(steps).toHaveLength(2);
    expect(steps[0]!.id).toBe('phase-0.step-1');
    expect(steps[0]!.title).toBe('Step 1');
    expect(steps[0]!.prompt).toBe('Do step 1.');
    expect(steps[1]!.id).toBe('phase-0.step-2');
  });

  it('preserves agentRole from routine steps', () => {
    const routine = makeRoutineDefinition({
      steps: [
        { id: 'step-1', title: 'Step 1', prompt: 'Do it.', agentRole: 'You are a designer.' },
      ],
    });

    const expander = createRoutineExpander('routine-test', routine)._unsafeUnwrap();
    const steps = expander('caller', {})._unsafeUnwrap();
    expect(steps[0]!.agentRole).toBe('You are a designer.');
  });

  it('preserves requireConfirmation from routine steps', () => {
    const routine = makeRoutineDefinition({
      steps: [
        { id: 'step-1', title: 'Step 1', prompt: 'Do it.', requireConfirmation: true },
      ],
    });

    const expander = createRoutineExpander('routine-test', routine)._unsafeUnwrap();
    const steps = expander('caller', {})._unsafeUnwrap();
    expect(steps[0]!.requireConfirmation).toBe(true);
  });

  it('injects routine metaGuidance as step-level guidance', () => {
    const routine = makeRoutineDefinition({
      metaGuidance: ['Be thorough.', 'Think deeply.'],
      steps: [
        { id: 'step-1', title: 'Step 1', prompt: 'Do it.' },
        { id: 'step-2', title: 'Step 2', prompt: 'Do more.', guidance: ['Existing guidance.'] },
      ],
    });

    const expander = createRoutineExpander('routine-test', routine)._unsafeUnwrap();
    const steps = expander('caller', {})._unsafeUnwrap();

    // Step without existing guidance gets only metaGuidance
    expect(steps[0]!.guidance).toEqual(['Be thorough.', 'Think deeply.']);
    // Step with existing guidance gets both (existing first, then metaGuidance)
    expect(steps[1]!.guidance).toEqual(['Existing guidance.', 'Be thorough.', 'Think deeply.']);
  });

  it('substitutes single-brace args in prompts', () => {
    const routine = makeRoutineDefinition({
      steps: [
        { id: 'step-1', title: 'Step 1', prompt: 'Create `{deliverableName}` with {format}.' },
      ],
    });

    const expander = createRoutineExpander('routine-test', routine)._unsafeUnwrap();
    const steps = expander('caller', { deliverableName: 'output.md', format: 'markdown' })._unsafeUnwrap();
    expect(steps[0]!.prompt).toBe('Create `output.md` with markdown.');
  });

  it('leaves double-brace context variables untouched', () => {
    const routine = makeRoutineDefinition({
      steps: [
        { id: 'step-1', title: 'Step 1', prompt: 'Use {{contextVar}} and {arg}.' },
      ],
    });

    const expander = createRoutineExpander('routine-test', routine)._unsafeUnwrap();
    const steps = expander('caller', { arg: 'value' })._unsafeUnwrap();
    expect(steps[0]!.prompt).toBe('Use {{contextVar}} and value.');
  });

  it('fails with MISSING_TEMPLATE_ARG when args are not provided', () => {
    const routine = makeRoutineDefinition({
      steps: [
        { id: 'step-deliver', title: 'Deliver', prompt: 'Create `{deliverableName}`.' },
      ],
    });

    const expander = createRoutineExpander('routine-test', routine)._unsafeUnwrap();
    const result = expander('caller', {});
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('TEMPLATE_EXPAND_FAILED');
    expect(error.message).toContain('MISSING_TEMPLATE_ARG');
    expect(error.message).toContain('deliverableName');
    expect(error.message).toContain('step-deliver');
  });

  it('rejects routine with templateCall in steps (no recursive injection)', () => {
    const routine = makeRoutineDefinition({
      steps: [
        {
          id: 'step-1',
          title: 'Step 1',
          prompt: 'Do it.',
          templateCall: { templateId: 'wr.templates.routine.other' },
        },
      ],
    });

    const result = createRoutineExpander('routine-test', routine);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Recursive routine injection');
  });

  it('rejects routine step missing prompt', () => {
    const routine = makeRoutineDefinition({
      steps: [
        { id: 'step-1', title: 'Step 1' } as any,
      ],
    });

    const result = createRoutineExpander('routine-test', routine);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain("missing required field 'prompt'");
  });

  it('rejects routine step missing title', () => {
    const routine = makeRoutineDefinition({
      steps: [
        { id: 'step-1', prompt: 'Do it.' } as any,
      ],
    });

    const result = createRoutineExpander('routine-test', routine);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain("missing required field 'title'");
  });
});

// ---------------------------------------------------------------------------
// Registry with routines
// ---------------------------------------------------------------------------

describe('TemplateRegistry (with routines)', () => {
  const routines = new Map<string, WorkflowDefinition>([
    ['routine-test-alpha', makeRoutineDefinition({
      id: 'routine-test-alpha',
      steps: [
        { id: 'step-a', title: 'Alpha Step', prompt: 'Do alpha.' },
      ],
    })],
    ['routine-test-beta', makeRoutineDefinition({
      id: 'routine-test-beta',
      metaGuidance: ['Be beta.'],
      steps: [
        { id: 'step-b', title: 'Beta Step', prompt: 'Create {output}.' },
      ],
    })],
  ]);

  const registry = createTemplateRegistry(routines);

  it('resolves routine-derived templates by convention ID', () => {
    const result = registry.resolve('wr.templates.routine.test-alpha');
    expect(result.isOk()).toBe(true);
  });

  it('has() returns true for routine-derived templates', () => {
    expect(registry.has('wr.templates.routine.test-alpha')).toBe(true);
    expect(registry.has('wr.templates.routine.test-beta')).toBe(true);
  });

  it('knownIds() includes routine-derived templates', () => {
    const ids = registry.knownIds();
    expect(ids).toContain('wr.templates.routine.test-alpha');
    expect(ids).toContain('wr.templates.routine.test-beta');
  });

  it('expands routine template with correct steps', () => {
    const expander = registry.resolve('wr.templates.routine.test-alpha')._unsafeUnwrap();
    const steps = expander('phase-1', {})._unsafeUnwrap();
    expect(steps).toHaveLength(1);
    expect(steps[0]!.id).toBe('phase-1.step-a');
    expect(steps[0]!.prompt).toBe('Do alpha.');
  });

  it('expands routine template with arg substitution', () => {
    const expander = registry.resolve('wr.templates.routine.test-beta')._unsafeUnwrap();
    const steps = expander('phase-2', { output: 'result.md' })._unsafeUnwrap();
    expect(steps[0]!.prompt).toBe('Create result.md.');
    expect(steps[0]!.guidance).toEqual(['Be beta.']);
  });

  it('still returns UNKNOWN_TEMPLATE for non-existent IDs', () => {
    const result = registry.resolve('wr.templates.routine.nonexistent');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('UNKNOWN_TEMPLATE');
  });

  it('skips invalid routines without crashing', () => {
    const routinesWithInvalid = new Map<string, WorkflowDefinition>([
      ['routine-valid', makeRoutineDefinition({
        id: 'routine-valid',
        steps: [{ id: 'step-1', title: 'Valid', prompt: 'OK.' }],
      })],
      ['routine-invalid', makeRoutineDefinition({
        id: 'routine-invalid',
        steps: [{ id: 'step-1', title: 'Bad' } as any], // missing prompt
      })],
    ]);

    const reg = createTemplateRegistry(routinesWithInvalid);
    expect(reg.has('wr.templates.routine.valid')).toBe(true);
    expect(reg.has('wr.templates.routine.invalid')).toBe(false);
  });
});
