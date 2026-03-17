/**
 * Resolve Templates Compiler Pass — Tests
 *
 * Tests template expansion with a fake registry (since the real
 * registry is empty). Validates the expansion machinery works.
 */
import { describe, it, expect } from 'vitest';
import { resolveTemplatesPass } from '../../../src/application/services/compiler/resolve-templates.js';
import { createTemplateRegistry } from '../../../src/application/services/compiler/template-registry.js';
import type { TemplateRegistry } from '../../../src/application/services/compiler/template-registry.js';
import type { WorkflowStepDefinition, LoopStepDefinition } from '../../../src/types/workflow-definition.js';
import { ok, err } from 'neverthrow';

// ---------------------------------------------------------------------------
// Fake registry for testing expansion machinery
// ---------------------------------------------------------------------------

function createTestRegistry(): TemplateRegistry {
  return {
    resolve(templateId: string) {
      if (templateId === 'wr.templates.test_probe') {
        return ok((callerId: string, _args: Readonly<Record<string, unknown>>) => {
          return ok([
            { id: `${callerId}.check`, title: 'Check capability', prompt: 'Check if capability exists.' },
            { id: `${callerId}.use`, title: 'Use capability', prompt: 'Use the capability.' },
          ] as const satisfies readonly WorkflowStepDefinition[]);
        });
      }
      if (templateId === 'wr.templates.failing') {
        return ok((_callerId: string, _args: Readonly<Record<string, unknown>>) => {
          return err({
            code: 'TEMPLATE_EXPAND_FAILED' as const,
            templateId: 'wr.templates.failing',
            message: 'Intentional expansion failure.',
          });
        });
      }
      return err({
        code: 'UNKNOWN_TEMPLATE' as const,
        templateId,
        message: `Unknown template '${templateId}'.`,
      });
    },
    has(id: string) {
      return id === 'wr.templates.test_probe' || id === 'wr.templates.failing';
    },
    knownIds() {
      return ['wr.templates.test_probe', 'wr.templates.failing'];
    },
  };
}

const testRegistry = createTestRegistry();

describe('resolveTemplatesPass', () => {
  describe('with real (empty) registry', () => {
    const emptyRegistry = createTemplateRegistry();

    it('passes through steps without templateCall unchanged', () => {
      const steps: WorkflowStepDefinition[] = [
        { id: 'step-1', title: 'Step 1', prompt: 'Do something.' },
      ];
      const result = resolveTemplatesPass(steps, emptyRegistry);
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual(steps);
    });

    it('returns error for step with templateCall (registry is empty)', () => {
      const steps: WorkflowStepDefinition[] = [
        {
          id: 'step-1',
          title: 'Probe',
          templateCall: { templateId: 'wr.templates.test_probe' },
        },
      ];
      const result = resolveTemplatesPass(steps, emptyRegistry);
      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.code).toBe('TEMPLATE_RESOLVE_ERROR');
      expect(error.stepId).toBe('step-1');
    });
  });

  describe('with test registry', () => {
    it('expands a template_call step into multiple steps', () => {
      const steps: WorkflowStepDefinition[] = [
        {
          id: 'phase-0',
          title: 'Probe',
          templateCall: { templateId: 'wr.templates.test_probe' },
        },
      ];
      const result = resolveTemplatesPass(steps, testRegistry);
      expect(result.isOk()).toBe(true);
      const resolved = result._unsafeUnwrap();
      expect(resolved.length).toBe(2);
      expect(resolved[0]!.id).toBe('phase-0.check');
      expect(resolved[1]!.id).toBe('phase-0.use');
    });

    it('preserves non-template steps around expanded steps', () => {
      const steps: WorkflowStepDefinition[] = [
        { id: 'before', title: 'Before', prompt: 'Before.' },
        {
          id: 'probe',
          title: 'Probe',
          templateCall: { templateId: 'wr.templates.test_probe' },
        },
        { id: 'after', title: 'After', prompt: 'After.' },
      ];
      const result = resolveTemplatesPass(steps, testRegistry);
      expect(result.isOk()).toBe(true);
      const resolved = result._unsafeUnwrap();
      expect(resolved.length).toBe(4);
      expect(resolved[0]!.id).toBe('before');
      expect(resolved[1]!.id).toBe('probe.check');
      expect(resolved[2]!.id).toBe('probe.use');
      expect(resolved[3]!.id).toBe('after');
    });

    it('returns error for unknown template', () => {
      const steps: WorkflowStepDefinition[] = [
        {
          id: 'step-1',
          title: 'Unknown',
          templateCall: { templateId: 'wr.templates.nonexistent' },
        },
      ];
      const result = resolveTemplatesPass(steps, testRegistry);
      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.code).toBe('TEMPLATE_RESOLVE_ERROR');
      expect(error.stepId).toBe('step-1');
      expect(error.cause.code).toBe('UNKNOWN_TEMPLATE');
    });

    it('returns error when template expansion fails', () => {
      const steps: WorkflowStepDefinition[] = [
        {
          id: 'step-1',
          title: 'Failing',
          templateCall: { templateId: 'wr.templates.failing' },
        },
      ];
      const result = resolveTemplatesPass(steps, testRegistry);
      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.code).toBe('TEMPLATE_EXPAND_ERROR');
      expect(error.stepId).toBe('step-1');
    });

    it('expands template_call in loop body steps', () => {
      const loopStep: LoopStepDefinition = {
        id: 'loop-1',
        title: 'Loop',
        prompt: 'Loop prompt.',
        type: 'loop',
        loop: { type: 'while', maxIterations: 3 },
        body: [
          {
            id: 'body-probe',
            title: 'Body Probe',
            templateCall: { templateId: 'wr.templates.test_probe' },
          },
        ],
      };
      const result = resolveTemplatesPass([loopStep], testRegistry);
      expect(result.isOk()).toBe(true);
      const resolved = result._unsafeUnwrap()[0] as LoopStepDefinition;
      const body = resolved.body as WorkflowStepDefinition[];
      expect(body.length).toBe(2);
      expect(body[0]!.id).toBe('body-probe.check');
      expect(body[1]!.id).toBe('body-probe.use');
    });

    it('preserves loop structure after expansion', () => {
      const loopStep: LoopStepDefinition = {
        id: 'loop-1',
        title: 'Loop',
        prompt: 'Loop prompt.',
        type: 'loop',
        loop: { type: 'while', maxIterations: 5 },
        body: [{ id: 'body-1', title: 'Body', prompt: 'Body prompt.' }],
      };
      const result = resolveTemplatesPass([loopStep], testRegistry);
      expect(result.isOk()).toBe(true);
      const resolved = result._unsafeUnwrap()[0] as LoopStepDefinition;
      expect(resolved.type).toBe('loop');
      expect(resolved.loop.type).toBe('while');
      expect(resolved.loop.maxIterations).toBe(5);
    });

    it('is deterministic: same input always produces same output', () => {
      const steps: WorkflowStepDefinition[] = [
        {
          id: 'probe',
          title: 'Probe',
          templateCall: { templateId: 'wr.templates.test_probe' },
        },
      ];
      const a = resolveTemplatesPass(steps, testRegistry)._unsafeUnwrap();
      const b = resolveTemplatesPass(steps, testRegistry)._unsafeUnwrap();
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
  });

  describe('with routine-derived registry', () => {
    // Integration test: routine JSON -> template registry -> resolveTemplatesPass
    const routineDefinitions = new Map([
      ['routine-test-design', {
        id: 'routine-test-design',
        name: 'Test Design Routine',
        description: 'A test design routine',
        version: '1.0.0',
        metaGuidance: ['Think deeply about the problem.'],
        steps: [
          { id: 'step-understand', title: 'Understand', prompt: 'Understand the problem for {deliverableName}.', agentRole: 'You are a designer.' },
          { id: 'step-generate', title: 'Generate', prompt: 'Generate candidates.' },
          { id: 'step-deliver', title: 'Deliver', prompt: 'Create `{deliverableName}`.' },
        ],
      }],
    ]);

    const routineRegistry = createTemplateRegistry(routineDefinitions as any);

    it('expands routine-derived template via resolveTemplatesPass', () => {
      const steps: WorkflowStepDefinition[] = [
        { id: 'before', title: 'Before', prompt: 'Before step.' },
        {
          id: 'phase-1-design',
          title: 'Phase 1: Design',
          templateCall: {
            templateId: 'wr.templates.routine.test-design',
            args: { deliverableName: 'design-candidates.md' },
          },
        },
        { id: 'after', title: 'After', prompt: 'After step.' },
      ];

      const result = resolveTemplatesPass(steps, routineRegistry);
      expect(result.isOk()).toBe(true);
      const resolved = result._unsafeUnwrap();

      // 1 before + 3 routine steps + 1 after = 5
      expect(resolved).toHaveLength(5);
      expect(resolved[0]!.id).toBe('before');
      expect(resolved[1]!.id).toBe('phase-1-design.step-understand');
      expect(resolved[2]!.id).toBe('phase-1-design.step-generate');
      expect(resolved[3]!.id).toBe('phase-1-design.step-deliver');
      expect(resolved[4]!.id).toBe('after');
    });

    it('substitutes args in expanded routine step prompts', () => {
      const steps: WorkflowStepDefinition[] = [
        {
          id: 'design',
          title: 'Design',
          templateCall: {
            templateId: 'wr.templates.routine.test-design',
            args: { deliverableName: 'output.md' },
          },
        },
      ];

      const resolved = resolveTemplatesPass(steps, routineRegistry)._unsafeUnwrap();
      expect((resolved[0] as WorkflowStepDefinition).prompt).toBe('Understand the problem for output.md.');
      expect((resolved[2] as WorkflowStepDefinition).prompt).toBe('Create `output.md`.');
    });

    it('injects routine metaGuidance as step-level guidance', () => {
      const steps: WorkflowStepDefinition[] = [
        {
          id: 'design',
          title: 'Design',
          templateCall: {
            templateId: 'wr.templates.routine.test-design',
            args: { deliverableName: 'output.md' },
          },
        },
      ];

      const resolved = resolveTemplatesPass(steps, routineRegistry)._unsafeUnwrap();
      // All expanded steps should have the routine metaGuidance as guidance
      for (const step of resolved) {
        expect((step as WorkflowStepDefinition).guidance).toContain('Think deeply about the problem.');
      }
    });

    it('preserves agentRole from routine steps', () => {
      const steps: WorkflowStepDefinition[] = [
        {
          id: 'design',
          title: 'Design',
          templateCall: {
            templateId: 'wr.templates.routine.test-design',
            args: { deliverableName: 'output.md' },
          },
        },
      ];

      const resolved = resolveTemplatesPass(steps, routineRegistry)._unsafeUnwrap();
      expect((resolved[0] as WorkflowStepDefinition).agentRole).toBe('You are a designer.');
      // Steps without agentRole should not have it
      expect((resolved[1] as WorkflowStepDefinition).agentRole).toBeUndefined();
    });

    it('fails when required args are missing', () => {
      const steps: WorkflowStepDefinition[] = [
        {
          id: 'design',
          title: 'Design',
          templateCall: {
            templateId: 'wr.templates.routine.test-design',
            args: {}, // missing deliverableName
          },
        },
      ];

      const result = resolveTemplatesPass(steps, routineRegistry);
      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.code).toBe('TEMPLATE_EXPAND_ERROR');
      expect(error.cause.message).toContain('MISSING_TEMPLATE_ARG');
      expect(error.cause.message).toContain('deliverableName');
    });
  });
});
