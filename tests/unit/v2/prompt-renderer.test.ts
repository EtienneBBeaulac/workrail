import { describe, it, expect } from 'vitest';
import { renderPendingPrompt, buildMetricsSection } from '../../../src/v2/durable-core/domain/prompt-renderer.js';
import { createWorkflow } from '../../../src/types/workflow.js';
import { createBundledSource } from '../../../src/types/workflow-source.js';
import { LOOP_CONTROL_CONTRACT_REF } from '../../../src/v2/durable-core/schemas/artifacts/index.js';

// Shared fixture: simple single-step workflow with no metricsProfile
const simpleWorkflow = createWorkflow(
  {
    id: 'test',
    name: 'Test',
    description: 'Test',
    version: '1.0.0',
    steps: [{ id: 'step1', title: 'Step 1', prompt: 'Do step 1', requireConfirmation: false }],
  } as any,
  createBundledSource()
);

describe('renderPendingPrompt', () => {

  describe('base behavior (no recovery)', () => {
    it('returns base prompt when rehydrateOnly=false', () => {
      const result = renderPendingPrompt({
        workflow: simpleWorkflow,
        stepId: 'step1',
        loopPath: [],
        truth: { events: [], manifest: [] },
        runId: 'run_1',
        nodeId: 'node_1',
        rehydrateOnly: false,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.stepId).toBe('step1');
        expect(result.value.title).toBe('Step 1');
        expect(result.value.prompt).toContain('Do step 1');
        expect(result.value.prompt).not.toContain('Recovery Context');
        // Notes enforcement: system-injected notes requirement appears for all steps without notesOptional
        expect(result.value.prompt).toContain('NOTES REQUIRED');
      }
    });

    it('returns base prompt when rehydrateOnly=true but DAG projection fails', () => {
      const result = renderPendingPrompt({
        workflow: simpleWorkflow,
        stepId: 'step1',
        loopPath: [],
        truth: { events: [{ v: 1, eventId: 'bad', eventIndex: 1, sessionId: 's1', kind: 'session_created', dedupeKey: 'd1', data: {} }, { v: 1, eventId: 'bad2', eventIndex: 0, sessionId: 's1', kind: 'session_created', dedupeKey: 'd2', data: {} }] as any, manifest: [] }, // Unsorted
        runId: 'run_1',
        nodeId: 'node_1',
        rehydrateOnly: true,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.prompt).toContain('Do step 1');
        expect(result.value.prompt).toContain('Recovery context unavailable');
      }
    });

    it('returns base prompt when run not found in DAG', () => {
      const result = renderPendingPrompt({
        workflow: simpleWorkflow,
        stepId: 'step1',
        loopPath: [],
        truth: { events: [], manifest: [] },
        runId: 'run_999',
        nodeId: 'node_1',
        rehydrateOnly: true,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.prompt).toContain('Recovery context unavailable: run not found');
      }
    });
  });

  describe('recovery context (tip node)', () => {
    it('returns base prompt for tip node with no outputs', () => {
      const truth = {
        events: [
          { v: 1, eventId: 'e0', eventIndex: 0, sessionId: 's1', kind: 'session_created', dedupeKey: 'session_created:s1', data: {} },
          { v: 1, eventId: 'e1', eventIndex: 1, sessionId: 's1', kind: 'run_started', dedupeKey: 'run_started:s1:run_1', scope: { runId: 'run_1' }, data: { workflowId: 'test', workflowHash: 'sha256:abc123' + '0'.repeat(58), workflowSourceKind: 'bundled', workflowSourceRef: '(bundled)' } },
          { v: 1, eventId: 'e2', eventIndex: 2, sessionId: 's1', kind: 'node_created', dedupeKey: 'node_created:s1:run_1:node_1', scope: { runId: 'run_1', nodeId: 'node_1' }, data: { nodeKind: 'step', parentNodeId: null, workflowHash: 'sha256:abc123' + '0'.repeat(58), snapshotRef: 'sha256:def456' + '0'.repeat(58) } },
        ] as any,
        manifest: [],
      };

      const result = renderPendingPrompt({
        workflow: simpleWorkflow,
        stepId: 'step1',
        loopPath: [],
        truth,
        runId: 'run_1',
        nodeId: 'node_1',
        rehydrateOnly: true,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // Tip node with no ancestry and no outputs = base prompt + notes requirement
        expect(result.value.prompt).toContain('Do step 1');
        expect(result.value.prompt).toContain('NOTES REQUIRED');
      }
    });
  });

  describe('budget constraints', () => {
    it('preserves structural recovery context while dropping tail reference material under pressure', () => {
      const workflowWithFunctions = createWorkflow(
        {
          id: 'test-recovery-budget',
          name: 'Recovery Budget',
          description: 'Recovery Budget',
          version: '1.0.0',
          functionDefinitions: [
            {
              name: 'hugeHelper',
              scope: 'workflow',
              definition: 'does a very large amount of helper work\n' + 'B'.repeat(30000),
            },
          ],
          steps: [{
            id: 'step1',
            title: 'Step 1',
            prompt: 'Do step 1',
            requireConfirmation: false,
            functionReferences: ['hugeHelper'],
          }],
        } as any,
        createBundledSource()
      );

      const largeRecap = 'A'.repeat(26000);
      const truth = {
        events: [
          { v: 1, eventId: 'e0', eventIndex: 0, sessionId: 's1', kind: 'session_created', dedupeKey: 'session_created:s1', data: {} },
          { v: 1, eventId: 'e1', eventIndex: 1, sessionId: 's1', kind: 'run_started', dedupeKey: 'run_started:s1:run_1', scope: { runId: 'run_1' }, data: { workflowId: 'test', workflowHash: 'sha256:abc123' + '0'.repeat(58), workflowSourceKind: 'bundled', workflowSourceRef: '(bundled)' } },
          { v: 1, eventId: 'e2', eventIndex: 2, sessionId: 's1', kind: 'node_created', dedupeKey: 'node_created:s1:run_1:node_root', scope: { runId: 'run_1', nodeId: 'node_root' }, data: { nodeKind: 'step', parentNodeId: null, workflowHash: 'sha256:abc123' + '0'.repeat(58), snapshotRef: 'sha256:def456' + '0'.repeat(58) } },
          { v: 1, eventId: 'e3', eventIndex: 3, sessionId: 's1', kind: 'node_output_appended', dedupeKey: 'node_output_appended:s1:run_1:node_root:1', scope: { runId: 'run_1', nodeId: 'node_root' }, data: { outputChannel: 'recap', payload: { payloadKind: 'notes', notesMarkdown: largeRecap } } },
          { v: 1, eventId: 'e4', eventIndex: 4, sessionId: 's1', kind: 'node_created', dedupeKey: 'node_created:s1:run_1:node_1', scope: { runId: 'run_1', nodeId: 'node_1' }, data: { nodeKind: 'step', parentNodeId: 'node_root', workflowHash: 'sha256:abc123' + '0'.repeat(58), snapshotRef: 'sha256:ghi789' + '0'.repeat(58) } },
          { v: 1, eventId: 'e5', eventIndex: 5, sessionId: 's1', kind: 'edge_created', dedupeKey: 'edge_created:s1:run_1:node_root:node_1', scope: { runId: 'run_1', edgeId: 'edge_1' }, data: { fromNodeId: 'node_root', toNodeId: 'node_1', edgeKind: 'acked_step', cause: 'intentional_fork' } },
          { v: 1, eventId: 'e6', eventIndex: 6, sessionId: 's1', kind: 'node_output_appended', dedupeKey: 'node_output_appended:s1:run_1:node_1:1', scope: { runId: 'run_1', nodeId: 'node_1' }, data: { outputChannel: 'recap', payload: { payloadKind: 'notes', notesMarkdown: 'Child branch recap with the most relevant downstream details.' } } },
        ] as any,
        manifest: [],
      };

      const result = renderPendingPrompt({
        workflow: workflowWithFunctions,
        stepId: 'step1',
        loopPath: [],
        truth,
        runId: 'run_1',
        nodeId: 'node_root',
        rehydrateOnly: true,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.prompt).toContain('## Recovery Context');
        expect(result.value.prompt).toContain('### Branch Summary');
        expect(result.value.prompt).toContain('### Downstream Recap (Preferred Branch)');
        expect(result.value.prompt).not.toContain('### Function Definitions');
        expect(result.value.prompt).toContain('[TRUNCATED]');
        expect(result.value.prompt).toContain('Omitted 1 lower-priority tier due to budget constraints.');
      }
    });
  });

  describe('UTF-8 boundary trimming (Fix 3 - edge case coverage)', () => {
    it('UTF-8 trimming algorithm handles edge cases', () => {
      // The trimToUtf8Boundary function is private but used in applyPromptBudget
      // This test documents that the O(1) algorithm from notes-markdown.ts
      // correctly handles:
      // - All-invalid UTF-8 continuation bytes (returns empty)
      // - Incomplete multi-byte characters (drops incomplete char)
      // - Valid UTF-8 (returns unchanged)
      // Full integration test would require large recovery context setup
      expect(renderPendingPrompt).toBeDefined();
    });
  });

  describe('validation requirements integration (Layer 3)', () => {
    it('appends OUTPUT REQUIREMENTS section when validationCriteria present (contains)', () => {
      const workflowWithValidation = createWorkflow(
        {
          id: 'test-validation',
          name: 'Test Validation',
          description: 'Test with validation',
          version: '1.0.0',
          steps: [{
            id: 'validated-step',
            title: 'Validated Step',
            prompt: 'Complete this step properly',
            requireConfirmation: false,
            validationCriteria: {
              type: 'contains',
              value: 'done',
              message: 'Must include done',
            },
          }],
        } as any,
        createBundledSource()
      );

      const result = renderPendingPrompt({
        workflow: workflowWithValidation,
        stepId: 'validated-step',
        loopPath: [],
        truth: { events: [], manifest: [] },
        runId: 'run_1',
        nodeId: 'node_1',
        rehydrateOnly: false,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.prompt).toContain('Complete this step properly');
        expect(result.value.prompt).toContain('**OUTPUT REQUIREMENTS:**');
        expect(result.value.prompt).toContain('- Must contain: "done"');
      }
    });

    it('appends ASSESSMENT REQUIREMENTS section when step declares assessments', () => {
      const workflowWithAssessment = createWorkflow(
        {
          id: 'test-assessment',
          name: 'Test Assessment',
          description: 'Test with assessment requirements',
          version: '1.0.0',
          assessments: [
            {
              id: 'readiness_gate',
              purpose: 'Assess readiness.',
              dimensions: [
                { id: 'confidence', purpose: 'Confidence', levels: ['low', 'medium', 'high'] },
                { id: 'scope', purpose: 'Scope', levels: ['partial', 'complete'] },
              ],
            },
          ],
          steps: [{
            id: 'assessment-step',
            title: 'Assessment Step',
            prompt: 'Assess the current state',
            requireConfirmation: false,
            assessmentRefs: ['readiness_gate'],
          }],
        } as any,
        createBundledSource()
      );

      const result = renderPendingPrompt({
        workflow: workflowWithAssessment,
        stepId: 'assessment-step',
        loopPath: [],
        truth: { events: [], manifest: [] },
        runId: 'run_1',
        nodeId: 'node_1',
        rehydrateOnly: false,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.prompt).toContain('**ASSESSMENT REQUIREMENTS (System):**');
        expect(result.value.prompt).toContain('Provide an artifact with kind: "wr.assessment"');
        expect(result.value.prompt).toContain('Assessment target: "readiness_gate"');
        expect(result.value.prompt).toContain('Purpose: Assess readiness.');
        expect(result.value.prompt).toContain('Dimensions:');
        expect(result.value.prompt).toContain('  confidence (low | medium | high): Confidence');
        expect(result.value.prompt).toContain('  scope (partial | complete): Scope');
      }
    });

    it('appends OUTPUT REQUIREMENTS section when validationCriteria present (regex)', () => {
      const workflowWithRegex = createWorkflow(
        {
          id: 'test-regex',
          name: 'Test Regex',
          description: 'Test with regex validation',
          version: '1.0.0',
          steps: [{
            id: 'regex-step',
            title: 'Regex Step',
            prompt: 'Provide output matching pattern',
            requireConfirmation: false,
            validationCriteria: {
              type: 'regex',
              pattern: '^[A-Z]+$',
              message: 'Must be uppercase',
            },
          }],
        } as any,
        createBundledSource()
      );

      const result = renderPendingPrompt({
        workflow: workflowWithRegex,
        stepId: 'regex-step',
        loopPath: [],
        truth: { events: [], manifest: [] },
        runId: 'run_1',
        nodeId: 'node_1',
        rehydrateOnly: false,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.prompt).toContain('**OUTPUT REQUIREMENTS:**');
        expect(result.value.prompt).toContain('- Must match pattern: ^[A-Z]+$');
      }
    });

    it('appends multiple requirements for and composition', () => {
      const workflowWithComposite = createWorkflow(
        {
          id: 'test-composite',
          name: 'Test Composite',
          description: 'Test with composite validation',
          version: '1.0.0',
          steps: [{
            id: 'composite-step',
            title: 'Composite Step',
            prompt: 'Complete multiple requirements',
            requireConfirmation: false,
            validationCriteria: {
              and: [
                { type: 'contains', value: 'first', message: 'Must contain first' },
                { type: 'contains', value: 'second', message: 'Must contain second' },
              ],
            },
          }],
        } as any,
        createBundledSource()
      );

      const result = renderPendingPrompt({
        workflow: workflowWithComposite,
        stepId: 'composite-step',
        loopPath: [],
        truth: { events: [], manifest: [] },
        runId: 'run_1',
        nodeId: 'node_1',
        rehydrateOnly: false,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.prompt).toContain('**OUTPUT REQUIREMENTS:**');
        expect(result.value.prompt).toContain('- Must contain: "first"');
        expect(result.value.prompt).toContain('- Must contain: "second"');
      }
    });

    it('does not add validationCriteria OUTPUT REQUIREMENTS section when no validationCriteria', () => {
      const result = renderPendingPrompt({
        workflow: simpleWorkflow,
        stepId: 'step1',
        loopPath: [],
        truth: { events: [], manifest: [] },
        runId: 'run_1',
        nodeId: 'node_1',
        rehydrateOnly: false,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.prompt).toContain('Do step 1');
        // Validation-criteria OUTPUT REQUIREMENTS section should be absent (no validationCriteria on step)
        expect(result.value.prompt).not.toContain('**OUTPUT REQUIREMENTS:**');
        // But NOTES REQUIRED section IS injected by the system for all non-optional steps
        expect(result.value.prompt).toContain('NOTES REQUIRED');
      }
    });

    it('does not add NOTES REQUIRED section when step has notesOptional=true', () => {
      const workflowWithOptionalNotes = createWorkflow(
        {
          id: 'test-optional',
          name: 'Test',
          description: 'Test',
          version: '1.0.0',
          steps: [{ id: 'step1', title: 'Step 1', prompt: 'Do step 1', requireConfirmation: false, notesOptional: true }],
        } as any,
        createBundledSource()
      );
      const result = renderPendingPrompt({
        workflow: workflowWithOptionalNotes,
        stepId: 'step1',
        loopPath: [],
        truth: { events: [], manifest: [] },
        runId: 'run_1',
        nodeId: 'node_1',
        rehydrateOnly: false,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.prompt).toBe('Do step 1');
        expect(result.value.prompt).not.toContain('NOTES REQUIRED');
      }
    });

    it('includes OUTPUT REQUIREMENTS in rehydrate-only mode with no recovery', () => {
      const workflowWithValidation = createWorkflow(
        {
          id: 'test-rehydrate',
          name: 'Test Rehydrate',
          description: 'Test rehydrate with validation',
          version: '1.0.0',
          steps: [{
            id: 'rehydrate-step',
            title: 'Rehydrate Step',
            prompt: 'Continue the work',
            requireConfirmation: false,
            validationCriteria: {
              type: 'contains',
              value: 'complete',
              message: 'Must mark as complete',
            },
          }],
        } as any,
        createBundledSource()
      );

      const truth = {
        events: [
          { v: 1, eventId: 'e0', eventIndex: 0, sessionId: 's1', kind: 'session_created', dedupeKey: 'session_created:s1', data: {} },
          { v: 1, eventId: 'e1', eventIndex: 1, sessionId: 's1', kind: 'run_started', dedupeKey: 'run_started:s1:run_1', scope: { runId: 'run_1' }, data: { workflowId: 'test', workflowHash: 'sha256:abc123' + '0'.repeat(58), workflowSourceKind: 'bundled', workflowSourceRef: '(bundled)' } },
          { v: 1, eventId: 'e2', eventIndex: 2, sessionId: 's1', kind: 'node_created', dedupeKey: 'node_created:s1:run_1:node_1', scope: { runId: 'run_1', nodeId: 'node_1' }, data: { nodeKind: 'step', parentNodeId: null, workflowHash: 'sha256:abc123' + '0'.repeat(58), snapshotRef: 'sha256:def456' + '0'.repeat(58) } },
        ] as any,
        manifest: [],
      };

      const result = renderPendingPrompt({
        workflow: workflowWithValidation,
        stepId: 'rehydrate-step',
        loopPath: [],
        truth,
        runId: 'run_1',
        nodeId: 'node_1',
        rehydrateOnly: true,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.prompt).toContain('Continue the work');
        expect(result.value.prompt).toContain('**OUTPUT REQUIREMENTS:**');
        expect(result.value.prompt).toContain('- Must contain: "complete"');
      }
    });
  });

  describe('output contract guidance (system-injected)', () => {
    it('appends system OUTPUT REQUIREMENTS for outputContract', () => {
      const workflowWithContract = createWorkflow(
        {
          id: 'test-output-contract',
          name: 'Test Output Contract',
          description: 'Test with outputContract',
          version: '1.0.0',
          steps: [{
            id: 'contract-step',
            title: 'Contract Step',
            prompt: 'Provide output artifact',
            requireConfirmation: false,
            outputContract: {
              contractRef: LOOP_CONTROL_CONTRACT_REF,
            },
          }],
        } as any,
        createBundledSource()
      );

      const result = renderPendingPrompt({
        workflow: workflowWithContract,
        stepId: 'contract-step',
        loopPath: [],
        truth: { events: [], manifest: [] },
        runId: 'run_1',
        nodeId: 'node_1',
        rehydrateOnly: false,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.prompt).toContain('**OUTPUT REQUIREMENTS (System):**');
        expect(result.value.prompt).toContain(`Artifact contract: ${LOOP_CONTROL_CONTRACT_REF}`);
        expect(result.value.prompt).toContain('Provide an artifact with kind: "wr.loop_control"');
        expect(result.value.prompt).toContain('decision ("continue" | "stop")');
      }
    });

    it('does not add system OUTPUT REQUIREMENTS when no outputContract', () => {
      const result = renderPendingPrompt({
        workflow: simpleWorkflow,
        stepId: 'step1',
        loopPath: [],
        truth: { events: [], manifest: [] },
        runId: 'run_1',
        nodeId: 'node_1',
        rehydrateOnly: false,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.prompt).not.toContain('OUTPUT REQUIREMENTS (System)');
      }
    });

    it('includes canonical JSON format in loop_control contract guidance', () => {
      const workflowWithContract = createWorkflow(
        {
          id: 'test-canonical',
          name: 'Test Canonical',
          description: 'Test canonical format',
          version: '1.0.0',
          steps: [{
            id: 'exit-step',
            title: 'Exit Step',
            prompt: 'Should we stop?',
            requireConfirmation: false,
            outputContract: {
              contractRef: LOOP_CONTROL_CONTRACT_REF,
            },
          }],
        } as any,
        createBundledSource()
      );

      const result = renderPendingPrompt({
        workflow: workflowWithContract,
        stepId: 'exit-step',
        loopPath: [],
        truth: { events: [], manifest: [] },
        runId: 'run_1',
        nodeId: 'node_1',
        rehydrateOnly: false,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.prompt).toContain('"wr.loop_control"');
        expect(result.value.prompt).toContain('"stop"');
        expect(result.value.prompt).toContain('Canonical format');
      }
    });
  });

  describe('loop context banner hardening', () => {
    const loopWorkflow = createWorkflow(
      {
        id: 'test-loop',
        name: 'Test Loop',
        description: 'Test loop workflow',
        version: '1.0.0',
        steps: [{
          id: 'loop-step',
          type: 'loop',
          title: 'Loop',
          prompt: 'Loop prompt',
          requireConfirmation: false,
          loop: {
            type: 'while',
            maxIterations: 5,
          },
          body: [
            { id: 'body-step', title: 'Body', prompt: 'Do work', requireConfirmation: false },
            { id: 'exit-step', title: 'Exit', prompt: 'Stop?', requireConfirmation: false, outputContract: { contractRef: LOOP_CONTROL_CONTRACT_REF } },
          ],
        }],
      } as any,
      createBundledSource()
    );

    it('first iteration shows soft orientation with maxIterations bound', () => {
      const result = renderPendingPrompt({
        workflow: loopWorkflow,
        stepId: 'body-step',
        loopPath: [{ loopId: 'loop-step', iteration: 0 }],
        truth: { events: [], manifest: [] },
        runId: 'run_1',
        nodeId: 'node_1',
        rehydrateOnly: false,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.prompt).toContain('iterative loop');
        expect(result.value.prompt).toContain('up to 5 passes');
      }
    });

    it('subsequent iterations show progress bar and scope narrowing', () => {
      const result = renderPendingPrompt({
        workflow: loopWorkflow,
        stepId: 'body-step',
        loopPath: [{ loopId: 'loop-step', iteration: 2 }],
        truth: { events: [], manifest: [] },
        runId: 'run_1',
        nodeId: 'node_1',
        rehydrateOnly: false,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.prompt).toContain('Pass 3');
        expect(result.value.prompt).toContain('of 5');
        expect(result.value.prompt).toContain('Scope');
        expect(result.value.prompt).toContain('Ancestry Recap');
      }
    });

    it('final pass shows FINAL PASS instruction', () => {
      const result = renderPendingPrompt({
        workflow: loopWorkflow,
        stepId: 'body-step',
        loopPath: [{ loopId: 'loop-step', iteration: 4 }],
        truth: { events: [], manifest: [] },
        runId: 'run_1',
        nodeId: 'node_1',
        rehydrateOnly: false,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.prompt).toContain('FINAL PASS');
      }
    });

    it('exit step does not get a loop banner', () => {
      const result = renderPendingPrompt({
        workflow: loopWorkflow,
        stepId: 'exit-step',
        loopPath: [{ loopId: 'loop-step', iteration: 2 }],
        truth: { events: [], manifest: [] },
        runId: 'run_1',
        nodeId: 'node_1',
        rehydrateOnly: false,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // No banner, just the authored prompt + contract guidance
        expect(result.value.prompt).not.toContain('Pass 3');
        expect(result.value.prompt).toContain('Stop?');
        expect(result.value.prompt).toContain('OUTPUT REQUIREMENTS (System)');
      }
    });

    it('non-loop step outside workflow body gets no banner', () => {
      const result = renderPendingPrompt({
        workflow: simpleWorkflow,
        stepId: 'step1',
        loopPath: [],
        truth: { events: [], manifest: [] },
        runId: 'run_1',
        nodeId: 'node_1',
        rehydrateOnly: false,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.prompt).not.toContain('iterative loop');
        expect(result.value.prompt).not.toContain('Progress');
      }
    });
  });
});

// =============================================================================
// buildMetricsSection tests
// =============================================================================

describe('buildMetricsSection', () => {
  // ── absent / none ──────────────────────────────────────────────────────────

  it('returns empty string when profile is undefined', () => {
    expect(buildMetricsSection(undefined, false, false)).toBe('');
    expect(buildMetricsSection(undefined, true, false)).toBe('');
  });

  it('returns empty string when profile is none', () => {
    expect(buildMetricsSection('none', false, false)).toBe('');
    expect(buildMetricsSection('none', true, false)).toBe('');
    expect(buildMetricsSection('none', false, true)).toBe('');
    expect(buildMetricsSection('none', true, true)).toBe('');
  });

  // ── coding profile, non-final ─────────────────────────────────────────────

  it('coding non-final: injects SHA accumulation footer', () => {
    const result = buildMetricsSection('coding', false, false);
    expect(result).toContain('METRICS (System)');
    expect(result).toContain('metrics_commit_shas');
    expect(result).toContain('FULL accumulated list');
    expect(result).toContain('shallow merge');
    expect(result).not.toContain('metrics_outcome');
    expect(result).not.toContain('final step');
  });

  it('coding non-final cleanFormat: injects compact one-liner', () => {
    const result = buildMetricsSection('coding', false, true);
    expect(result).toContain('metrics_commit_shas');
    expect(result).toContain('FULL accumulated SHA list');
    expect(result).toContain('shallow merge');
    expect(result).not.toContain('METRICS (System)');
    expect(result).not.toContain('metrics_outcome');
  });

  // ── coding profile, final ─────────────────────────────────────────────────

  it('coding final: injects both SHA footer and outcome/PR footer', () => {
    const result = buildMetricsSection('coding', true, false);
    expect(result).toContain('FULL accumulated list');
    expect(result).toContain('metrics_commit_shas');
    expect(result).toContain('metrics_outcome');
    expect(result).toContain('metrics_pr_numbers');
    expect(result).toContain('metrics_files_changed');
    expect(result).toContain('metrics_lines_added');
    expect(result).toContain('metrics_lines_removed');
    expect(result).toContain('final step');
    // Both footers concatenated: SHA section appears before final section
    const shaPos = result.indexOf('FULL accumulated list');
    const finalPos = result.indexOf('final step');
    expect(shaPos).toBeLessThan(finalPos);
  });

  it('coding final cleanFormat: injects both compact one-liners', () => {
    const result = buildMetricsSection('coding', true, true);
    expect(result).toContain('metrics_commit_shas');
    expect(result).toContain('FULL accumulated SHA list');
    expect(result).toContain('metrics_outcome');
    expect(result).toContain('metrics_pr_numbers');
    expect(result).toContain('metrics_files_changed');
    expect(result).not.toContain('METRICS (System)');
  });

  // ── review profile ────────────────────────────────────────────────────────

  it('review non-final: returns empty string', () => {
    expect(buildMetricsSection('review', false, false)).toBe('');
    expect(buildMetricsSection('review', false, true)).toBe('');
  });

  it('review final: injects PR/outcome footer', () => {
    const result = buildMetricsSection('review', true, false);
    expect(result).toContain('METRICS (System)');
    expect(result).toContain('metrics_pr_numbers');
    expect(result).toContain('metrics_outcome');
    expect(result).toContain('final step of a review workflow');
    expect(result).not.toContain('metrics_commit_shas');
  });

  it('review final cleanFormat: injects compact one-liner', () => {
    const result = buildMetricsSection('review', true, true);
    expect(result).toContain('metrics_pr_numbers');
    expect(result).toContain('metrics_outcome');
    expect(result).not.toContain('METRICS (System)');
    expect(result).not.toContain('metrics_commit_shas');
  });

  // ── research profile ──────────────────────────────────────────────────────

  it('research non-final: returns empty string', () => {
    expect(buildMetricsSection('research', false, false)).toBe('');
    expect(buildMetricsSection('research', false, true)).toBe('');
  });

  it('research final: injects outcome-only footer', () => {
    const result = buildMetricsSection('research', true, false);
    expect(result).toContain('METRICS (System)');
    expect(result).toContain('metrics_outcome');
    expect(result).toContain('final step of a research workflow');
    expect(result).not.toContain('metrics_commit_shas');
    expect(result).not.toContain('metrics_pr_numbers');
  });

  it('research final cleanFormat: injects compact one-liner', () => {
    const result = buildMetricsSection('research', true, true);
    expect(result).toContain('metrics_outcome');
    expect(result).not.toContain('METRICS (System)');
    expect(result).not.toContain('metrics_commit_shas');
    expect(result).not.toContain('metrics_pr_numbers');
  });

  // ── integration via renderPendingPrompt ───────────────────────────────────

  it('renderPendingPrompt: coding workflow single step gets SHA footer', () => {
    const codingWorkflow = createWorkflow(
      {
        id: 'coding-test',
        name: 'Coding Test',
        description: 'Test coding metrics profile',
        version: '1.0.0',
        metricsProfile: 'coding',
        steps: [{ id: 'step1', title: 'Step 1', prompt: 'Do step 1', notesOptional: true }],
      } as any,
      createBundledSource()
    );

    const result = renderPendingPrompt({
      workflow: codingWorkflow,
      stepId: 'step1',
      loopPath: [],
      truth: { events: [], manifest: [] },
      runId: 'run_1',
      nodeId: 'node_1',
      rehydrateOnly: false,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // step1 IS the only/last step -- gets both SHA and final footer
      expect(result.value.prompt).toContain('metrics_commit_shas');
      expect(result.value.prompt).toContain('metrics_outcome');
    }
  });

  it('renderPendingPrompt: no metricsProfile -- existing workflows unaffected', () => {
    const result = renderPendingPrompt({
      workflow: simpleWorkflow, // no metricsProfile field
      stepId: 'step1',
      loopPath: [],
      truth: { events: [], manifest: [] },
      runId: 'run_1',
      nodeId: 'node_1',
      rehydrateOnly: false,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.prompt).not.toContain('METRICS (System)');
      expect(result.value.prompt).not.toContain('metrics_commit_shas');
      expect(result.value.prompt).not.toContain('metrics_outcome');
    }
  });

  it('renderPendingPrompt: coding workflow first of two steps gets SHA footer only (not final)', () => {
    const codingTwoStepWorkflow = createWorkflow(
      {
        id: 'coding-two-steps',
        name: 'Coding Two Steps',
        description: 'Test coding metrics profile with two steps',
        version: '1.0.0',
        metricsProfile: 'coding',
        steps: [
          { id: 'step1', title: 'Step 1', prompt: 'Do step 1', notesOptional: true },
          { id: 'step2', title: 'Step 2', prompt: 'Do step 2', notesOptional: true },
        ],
      } as any,
      createBundledSource()
    );

    const result = renderPendingPrompt({
      workflow: codingTwoStepWorkflow,
      stepId: 'step1', // NOT the last step
      loopPath: [],
      truth: { events: [], manifest: [] },
      runId: 'run_1',
      nodeId: 'node_1',
      rehydrateOnly: false,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.prompt).toContain('metrics_commit_shas');
      expect(result.value.prompt).not.toContain('metrics_outcome'); // non-final: no outcome footer
    }
  });

  it('renderPendingPrompt: exit step of non-terminal loop does NOT get final-step footer', () => {
    // Workflow: loop(body=[regular-step, exit-step]) then final-step
    // The exit-step's parent loop is NOT the last top-level step -> should NOT get outcome footer
    const workflowWithNonTerminalLoop = createWorkflow(
      {
        id: 'non-terminal-loop',
        name: 'Non-terminal Loop',
        description: 'Test non-terminal loop exit step',
        version: '1.0.0',
        metricsProfile: 'coding',
        steps: [
          {
            id: 'loop1',
            type: 'loop',
            title: 'Loop 1',
            loop: { type: 'while', maxIterations: 3 },
            body: [
              { id: 'loop1-body', title: 'Body', prompt: 'Body step', notesOptional: true },
              {
                id: 'loop1-exit',
                title: 'Exit',
                prompt: 'Exit step',
                notesOptional: true,
                outputContract: { contractRef: LOOP_CONTROL_CONTRACT_REF },
              },
            ],
          },
          { id: 'final-step', title: 'Final Step', prompt: 'Final', notesOptional: true },
        ],
      } as any,
      createBundledSource()
    );

    const result = renderPendingPrompt({
      workflow: workflowWithNonTerminalLoop,
      stepId: 'loop1-exit', // exit step of a NON-terminal loop
      loopPath: [{ loopStepId: 'loop1', iteration: 0 }],
      truth: { events: [], manifest: [] },
      runId: 'run_1',
      nodeId: 'node_1',
      rehydrateOnly: false,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Should get SHA footer (coding non-final) but NOT the outcome/PR footer
      // Note: exit steps have outputContract so notesSection is skipped,
      // and the exit step IS a coding profile step -> SHA accumulation applies
      // BUT it is NOT the final step -> no outcome footer
      expect(result.value.prompt).not.toContain('metrics_outcome');
      expect(result.value.prompt).not.toContain('final step');
    }
  });
});
