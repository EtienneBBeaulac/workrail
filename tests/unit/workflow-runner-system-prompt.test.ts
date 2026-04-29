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
  workflowId: 'wr.coding-task',
  goal: 'implement OAuth refresh token rotation',
  workspacePath: '/Users/test/my-project',
};

describe('buildSystemPrompt()', () => {
  describe('base structure', () => {
    it('always contains the agent identity, tools, and execution contract', () => {
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, null, baseTrigger.workspacePath);

      expect(prompt).toContain('You are WorkRail Auto');
      expect(prompt).toContain('## Your tools');
      expect(prompt).toContain('## Execution contract');
    });

    it('always contains the workspace path', () => {
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, null, baseTrigger.workspacePath);

      expect(prompt).toContain('## Workspace: /Users/test/my-project');
    });

    it('injects the session state tag when provided', () => {
      const prompt = buildSystemPrompt(baseTrigger, 'some-session-state', DAEMON_SOUL_DEFAULT, null);

      expect(prompt).toContain('<workrail_session_state>some-session-state</workrail_session_state>');
    });

    it('injects empty session state tag when session state is empty', () => {
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, null, baseTrigger.workspacePath);

      expect(prompt).toContain('<workrail_session_state></workrail_session_state>');
    });
  });

  describe('soul content injection (Feature 1)', () => {
    it('always includes ## Agent Rules and Philosophy section', () => {
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, null, baseTrigger.workspacePath);

      expect(prompt).toContain('## Agent Rules and Philosophy');
    });

    it('injects the default soul content when provided', () => {
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, null, baseTrigger.workspacePath);

      expect(prompt).toContain(DAEMON_SOUL_DEFAULT);
    });

    it('injects custom soul content when provided', () => {
      const customSoul = 'Always write TypeScript. Never use any.';
      const prompt = buildSystemPrompt(baseTrigger, '', customSoul, null, baseTrigger.workspacePath);

      expect(prompt).toContain('## Agent Rules and Philosophy');
      expect(prompt).toContain(customSoul);
      expect(prompt).not.toContain(DAEMON_SOUL_DEFAULT);
    });

    it('soul section appears before the workspace line', () => {
      const customSoul = 'custom-soul-marker';
      const prompt = buildSystemPrompt(baseTrigger, '', customSoul, null, baseTrigger.workspacePath);

      const soulIdx = prompt.indexOf('## Agent Rules and Philosophy');
      const workspaceIdx = prompt.indexOf('## Workspace:');

      expect(soulIdx).toBeGreaterThan(-1);
      expect(workspaceIdx).toBeGreaterThan(-1);
      expect(soulIdx).toBeLessThan(workspaceIdx);
    });
  });

  describe('workspace context injection (Feature 2)', () => {
    it('omits workspace context section when workspaceContext is null', () => {
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, null, baseTrigger.workspacePath);

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
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, null, baseTrigger.workspacePath);

      expect(prompt).not.toContain('## Reference documents');
    });

    it('includes reference documents section when URLs are provided', () => {
      const trigger: WorkflowTrigger = {
        ...baseTrigger,
        referenceUrls: ['https://example.com/spec.md', 'https://example.com/design.md'],
      };
      const prompt = buildSystemPrompt(trigger, '', DAEMON_SOUL_DEFAULT, null, trigger.workspacePath);

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
      const prompt = buildSystemPrompt(trigger, '', DAEMON_SOUL_DEFAULT, context, trigger.workspacePath);

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
      const prompt = buildSystemPrompt(trigger, 'state-abc', customSoul, context, trigger.workspacePath);

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

  describe('worktree session scoping (Issue #880)', () => {
    const mainCheckoutPath = '/Users/test/my-project';
    const worktreePath = '/Users/test/.workrail/worktrees/session-abc123';

    it('uses the provided path in the workspace heading (branchStrategy:none -- same path as trigger)', () => {
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, null, mainCheckoutPath);

      expect(prompt).toContain(`## Workspace: ${mainCheckoutPath}`);
    });

    it('does NOT add scope boundary when effectiveWorkspacePath equals trigger.workspacePath', () => {
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, null, mainCheckoutPath);

      expect(prompt).toContain(`## Workspace: ${mainCheckoutPath}`);
      expect(prompt).not.toContain('Worktree session scope');
    });

    it('uses worktree path in the workspace heading for a worktree session', () => {
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, null, worktreePath);

      expect(prompt).toContain(`## Workspace: ${worktreePath}`);
      expect(prompt).not.toContain(`## Workspace: ${mainCheckoutPath}`);
    });

    it('adds the worktree scope boundary note for a worktree session', () => {
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, null, worktreePath);

      expect(prompt).toContain('Worktree session scope');
      expect(prompt).toContain(worktreePath);
      expect(prompt).toContain(mainCheckoutPath);
    });

    it('scope boundary note explicitly forbids accessing the main checkout', () => {
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, null, worktreePath);

      expect(prompt).toContain(`Do not access, read, or modify the main checkout at \`${mainCheckoutPath}\``);
    });

    it('scope boundary note explicitly forbids reading planning/roadmap/backlog docs', () => {
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, null, worktreePath);

      expect(prompt).toContain('Do not read planning docs, roadmap files, or backlog files');
    });

    it('does NOT add scope boundary note when effectiveWorkspacePath equals trigger.workspacePath (none strategy)', () => {
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, null, mainCheckoutPath);

      expect(prompt).not.toContain('Worktree session scope');
    });

    it('scope boundary note appears immediately after the workspace heading', () => {
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, null, worktreePath);

      const workspaceIdx = prompt.indexOf(`## Workspace: ${worktreePath}`);
      const scopeIdx = prompt.indexOf('Worktree session scope');
      const workspaceContextIdx = prompt.indexOf('## Workspace Context');

      expect(workspaceIdx).toBeGreaterThan(-1);
      expect(scopeIdx).toBeGreaterThan(-1);
      // scope note comes after the workspace heading
      expect(scopeIdx).toBeGreaterThan(workspaceIdx);
      // if workspace context is present, scope note comes before it
      if (workspaceContextIdx !== -1) {
        expect(scopeIdx).toBeLessThan(workspaceContextIdx);
      }
    });

    it('workspace context is still injected after the scope boundary for worktree sessions', () => {
      const context = 'workspace-context-marker';
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, context, worktreePath);

      const scopeIdx = prompt.indexOf('Worktree session scope');
      const contextIdx = prompt.indexOf('## Workspace Context');

      expect(scopeIdx).toBeGreaterThan(-1);
      expect(contextIdx).toBeGreaterThan(-1);
      expect(contextIdx).toBeGreaterThan(scopeIdx);
    });
  });

  describe('prior context injection (F1)', () => {
    it('injects ## Prior Context section when assembledContextSummary is a non-empty string', () => {
      const trigger: WorkflowTrigger = {
        ...baseTrigger,
        context: { assembledContextSummary: 'prior-context-marker' },
      };
      const prompt = buildSystemPrompt(trigger, '', DAEMON_SOUL_DEFAULT, null, trigger.workspacePath);

      expect(prompt).toContain('## Prior Context');
      expect(prompt).toContain('prior-context-marker');
    });

    it('## Prior Context appears before ## Reference documents', () => {
      const trigger: WorkflowTrigger = {
        ...baseTrigger,
        context: { assembledContextSummary: 'prior-context-marker' },
        referenceUrls: ['https://example.com/spec.md'],
      };
      const prompt = buildSystemPrompt(trigger, '', DAEMON_SOUL_DEFAULT, null, trigger.workspacePath);

      const priorCtxIdx = prompt.indexOf('## Prior Context');
      const refsIdx = prompt.indexOf('## Reference documents');

      expect(priorCtxIdx).toBeGreaterThan(-1);
      expect(refsIdx).toBeGreaterThan(-1);
      expect(priorCtxIdx).toBeLessThan(refsIdx);
    });

    it('omits ## Prior Context when assembledContextSummary is absent', () => {
      const prompt = buildSystemPrompt(baseTrigger, '', DAEMON_SOUL_DEFAULT, null, baseTrigger.workspacePath);

      expect(prompt).not.toContain('## Prior Context');
    });

    it('omits ## Prior Context when assembledContextSummary is not a string (type guard)', () => {
      const trigger: WorkflowTrigger = {
        ...baseTrigger,
        context: { assembledContextSummary: 42 },
      };
      const prompt = buildSystemPrompt(trigger, '', DAEMON_SOUL_DEFAULT, null, trigger.workspacePath);

      expect(prompt).not.toContain('## Prior Context');
    });
  });
});
