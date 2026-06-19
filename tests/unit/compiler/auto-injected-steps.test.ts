/**
 * Tests for dynamic compiler step expansion and validation of auto-injected virtual steps (synthesis, audit, verification).
 */
import { describe, it, expect } from 'vitest';
import { createWorkflow } from '../../../src/types/workflow.js';
import { createBundledSource } from '../../../src/types/workflow-source.js';
import type { Workflow } from '../../../src/types/workflow.js';
import type { WorkflowDefinition } from '../../../src/types/workflow-definition.js';
import { validateWorkflowSchema } from '../../../src/application/validation.js';
import { ValidationEngine } from '../../../src/application/services/validation-engine.js';
import { EnhancedLoopValidator } from '../../../src/application/services/enhanced-loop-validator.js';
import { WorkflowCompiler } from '../../../src/application/services/workflow-compiler.ts';

function makeWorkflow(definition: WorkflowDefinition): Workflow {
  return createWorkflow(definition, createBundledSource());
}

describe('Universal Auto-Injected Virtual Steps — Compiler & Validation', () => {
  const loopValidator = new EnhancedLoopValidator();
  const validationEngine = new ValidationEngine(loopValidator);
  const compiler = new WorkflowCompiler();

  it('compiles a verification step from a verification block on a standard step', () => {
    const wfDef: WorkflowDefinition = {
      id: 'test-verification',
      name: 'Verification Test',
      description: 'Tests verification virtual step compilation',
      version: '1.0.0',
      steps: [
        {
          id: 'step-1',
          title: 'Run build',
          prompt: 'Execute typescript compilation.',
          verification: {
            command: 'npm run build',
            prompt: 'Make sure it compiles.',
          },
        },
      ],
    };

    const wf = makeWorkflow(wfDef);
    
    // JSON schema must accept it
    const schemaResult = validateWorkflowSchema(wf);
    expect(schemaResult.isOk()).toBe(true);

    // Validation engine must accept it
    const valResult = validationEngine.validateWorkflow(wf);
    expect(valResult.valid).toBe(true);

    // Compiler must expand it
    const compileResult = compiler.compile(wf);
    expect(compileResult.isOk()).toBe(true);

    const compiled = compileResult._unsafeUnwrap();
    expect(compiled.steps).toHaveLength(2);
    
    const step1 = compiled.steps[0]!;
    const step2 = compiled.steps[1]!;

    expect(step1.id).toBe('step-1');
    expect(step2.id).toBe('step-1__verification');
    expect(step2.title).toBe('Verify: Run build');
    expect(step2.prompt).toBe('Make sure it compiles.');
    expect((step2 as any).notesOptional).toBe(true);
  });

  it('compiles a verification step with generic cognitive fallback prompt when command is omitted', () => {
    const wfDef: WorkflowDefinition = {
      id: 'test-verification-no-command',
      name: 'Verification No Command Test',
      description: 'Tests verification virtual step compilation without command',
      version: '1.0.0',
      steps: [
        {
          id: 'step-1',
          title: 'Do changes',
          prompt: 'Make the required code modifications.',
          verification: {},
        },
      ],
    };

    const wf = makeWorkflow(wfDef);
    
    const schemaResult = validateWorkflowSchema(wf);
    expect(schemaResult.isOk()).toBe(true);

    const valResult = validationEngine.validateWorkflow(wf);
    expect(valResult.valid).toBe(true);

    const compileResult = compiler.compile(wf);
    expect(compileResult.isOk()).toBe(true);

    const compiled = compileResult._unsafeUnwrap();
    expect(compiled.steps).toHaveLength(2);
    
    const step2 = compiled.steps[1]!;
    expect(step2.id).toBe('step-1__verification');
    expect(step2.prompt).toContain('Run the appropriate verification commands, test suites, or build checks');
  });

  it('compiles an audit step from an audit block on a standard step', () => {
    const wfDef: WorkflowDefinition = {
      id: 'test-audit',
      name: 'Audit Test',
      description: 'Tests audit virtual step compilation',
      version: '1.0.0',
      steps: [
        {
          id: 'step-1',
          title: 'Implement code',
          prompt: 'Write clean typescript code.',
          audit: {
            rubric: ['Assert no decorative emojis are used', 'Must compile green'],
          },
        },
      ],
    };

    const wf = makeWorkflow(wfDef);
    const schemaResult = validateWorkflowSchema(wf);
    expect(schemaResult.isOk()).toBe(true);

    const valResult = validationEngine.validateWorkflow(wf);
    expect(valResult.valid).toBe(true);

    const compileResult = compiler.compile(wf);
    expect(compileResult.isOk()).toBe(true);

    const compiled = compileResult._unsafeUnwrap();
    expect(compiled.steps).toHaveLength(2);

    const step2 = compiled.steps[1]!;
    expect(step2.id).toBe('step-1__audit');
    expect(step2.title).toBe('Audit: Implement code');
    expect(step2.prompt).toContain('Assert no decorative emojis are used');
    expect((step2 as any).notesOptional).toBe(true);
  });

  it('compiles both verification and audit steps sequentially when both are defined', () => {
    const wfDef: WorkflowDefinition = {
      id: 'test-both-verification-and-audit',
      name: 'Verification and Audit Test',
      description: 'Tests sequential verification and audit compilation',
      version: '1.0.0',
      steps: [
        {
          id: 'step-1',
          title: 'Core implementation',
          prompt: 'Do the work.',
          verification: {
            command: 'npm run test',
          },
          audit: {
            prompt: 'Audit the output.',
          },
        },
      ],
    };

    const wf = makeWorkflow(wfDef);
    const compileResult = compiler.compile(wf);
    expect(compileResult.isOk()).toBe(true);

    const compiled = compileResult._unsafeUnwrap();
    expect(compiled.steps).toHaveLength(3);

    expect(compiled.steps[0]!.id).toBe('step-1');
    expect(compiled.steps[1]!.id).toBe('step-1__verification');
    expect(compiled.steps[2]!.id).toBe('step-1__audit');
  });

  it('compiles a synthesis step from a synthesis block on a parallel step', () => {
    const wfDef: WorkflowDefinition = {
      id: 'test-synthesis',
      name: 'Synthesis Test',
      description: 'Tests synthesis virtual step compilation on parallel steps',
      version: '1.0.0',
      steps: [
        {
          id: 'step-parallel',
          title: 'Parallel delegation',
          type: 'parallel',
          parallelDelegations: [
            {
              workflowId: 'wr.routine-context-gathering',
            },
          ],
          synthesis: {
            prompt: 'Custom synthesis prompt',
          },
        },
      ],
    };

    const wf = makeWorkflow(wfDef);
    const schemaResult = validateWorkflowSchema(wf);
    expect(schemaResult.isOk()).toBe(true);

    const valResult = validationEngine.validateWorkflow(wf);
    expect(valResult.valid).toBe(true);

    const compileResult = compiler.compile(wf);
    expect(compileResult.isOk()).toBe(true);

    const compiled = compileResult._unsafeUnwrap();
    expect(compiled.steps).toHaveLength(2);

    expect(compiled.steps[0]!.id).toBe('step-parallel');
    expect(compiled.steps[1]!.id).toBe('step-parallel__synthesis');
    expect(compiled.steps[1]!.title).toBe('Synthesis: Parallel delegation');
    expect(compiled.steps[1]!.prompt).toBe('Custom synthesis prompt');
  });

  it('compiles virtual steps recursively inside inline loop body steps', () => {
    const wfDef: WorkflowDefinition = {
      id: 'test-loop-splicing',
      name: 'Loop Splicing Test',
      description: 'Tests virtual step compilation inside loop bodies',
      version: '1.0.0',
      steps: [
        {
          id: 'my-loop',
          title: 'Process items',
          type: 'loop',
          loop: {
            type: 'for',
            count: 3,
            maxIterations: 5,
          },
          body: [
            {
              id: 'inline-step-1',
              title: 'Work on item',
              prompt: 'Process the item.',
              verification: {
                command: 'npm run test:unit',
              },
            },
          ],
        },
      ],
    };

    const wf = makeWorkflow(wfDef);
    const schemaResult = validateWorkflowSchema(wf);
    expect(schemaResult.isOk()).toBe(true);

    const valResult = validationEngine.validateWorkflow(wf);
    expect(valResult.valid).toBe(true);

    const compileResult = compiler.compile(wf);
    expect(compileResult.isOk()).toBe(true);

    const compiled = compileResult._unsafeUnwrap();
    const compiledLoop = compiled.compiledLoops.get('my-loop')!;
    expect(compiledLoop).toBeDefined();
    
    // Assert loop body steps contain the expanded verification step!
    expect(compiledLoop.bodySteps).toHaveLength(2);
    expect(compiledLoop.bodySteps[0]!.id).toBe('inline-step-1');
    expect(compiledLoop.bodySteps[1]!.id).toBe('inline-step-1__verification');
    
    // Assert that stepById correctly indexes both body steps
    expect(compiled.stepById.has('inline-step-1')).toBe(true);
    expect(compiled.stepById.has('inline-step-1__verification')).toBe(true);
  });

  it('rejects illegal properties using the validation engine', () => {
    // 1. Audit on a parallel step
    const badParallel: WorkflowDefinition = {
      id: 'test-bad-parallel',
      name: 'Bad Parallel',
      description: 'Audit on parallel step',
      version: '1.0.0',
      steps: [
        {
          id: 'step-1',
          title: 'Parallel',
          type: 'parallel',
          parallelDelegations: [
            {
              workflowId: 'wr.routine-context-gathering',
            },
          ],
          audit: {
            prompt: 'Audit not allowed on parallel',
          },
        } as any,
      ],
    };

    const wf1 = makeWorkflow(badParallel);
    const valResult1 = validationEngine.validateWorkflow(wf1);
    expect(valResult1.valid).toBe(false);
    expect(valResult1.issues).toContain("Step 'step-1': audit configuration is not allowed on parallel steps");

    // 2. Synthesis on a standard step
    const badStandard: WorkflowDefinition = {
      id: 'test-bad-standard',
      name: 'Bad Standard',
      description: 'Synthesis on standard step',
      version: '1.0.0',
      steps: [
        {
          id: 'step-1',
          title: 'Standard',
          prompt: 'Do work.',
          synthesis: {
            prompt: 'Synthesis not allowed on standard',
          },
        } as any,
      ],
    };

    const wf2 = makeWorkflow(badStandard);
    const valResult2 = validationEngine.validateWorkflow(wf2);
    expect(valResult2.valid).toBe(false);
    expect(valResult2.issues).toContain("Step 'step-1': synthesis configuration is only allowed on parallel steps");
  });

  it('fails compilation gracefully (errors-as-data) if there is an ID collision with custom author definitions', () => {
    const wfDef: WorkflowDefinition = {
      id: 'test-id-collision',
      name: 'ID Collision Test',
      description: 'Tests custom audit ID collision failure',
      version: '1.0.0',
      steps: [
        {
          id: 'step-1',
          title: 'Core work',
          prompt: 'Do work.',
          audit: {
            prompt: 'Verify.',
          },
        },
        {
          id: 'step-1__audit',
          title: 'Manual Audit step',
          prompt: 'Conflicting manual audit step.',
        },
      ],
    };

    const wf = makeWorkflow(wfDef);
    const compileResult = compiler.compile(wf);
    
    // Must return an Err Result, NOT throw
    expect(compileResult.isErr()).toBe(true);
    expect(compileResult._unsafeUnwrapErr().message).toContain("Duplicate step id 'step-1__audit'");
  });

  it('inherits the agentRole of the parent step definition on auto-injected virtual steps', () => {
    const wfDef: WorkflowDefinition = {
      id: 'test-role-inheritance',
      name: 'Role Inheritance Test',
      description: 'Tests role propagation on expanded virtual steps',
      version: '1.0.0',
      steps: [
        {
          id: 'step-1',
          title: 'Trusted compilation',
          prompt: 'Execute secure build.',
          agentRole: 'You are a highly-privileged trusted-deployer.',
          verification: {
            command: 'npm run deploy',
          },
          audit: {
            prompt: 'Verify audit.',
          },
        },
      ],
    };

    const wf = makeWorkflow(wfDef);
    const compileResult = compiler.compile(wf);
    expect(compileResult.isOk()).toBe(true);

    const compiled = compileResult._unsafeUnwrap();
    expect(compiled.steps).toHaveLength(3);

    const step1 = compiled.steps[0]!;
    const step2 = compiled.steps[1]!;
    const step3 = compiled.steps[2]!;

    expect(step1.id).toBe('step-1');
    expect(step2.id).toBe('step-1__verification');
    expect(step3.id).toBe('step-1__audit');

    // Virtual steps must NOT inherit the parent's agentRole to keep prompt context clean
    expect(step1.agentRole).toBe('You are a highly-privileged trusted-deployer.');
    expect(step2.agentRole).toBeUndefined();
    expect(step3.agentRole).toBeUndefined();
  });

  it('rejects loop steps referencing sibling steps that contain virtual verification or audit blocks', () => {
    const wfDef: WorkflowDefinition = {
      id: 'test-loop-sibling-escape',
      name: 'Sibling Escape Block Test',
      description: 'Tests validation rejection of escape loop sibling references',
      version: '1.0.0',
      steps: [
        {
          id: 'my-loop',
          title: 'Loop with sibling reference',
          type: 'loop',
          loop: {
            type: 'for',
            count: 3,
            maxIterations: 5,
          },
          body: 'sibling-step',
        },
        {
          id: 'sibling-step',
          title: 'Sibling work',
          prompt: 'Do sibling task.',
          verification: {
            command: 'npm run test',
          },
        },
      ],
    };

    const wf = makeWorkflow(wfDef);
    const valResult = validationEngine.validateWorkflow(wf);
    
    expect(valResult.valid).toBe(false);
    expect(valResult.issues[0]).toContain("references sibling step 'sibling-step' with verification/audit blocks");
    expect(valResult.suggestions[0]).toContain("Move the definition of step 'sibling-step' directly inside the body array");
  });
});
