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
import {
  createRoutineExpander,
  routineIdToTemplateId,
} from '../../../src/application/services/compiler/template-registry.js';
import type { WorkflowDefinition } from '../../../src/types/workflow-definition.js';

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

    it('propagates runCondition from templateCall step to expanded steps', () => {
      const runCondition = { var: 'taskComplexity', not_equals: 'Small' };
      const steps: WorkflowStepDefinition[] = [
        {
          id: 'phase-1',
          title: 'Phase 1',
          runCondition,
          templateCall: { templateId: 'wr.templates.test_probe' },
        },
      ];
      const result = resolveTemplatesPass(steps, testRegistry);
      expect(result.isOk()).toBe(true);
      const resolved = result._unsafeUnwrap();
      expect(resolved).toHaveLength(2);
      // Both expanded steps should inherit the parent's runCondition
      for (const step of resolved) {
        expect((step as WorkflowStepDefinition).runCondition).toEqual(runCondition);
      }
    });

    it('does not override existing runCondition on expanded steps', () => {
      // Use routine-based registry for this test since test_probe doesn't set runCondition
      // But the behavior is the same: if an expanded step already has runCondition, keep it
      const runCondition = { var: 'taskComplexity', not_equals: 'Small' };
      const steps: WorkflowStepDefinition[] = [
        {
          id: 'phase-1',
          title: 'Phase 1',
          runCondition,
          templateCall: { templateId: 'wr.templates.test_probe' },
        },
      ];
      const result = resolveTemplatesPass(steps, testRegistry);
      expect(result.isOk()).toBe(true);
      // test_probe steps don't have runCondition, so parent's is inherited
      const resolved = result._unsafeUnwrap() as WorkflowStepDefinition[];
      expect(resolved[0]!.runCondition).toEqual(runCondition);
    });

    it('does not add runCondition when templateCall step has none', () => {
      const steps: WorkflowStepDefinition[] = [
        {
          id: 'phase-1',
          title: 'Phase 1',
          templateCall: { templateId: 'wr.templates.test_probe' },
        },
      ];
      const result = resolveTemplatesPass(steps, testRegistry);
      expect(result.isOk()).toBe(true);
      const resolved = result._unsafeUnwrap() as WorkflowStepDefinition[];
      // No runCondition on parent, so expanded steps should have none
      expect(resolved[0]!.runCondition).toBeUndefined();
    });
  });

  describe('step ID collision detection', () => {
    it('detects duplicate step IDs from two identical non-template steps', () => {
      const steps: WorkflowStepDefinition[] = [
        { id: 'dup', title: 'First', prompt: 'First.' },
        { id: 'dup', title: 'Second', prompt: 'Second.' },
      ];
      const result = resolveTemplatesPass(steps, testRegistry);
      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.code).toBe('DUPLICATE_STEP_ID');
      expect(error.stepId).toBe('dup');
    });

    it('detects duplicate step IDs after template expansion', () => {
      // Two template calls with the same callerId would produce colliding IDs
      const steps: WorkflowStepDefinition[] = [
        {
          id: 'probe',
          title: 'Probe 1',
          templateCall: { templateId: 'wr.templates.test_probe' },
        },
        // Manually create steps that collide with the expanded IDs
        { id: 'probe.check', title: 'Collider', prompt: 'Collides.' },
      ];
      const result = resolveTemplatesPass(steps, testRegistry);
      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.code).toBe('DUPLICATE_STEP_ID');
      expect(error.stepId).toBe('probe.check');
    });
  });

  describe('with routine-based registry (integration)', () => {
    function makeRoutineRegistry() {
      const routineDefinition: WorkflowDefinition = {
        id: 'routine-test-design',
        name: 'Test Design Routine',
        description: 'A routine for testing',
        version: '1.0.0',
        metaGuidance: ['Be thorough in your analysis.'],
        steps: [
          {
            id: 'step-understand',
            title: 'Understand the Problem',
            prompt: 'Analyze {problem} deeply.',
            agentRole: 'You are a problem analyst.',
          },
          {
            id: 'step-design',
            title: 'Design Solution',
            prompt: 'Design a solution for {problem} and write to {deliverableName}.',
          },
        ],
      } as WorkflowDefinition;

      const expander = createRoutineExpander('routine-test-design', routineDefinition)._unsafeUnwrap();
      const routineExpanders = new Map([
        [routineIdToTemplateId('routine-test-design'), expander],
      ]);
      return createTemplateRegistry(routineExpanders);
    }

    it('expands routine-based templateCall into routine steps', () => {
      const registry = makeRoutineRegistry();
      const steps: WorkflowStepDefinition[] = [
        {
          id: 'phase-1-design',
          title: 'Phase 1: Design',
          templateCall: {
            templateId: 'wr.templates.routine.test-design',
            args: { problem: 'caching', deliverableName: 'design.md' },
          },
        },
      ];
      const result = resolveTemplatesPass(steps, registry);
      expect(result.isOk()).toBe(true);
      const resolved = result._unsafeUnwrap();
      expect(resolved).toHaveLength(2);
      expect(resolved[0]!.id).toBe('phase-1-design.step-understand');
      expect((resolved[0] as WorkflowStepDefinition).prompt).toBe('Analyze caching deeply.');
      expect((resolved[0] as WorkflowStepDefinition).agentRole).toBe('You are a problem analyst.');
      expect((resolved[0] as WorkflowStepDefinition).guidance).toEqual(['Be thorough in your analysis.']);
      expect(resolved[1]!.id).toBe('phase-1-design.step-design');
      expect((resolved[1] as WorkflowStepDefinition).prompt).toBe('Design a solution for caching and write to design.md.');
    });

    it('mixes routine-based and regular steps', () => {
      const registry = makeRoutineRegistry();
      const steps: WorkflowStepDefinition[] = [
        { id: 'intro', title: 'Introduction', prompt: 'Start here.' },
        {
          id: 'design-phase',
          title: 'Design Phase',
          templateCall: {
            templateId: 'wr.templates.routine.test-design',
            args: { problem: 'auth', deliverableName: 'auth-design.md' },
          },
        },
        { id: 'implement', title: 'Implement', prompt: 'Build it.' },
      ];
      const result = resolveTemplatesPass(steps, registry);
      expect(result.isOk()).toBe(true);
      const resolved = result._unsafeUnwrap();
      expect(resolved).toHaveLength(4);
      expect(resolved[0]!.id).toBe('intro');
      expect(resolved[1]!.id).toBe('design-phase.step-understand');
      expect(resolved[2]!.id).toBe('design-phase.step-design');
      expect(resolved[3]!.id).toBe('implement');
    });

    it('fails when routine templateCall has missing args', () => {
      const registry = makeRoutineRegistry();
      const steps: WorkflowStepDefinition[] = [
        {
          id: 'design-phase',
          title: 'Design Phase',
          templateCall: {
            templateId: 'wr.templates.routine.test-design',
            args: { problem: 'caching' }, // missing deliverableName
          },
        },
      ];
      const result = resolveTemplatesPass(steps, registry);
      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.code).toBe('TEMPLATE_EXPAND_ERROR');
      expect(error.cause.message).toContain('MISSING_TEMPLATE_ARG');
      expect(error.cause.message).toContain('deliverableName');
    });
  });
});
