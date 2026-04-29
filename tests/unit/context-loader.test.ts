/**
 * Unit tests for DefaultContextLoader in src/daemon/context-loader.ts.
 *
 * Strategy: inject vi.fn() fakes for the three loader functions and a stub
 * V2ToolContext. This follows the "prefer fakes over mocks" principle and
 * validates the concurrency boundary, wrapping logic, and passthrough behaviour
 * without any I/O or real WorkRail session state.
 *
 * WHY vi.fn() here (not a class fake): the injected loaders are plain async
 * functions, not objects. vi.fn() fakes are the minimal viable substitute.
 */

import { describe, it, expect, vi } from 'vitest';
import { DefaultContextLoader } from '../../src/daemon/context-loader.js';
import type { WorkflowTrigger } from '../../src/daemon/workflow-runner.js';
import type { V2ToolContext } from '../../src/mcp/types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const FAKE_CTX = {} as V2ToolContext;

const FAKE_TRIGGER: WorkflowTrigger = {
  workflowId: 'wr.test',
  goal: 'test goal',
  workspacePath: '/workspace',
};

const FAKE_TRIGGER_WITH_SOUL: WorkflowTrigger = {
  ...FAKE_TRIGGER,
  soulFile: '/custom/soul.md',
};

// ---------------------------------------------------------------------------
// loadBase() tests
// ---------------------------------------------------------------------------

describe('DefaultContextLoader.loadBase()', () => {
  it('calls loadSoul with trigger.soulFile and loadWorkspace with trigger.workspacePath', async () => {
    const loadSoul = vi.fn().mockResolvedValue('soul content');
    const loadWorkspace = vi.fn().mockResolvedValue('workspace rules');
    const loadNotes = vi.fn();

    const loader = new DefaultContextLoader(loadSoul, loadWorkspace, loadNotes, FAKE_CTX);
    await loader.loadBase(FAKE_TRIGGER_WITH_SOUL);

    expect(loadSoul).toHaveBeenCalledOnce();
    expect(loadSoul).toHaveBeenCalledWith(FAKE_TRIGGER_WITH_SOUL.soulFile);

    expect(loadWorkspace).toHaveBeenCalledOnce();
    expect(loadWorkspace).toHaveBeenCalledWith(FAKE_TRIGGER_WITH_SOUL.workspacePath);
  });

  it('runs soul and workspace loads concurrently (both called before either resolves)', async () => {
    const callOrder: string[] = [];
    let resolveSoul!: (v: string) => void;
    let resolveWorkspace!: (v: string | null) => void;

    // Both promises are created synchronously. We track call order to confirm
    // both fns were invoked before either deferred promise settles.
    const loadSoul = vi.fn().mockImplementation(() => {
      callOrder.push('soul-called');
      return new Promise<string>((res) => { resolveSoul = res; });
    });
    const loadWorkspace = vi.fn().mockImplementation(() => {
      callOrder.push('workspace-called');
      return new Promise<string | null>((res) => { resolveWorkspace = res; });
    });
    const loadNotes = vi.fn();

    const loader = new DefaultContextLoader(loadSoul, loadWorkspace, loadNotes, FAKE_CTX);
    const promise = loader.loadBase(FAKE_TRIGGER);

    // At this point both fns have been called but neither has resolved yet.
    expect(callOrder).toEqual(['soul-called', 'workspace-called']);

    // Now resolve both so the test can complete.
    resolveSoul('soul');
    resolveWorkspace('workspace');
    await promise;
  });

  it('wraps a non-null workspace string as a single ContextRule', async () => {
    const workspaceContent = 'do not do X; always do Y';
    const loadSoul = vi.fn().mockResolvedValue('soul');
    const loadWorkspace = vi.fn().mockResolvedValue(workspaceContent);
    const loadNotes = vi.fn();

    const loader = new DefaultContextLoader(loadSoul, loadWorkspace, loadNotes, FAKE_CTX);
    const base = await loader.loadBase(FAKE_TRIGGER);

    expect(base.workspaceRules).toHaveLength(1);
    expect(base.workspaceRules[0]).toEqual({
      source: 'workspace-context',
      content: workspaceContent,
      truncated: false,
    });
  });

  it('returns empty workspaceRules when workspace loader returns null', async () => {
    const loadSoul = vi.fn().mockResolvedValue('soul');
    const loadWorkspace = vi.fn().mockResolvedValue(null);
    const loadNotes = vi.fn();

    const loader = new DefaultContextLoader(loadSoul, loadWorkspace, loadNotes, FAKE_CTX);
    const base = await loader.loadBase(FAKE_TRIGGER);

    expect(base.workspaceRules).toEqual([]);
  });

  it('forwards soulContent from loadSoul into BaseContext', async () => {
    const expectedSoul = 'you are a helpful daemon soul';
    const loadSoul = vi.fn().mockResolvedValue(expectedSoul);
    const loadWorkspace = vi.fn().mockResolvedValue(null);
    const loadNotes = vi.fn();

    const loader = new DefaultContextLoader(loadSoul, loadWorkspace, loadNotes, FAKE_CTX);
    const base = await loader.loadBase(FAKE_TRIGGER);

    expect(base.soulContent).toBe(expectedSoul);
  });

  it('uses trigger.workspacePath (not any worktree path) for the workspace loader', async () => {
    const loadSoul = vi.fn().mockResolvedValue('soul');
    const loadWorkspace = vi.fn().mockResolvedValue(null);
    const loadNotes = vi.fn();

    const triggerWithExplicitPath: WorkflowTrigger = {
      ...FAKE_TRIGGER,
      workspacePath: '/main/checkout/path',
    };

    const loader = new DefaultContextLoader(loadSoul, loadWorkspace, loadNotes, FAKE_CTX);
    await loader.loadBase(triggerWithExplicitPath);

    expect(loadWorkspace).toHaveBeenCalledWith('/main/checkout/path');
  });
});

// ---------------------------------------------------------------------------
// loadSession() tests
// ---------------------------------------------------------------------------

describe('DefaultContextLoader.loadSession()', () => {
  const BASE: import('../../src/daemon/context-loader.js').BaseContext = {
    soulContent: 'soul content',
    workspaceRules: [{ source: 'workspace-context', content: 'rules', truncated: false }],
  };

  it('returns empty sessionHistory and does NOT call loadNotes when continueToken is null', async () => {
    const loadSoul = vi.fn();
    const loadWorkspace = vi.fn();
    const loadNotes = vi.fn();

    const loader = new DefaultContextLoader(loadSoul, loadWorkspace, loadNotes, FAKE_CTX);
    const bundle = await loader.loadSession(null, BASE);

    expect(loadNotes).not.toHaveBeenCalled();
    expect(bundle.sessionHistory).toEqual([]);
  });

  it('calls loadNotes with the continueToken and the injected V2ToolContext', async () => {
    const loadSoul = vi.fn();
    const loadWorkspace = vi.fn();
    const loadNotes = vi.fn().mockResolvedValue([]);
    const ctx = { marker: 'real-ctx' } as unknown as V2ToolContext;

    const loader = new DefaultContextLoader(loadSoul, loadWorkspace, loadNotes, ctx);
    await loader.loadSession('ct_abc123', BASE);

    expect(loadNotes).toHaveBeenCalledOnce();
    expect(loadNotes).toHaveBeenCalledWith('ct_abc123', ctx);
  });

  it('wraps each string from loadNotes as a SessionNote with empty nodeId and stepId', async () => {
    const rawNotes = ['step 1 output', 'step 2 output', 'step 3 output'];
    const loadSoul = vi.fn();
    const loadWorkspace = vi.fn();
    const loadNotes = vi.fn().mockResolvedValue(rawNotes);

    const loader = new DefaultContextLoader(loadSoul, loadWorkspace, loadNotes, FAKE_CTX);
    const bundle = await loader.loadSession('ct_token', BASE);

    expect(bundle.sessionHistory).toHaveLength(3);
    for (let i = 0; i < rawNotes.length; i++) {
      expect(bundle.sessionHistory[i]).toEqual({
        nodeId: '',
        stepId: '',
        content: rawNotes[i],
      });
    }
  });

  it('preserves soulContent and workspaceRules from the base context', async () => {
    const loadSoul = vi.fn();
    const loadWorkspace = vi.fn();
    const loadNotes = vi.fn().mockResolvedValue(['note']);

    const loader = new DefaultContextLoader(loadSoul, loadWorkspace, loadNotes, FAKE_CTX);
    const bundle = await loader.loadSession('ct_token', BASE);

    expect(bundle.soulContent).toBe(BASE.soulContent);
    expect(bundle.workspaceRules).toBe(BASE.workspaceRules);
  });

  it('preserves base fields even when continueToken is null', async () => {
    const loadSoul = vi.fn();
    const loadWorkspace = vi.fn();
    const loadNotes = vi.fn();

    const loader = new DefaultContextLoader(loadSoul, loadWorkspace, loadNotes, FAKE_CTX);
    const bundle = await loader.loadSession(null, BASE);

    expect(bundle.soulContent).toBe(BASE.soulContent);
    expect(bundle.workspaceRules).toBe(BASE.workspaceRules);
  });

  it('propagates exceptions thrown by loadNotes (does not swallow)', async () => {
    const loadSoul = vi.fn();
    const loadWorkspace = vi.fn();
    const error = new Error('loadNotes exploded');
    const loadNotes = vi.fn().mockRejectedValue(error);

    const loader = new DefaultContextLoader(loadSoul, loadWorkspace, loadNotes, FAKE_CTX);

    await expect(loader.loadSession('ct_token', BASE)).rejects.toThrow('loadNotes exploded');
  });
});
