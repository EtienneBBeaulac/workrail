/**
 * Unit tests for buildSystemPrompt() in workflow-runner.ts.
 *
 * Strategy: call buildSystemPrompt() directly with pre-constructed string
 * arguments. No fs I/O in these tests -- the loaders (loadDaemonSoul,
 * loadWorkspaceContext) are private and tested indirectly via their expected
 * outputs passed to buildSystemPrompt().
 *
 * WHY: keeping buildSystemPrompt() synchronous and pure means tests never
 * need fs mocking or temp directories. This follows the "prefer fakes over
 * mocks" principle from CLAUDE.md.
 */

import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, DAEMON_SOUL_DEFAULT } from '../../src/daemon/workflow-runner.js';
import type { WorkflowTrigger } from '../../src/daemon/workflow-runner.js';

const baseTrigger: WorkflowTrigger = {
  workflowId: 'coding-task-workflow-agentic',
  goal: 'implement OAuth refresh token rotation',
  workspacePath: '/Users/test/my-project',
};

describe('buildSystemPrompt()', () => {
  describe('base structure', () => {
    it('always contains the agent identity, tools, and execution contract', () => {
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, null);

      expect(prompt).toContain('You are WorkRail Auto');
      expect(prompt).toContain('## Your tools');
      expect(prompt).toContain('## Execution contract');
    });

    it('always contains the workspace path', () => {
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, null);

      expect(prompt).toContain('## Workspace: /Users/test/my-project');
    });

    it('injects the session state tag when provided', () => {
      const prompt = buildSystemPrompt(baseTrigger, 'some-session-state', DAEMON_SOUL_DEFAULT, null);

      expect(prompt).toContain('<workrail_session_state>some-session-state</workrail_session_state>');
    });

    it('injects empty session state tag when session state is empty', () => {
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, null);

      expect(prompt).toContain('<workrail_session_state></workrail_session_state>');
    });
  });

  describe('soul content injection (Feature 1)', () => {
    it('always includes ## Agent Rules and Philosophy section', () => {
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, null);

      expect(prompt).toContain('## Agent Rules and Philosophy');
    });

    it('injects the default soul content when provided', () => {
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, null);

      expect(prompt).toContain(DAEMON_SOUL_DEFAULT);
    });

    it('injects custom soul content when provided', () => {
      const customSoul = 'Always write TypeScript. Never use any.';
      const prompt = buildSystemPrompt(baseTrigger, '', customSoul, null);

      expect(prompt).toContain('## Agent Rules and Philosophy');
      expect(prompt).toContain(customSoul);
      expect(prompt).not.toContain(DAEMON_SOUL_DEFAULT);
    });

    it('soul section appears before the workspace line', () => {
      const customSoul = 'custom-soul-marker';
      const prompt = buildSystemPrompt(baseTrigger, '', customSoul, null);

      const soulIdx = prompt.indexOf('## Agent Rules and Philosophy');
      const workspaceIdx = prompt.indexOf('## Workspace:');

      expect(soulIdx).toBeGreaterThan(-1);
      expect(workspaceIdx).toBeGreaterThan(-1);
      expect(soulIdx).toBeLessThan(workspaceIdx);
    });
  });

  describe('workspace context injection (Feature 2)', () => {
    it('omits workspace context section when workspaceContext is null', () => {
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, null);

      expect(prompt).not.toContain('## Workspace Context');
    });

    it('includes workspace context section when workspaceContext is provided', () => {
      const context = '## Agent Rules\n- Use TypeScript strict mode';
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, context);

      expect(prompt).toContain('## Workspace Context (from AGENTS.md / CLAUDE.md)');
      expect(prompt).toContain(context);
    });

    it('workspace context section appears after the workspace line', () => {
      const context = 'workspace-context-marker';
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, context);

      const workspaceIdx = prompt.indexOf('## Workspace:');
      const contextIdx = prompt.indexOf('## Workspace Context');

      expect(workspaceIdx).toBeGreaterThan(-1);
      expect(contextIdx).toBeGreaterThan(-1);
      expect(contextIdx).toBeGreaterThan(workspaceIdx);
    });

    it('truncation notice is preserved when included in workspaceContext', () => {
      // loadWorkspaceContext() appends the notice -- buildSystemPrompt() just
      // passes it through. Test that the notice is not stripped.
      const notice = '[Workspace context truncated: combined size exceeded 32 KB limit. Some files may be missing.]';
      const contextWithNotice = `### CLAUDE.md\n${'x'.repeat(100)}\n\n${notice}`;
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, contextWithNotice);

      expect(prompt).toContain(notice);
    });
  });

  describe('reference URLs section', () => {
    it('omits reference documents section when no URLs provided', () => {
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, null);

      expect(prompt).not.toContain('## Reference documents');
    });

    it('includes reference documents section when URLs are provided', () => {
      const trigger: WorkflowTrigger = {
        ...baseTrigger,
        referenceUrls: ['https://example.com/spec.md', 'https://example.com/design.md'],
      };
      const prompt = buildSystemPrompt(trigger, '', DAEMON_SOUL_DEFAULT, null);

      expect(prompt).toContain('## Reference documents');
      expect(prompt).toContain('https://example.com/spec.md');
      expect(prompt).toContain('https://example.com/design.md');
    });

    it('reference documents section appears after workspace context', () => {
      const trigger: WorkflowTrigger = {
        ...baseTrigger,
        referenceUrls: ['https://example.com/spec.md'],
      };
      const context = 'workspace-context-marker';
      const prompt = buildSystemPrompt(trigger, '', DAEMON_SOUL_DEFAULT, context);

      const contextIdx = prompt.indexOf('## Workspace Context');
      const refsIdx = prompt.indexOf('## Reference documents');

      expect(contextIdx).toBeGreaterThan(-1);
      expect(refsIdx).toBeGreaterThan(-1);
      expect(refsIdx).toBeGreaterThan(contextIdx);
    });
  });

  describe('combined sections', () => {
    it('all sections coexist correctly: soul + workspace context + reference URLs', () => {
      const trigger: WorkflowTrigger = {
        ...baseTrigger,
        referenceUrls: ['https://example.com/spec.md'],
      };
      const customSoul = 'Follow TDD strictly.';
      const context = '### CLAUDE.md\nUse TypeScript strict mode.';
      const prompt = buildSystemPrompt(trigger, 'state-abc', customSoul, context);

      // All sections present
      expect(prompt).toContain('## Agent Rules and Philosophy');
      expect(prompt).toContain(customSoul);
      expect(prompt).toContain('## Workspace: /Users/test/my-project');
      expect(prompt).toContain('## Workspace Context (from AGENTS.md / CLAUDE.md)');
      expect(prompt).toContain(context);
      expect(prompt).toContain('## Reference documents');
      expect(prompt).toContain('https://example.com/spec.md');

      // Correct ordering: soul < workspace < workspace-context < reference-docs
      const soulIdx = prompt.indexOf('## Agent Rules and Philosophy');
      const workspaceIdx = prompt.indexOf('## Workspace:');
      const contextIdx = prompt.indexOf('## Workspace Context');
      const refsIdx = prompt.indexOf('## Reference documents');

      expect(soulIdx).toBeLessThan(workspaceIdx);
      expect(workspaceIdx).toBeLessThan(contextIdx);
      expect(contextIdx).toBeLessThan(refsIdx);
    });
  });

  describe('prior context injection (F1)', () => {
    it('injects ## Prior Context section when assembledContextSummary is a non-empty string', () => {
      const trigger: WorkflowTrigger = {
        ...baseTrigger,
        context: { assembledContextSummary: 'prior-context-marker' },
      };
      const prompt = buildSystemPrompt(trigger, '', DAEMON_SOUL_DEFAULT, null);

      expect(prompt).toContain('## Prior Context');
      expect(prompt).toContain('prior-context-marker');
    });

    it('## Prior Context appears before ## Reference documents', () => {
      const trigger: WorkflowTrigger = {
        ...baseTrigger,
        context: { assembledContextSummary: 'prior-context-marker' },
        referenceUrls: ['https://example.com/spec.md'],
      };
      const prompt = buildSystemPrompt(trigger, '', DAEMON_SOUL_DEFAULT, null);

      const priorCtxIdx = prompt.indexOf('## Prior Context');
      const refsIdx = prompt.indexOf('## Reference documents');

      expect(priorCtxIdx).toBeGreaterThan(-1);
      expect(refsIdx).toBeGreaterThan(-1);
      expect(priorCtxIdx).toBeLessThan(refsIdx);
    });

    it('omits ## Prior Context when assembledContextSummary is absent', () => {
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, null);

      expect(prompt).not.toContain('## Prior Context');
    });

    it('omits ## Prior Context when assembledContextSummary is not a string (type guard)', () => {
      const trigger: WorkflowTrigger = {
        ...baseTrigger,
        context: { assembledContextSummary: 42 },
      };
      const prompt = buildSystemPrompt(trigger, '', DAEMON_SOUL_DEFAULT, null);

      expect(prompt).not.toContain('## Prior Context');
    });
  });
});
