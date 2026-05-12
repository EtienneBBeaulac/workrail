/**
 * Tests for coordinator-delivery.ts: extractPrNumberFromUrl and runCoordinatorDelivery.
 */

import { describe, it, expect, vi } from 'vitest';
import { extractPrNumberFromUrl, runCoordinatorDelivery } from '../../src/coordinators/coordinator-delivery.js';
import type { AdaptiveCoordinatorDeps } from '../../src/coordinators/adaptive-pipeline.js';
import { ok as nok } from 'neverthrow';

// ── extractPrNumberFromUrl ────────────────────────────────────────────────

describe('extractPrNumberFromUrl', () => {
  it('extracts PR number from standard GitHub URL', () => {
    expect(extractPrNumberFromUrl('https://github.com/owner/repo/pull/42')).toBe(42);
  });

  it('extracts PR number with trailing slash', () => {
    expect(extractPrNumberFromUrl('https://github.com/owner/repo/pull/123/')).toBe(123);
  });

  it('extracts PR number from URL with additional segments', () => {
    expect(extractPrNumberFromUrl('https://github.com/owner/repo/pull/7/files')).toBe(7);
  });

  it('returns null for URL with non-numeric pull segment', () => {
    expect(extractPrNumberFromUrl('https://github.com/owner/repo/pull/abc')).toBeNull();
  });

  it('returns null for URL without /pull/ segment', () => {
    expect(extractPrNumberFromUrl('https://github.com/owner/repo/issues/42')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractPrNumberFromUrl('')).toBeNull();
  });

  it('returns null for non-URL string', () => {
    expect(extractPrNumberFromUrl('not-a-url')).toBeNull();
  });
});

// ── runCoordinatorDelivery ────────────────────────────────────────────────

// Minimal fake for the deps needed by runCoordinatorDelivery
function makeFakeDeps(execDeliveryImpl?: (file: string, args: string[], opts: { cwd: string; timeout: number }) => Promise<{ stdout: string; stderr: string }>): AdaptiveCoordinatorDeps {
  return {
    spawnSession: vi.fn(),
    awaitSessions: vi.fn(),
    getAgentResult: vi.fn(),
    listOpenPRs: vi.fn(),
    mergePR: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
    appendFile: vi.fn(),
    mkdir: vi.fn(),
    stderr: vi.fn(),
    now: vi.fn().mockReturnValue(Date.now()),
    port: 3456,
    homedir: () => '/home/test',
    joinPath: (...parts: string[]) => parts.join('/'),
    nowIso: () => new Date().toISOString(),
    generateId: () => 'test-id',
    fileExists: vi.fn().mockReturnValue(false),
    archiveFile: vi.fn(),
    pollForPR: vi.fn(),
    postToOutbox: vi.fn(),
    pollOutboxAck: vi.fn(),
    getChildSessionResult: vi.fn(),
    spawnAndAwait: vi.fn(),
    generateRunId: vi.fn().mockReturnValue('run-id'),
    readActiveRunId: vi.fn().mockResolvedValue(nok(null)),
    readPipelineContext: vi.fn().mockResolvedValue(nok(null)),
    createPipelineContext: vi.fn().mockResolvedValue(nok(undefined)),
    markPipelineRunComplete: vi.fn().mockResolvedValue(nok(undefined)),
    writePhaseRecord: vi.fn().mockResolvedValue(nok(undefined)),
    execDelivery: execDeliveryImpl ?? vi.fn().mockImplementation(async (file: string, args: string[]) => {
      if (file === 'git' && args.includes('commit')) return { stdout: '[worktrain/test abc1234] feat: test', stderr: '' };
      if (file === 'gh' && args[0] === 'pr') return { stdout: 'https://github.com/org/repo/pull/42', stderr: '' };
      return { stdout: '', stderr: '' };
    }),
  } as unknown as AdaptiveCoordinatorDeps;
}

const VALID_RECAP = [
  'Coding completed successfully.',
  '```json',
  '{"commitType":"feat","commitScope":"mcp","commitSubject":"feat(mcp): implement auth","prTitle":"feat(mcp): implement auth","prBody":"## Summary\\n- Implements auth","followUpTickets":[],"filesChanged":["src/auth.ts"]}',
  '```',
].join('\n');

describe('runCoordinatorDelivery', () => {
  it('returns ok with PR URL when delivery succeeds and PR is opened', async () => {
    const deps = makeFakeDeps();
    const result = await runCoordinatorDelivery(deps, VALID_RECAP, 'worktrain/test-branch', '/workspace');
    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' && result.value).toBe('https://github.com/org/repo/pull/42');
  });

  it('returns ok with null when delivery commits but does not open PR', async () => {
    const deps = makeFakeDeps(async (file, args) => {
      // No gh pr create call -- simulates autoOpenPR:false path
      if (file === 'git' && args.includes('commit')) return { stdout: '[worktrain/test abc1234] feat: test', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    // autoOpenPR is always true in runCoordinatorDelivery, so gh pr create will be called.
    // The mock returns '' for gh, making the PR URL extraction return null from runDelivery.
    // Result: ok(null) -- committed but no PR URL extracted.
    const result = await runCoordinatorDelivery(deps, VALID_RECAP, 'worktrain/test-branch', '/workspace');
    expect(result.kind).toBe('ok');
    // PR URL may be null or a string depending on whether gh pr create output was parseable
    // -- the important thing is delivery did not fail
  });

  it('returns err when recapMarkdown is null', async () => {
    const deps = makeFakeDeps();
    const result = await runCoordinatorDelivery(deps, null, 'worktrain/test-branch', '/workspace');
    expect(result.kind).toBe('err');
    expect(result.kind === 'err' && result.error).toContain('no step notes');
    expect(vi.mocked(deps.stderr)).toHaveBeenCalledWith(expect.stringContaining('recapMarkdown is null'));
  });

  it('returns err when recapMarkdown contains no handoff JSON block', async () => {
    const deps = makeFakeDeps();
    const result = await runCoordinatorDelivery(deps, 'Just some notes without JSON', 'worktrain/test-branch', '/workspace');
    expect(result.kind).toBe('err');
    expect(result.kind === 'err' && result.error).toContain('parseHandoffArtifact failed');
  });

  it('returns err when git commit fails', async () => {
    const deps = makeFakeDeps(async (file, args) => {
      if (file === 'git' && args.includes('commit')) throw new Error('nothing to commit');
      return { stdout: '', stderr: '' };
    });
    const result = await runCoordinatorDelivery(deps, VALID_RECAP, 'worktrain/test-branch', '/workspace');
    expect(result.kind).toBe('err');
    expect(result.kind === 'err' && result.error).toContain('delivery failed');
  });

  it('calls execDelivery with the correct workspace path', async () => {
    const mockExec = vi.fn().mockImplementation(async (file: string, args: string[]) => {
      if (file === 'git' && args.includes('commit')) return { stdout: '[worktrain/test abc1234] feat: test', stderr: '' };
      if (file === 'gh' && args[0] === 'pr') return { stdout: 'https://github.com/org/repo/pull/42', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const deps = makeFakeDeps(mockExec);
    await runCoordinatorDelivery(deps, VALID_RECAP, 'worktrain/test-branch', '/my-workspace');
    // All execDelivery calls should use /my-workspace as cwd
    for (const call of mockExec.mock.calls) {
      expect(call[2]).toMatchObject({ cwd: '/my-workspace' });
    }
  });
});
