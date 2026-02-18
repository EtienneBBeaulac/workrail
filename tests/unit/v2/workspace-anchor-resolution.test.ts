/**
 * Workspace Anchor Resolution Tests
 *
 * Tests for the selectWorkspaceSource pure function and resolveWorkspaceAnchors.
 *
 * selectWorkspaceSource is pure: no I/O, no side effects. It's tested directly
 * without any mocks. This is faster and more reliable than mocking a resolver.
 *
 * resolveWorkspaceAnchors is tested with a minimal fake resolver (not a mock)
 * to verify the delegation behavior and error absorption.
 *
 * Priority ladder under test:
 * 1. explicit_path  — workspacePath present in tool input
 * 2. mcp_root_uri   — primary URI from resolvedRootUris
 * 3. server_cwd     — fallback when both are absent
 *
 * Key semantic: absent inputs decide the priority, not resolution failures.
 * If workspacePath is provided but resolves to empty (non-git dir), we get
 * empty anchors — NOT a fallthrough to mcp_root_uri or server_cwd.
 */

import { describe, it, expect } from 'vitest';
import { okAsync, errAsync } from 'neverthrow';
import { selectWorkspaceSource, resolveWorkspaceAnchors } from '../../../src/mcp/handlers/v2-workspace-resolution.js';
import type { WorkspaceSource, WorkspaceAnchorError } from '../../../src/v2/ports/workspace-anchor.port.js';
import type { WorkspaceContextResolverPortV2, WorkspaceAnchor } from '../../../src/v2/ports/workspace-anchor.port.js';
import type { V2Dependencies } from '../../../src/mcp/types.js';

// ---------------------------------------------------------------------------
// selectWorkspaceSource — pure function tests (zero mocking)
// ---------------------------------------------------------------------------

describe('selectWorkspaceSource', () => {
  it('returns explicit_path when workspacePath is provided', () => {
    const source = selectWorkspaceSource('/Users/me/repo', []);
    expect(source).toEqual<WorkspaceSource>({ kind: 'explicit_path', path: '/Users/me/repo' });
  });

  it('explicit_path wins over mcp_root_uri when both are present', () => {
    const source = selectWorkspaceSource('/Users/me/repo', ['file:///other/path']);
    expect(source).toEqual<WorkspaceSource>({ kind: 'explicit_path', path: '/Users/me/repo' });
  });

  it('explicit_path wins over server_cwd when rootUris is empty', () => {
    const source = selectWorkspaceSource('/Users/me/repo', []);
    expect(source).toEqual<WorkspaceSource>({ kind: 'explicit_path', path: '/Users/me/repo' });
  });

  it('returns mcp_root_uri when workspacePath is absent but rootUris[0] is present', () => {
    const source = selectWorkspaceSource(undefined, ['file:///Users/me/repo']);
    expect(source).toEqual<WorkspaceSource>({ kind: 'mcp_root_uri', uri: 'file:///Users/me/repo' });
  });

  it('uses only the first rootUri (primary root)', () => {
    const source = selectWorkspaceSource(undefined, ['file:///first', 'file:///second']);
    expect(source).toEqual<WorkspaceSource>({ kind: 'mcp_root_uri', uri: 'file:///first' });
  });

  it('returns server_cwd when both workspacePath and rootUris are absent', () => {
    const source = selectWorkspaceSource(undefined, []);
    expect(source).toEqual<WorkspaceSource>({ kind: 'server_cwd' });
  });

  it('returns server_cwd when workspacePath is undefined and rootUris is empty array', () => {
    const source = selectWorkspaceSource(undefined, []);
    expect(source).toEqual<WorkspaceSource>({ kind: 'server_cwd' });
  });
});

// ---------------------------------------------------------------------------
// resolveWorkspaceAnchors — fake resolver tests
// ---------------------------------------------------------------------------

/** Minimal fake resolver — captures which WorkspaceSource was passed */
class FakeWorkspaceResolver implements WorkspaceContextResolverPortV2 {
  capturedSource: WorkspaceSource | null = null;
  response: readonly WorkspaceAnchor[] = [];
  shouldFail = false;

  resolve(source: WorkspaceSource) {
    this.capturedSource = source;
    if (this.shouldFail) {
      return errAsync<readonly WorkspaceAnchor[], WorkspaceAnchorError>({
        code: 'ANCHOR_RESOLVE_FAILED',
        message: 'fake failure',
      });
    }
    return okAsync(this.response);
  }
}

/** Minimal V2Dependencies with just workspaceResolver and resolvedRootUris */
function makeV2(
  resolver: WorkspaceContextResolverPortV2 | null,
  rootUris: readonly string[] = [],
): V2Dependencies {
  return {
    workspaceResolver: resolver ?? undefined,
    resolvedRootUris: [...rootUris],
  } as unknown as V2Dependencies;
}

describe('resolveWorkspaceAnchors', () => {
  it('returns empty anchors when workspaceResolver is not present', async () => {
    const result = await resolveWorkspaceAnchors(makeV2(null), '/Users/me/repo');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual([]);
  });

  it('delegates to resolver with explicit_path when workspacePath is provided', async () => {
    const fakeResolver = new FakeWorkspaceResolver();
    const anchors: readonly WorkspaceAnchor[] = [
      { key: 'git_branch', value: 'main' },
      { key: 'git_head_sha', value: 'a'.repeat(40) },
    ];
    fakeResolver.response = anchors;

    const v2 = makeV2(fakeResolver);
    const result = await resolveWorkspaceAnchors(v2, '/Users/me/repo');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual(anchors);
    expect(fakeResolver.capturedSource).toEqual<WorkspaceSource>({ kind: 'explicit_path', path: '/Users/me/repo' });
  });

  it('delegates to resolver with mcp_root_uri when workspacePath absent but rootUris present', async () => {
    const fakeResolver = new FakeWorkspaceResolver();
    fakeResolver.response = [{ key: 'git_branch', value: 'feature/x' }];

    const v2 = makeV2(fakeResolver, ['file:///Users/me/repo']);
    const result = await resolveWorkspaceAnchors(v2, undefined);

    expect(result.isOk()).toBe(true);
    expect(fakeResolver.capturedSource).toEqual<WorkspaceSource>({ kind: 'mcp_root_uri', uri: 'file:///Users/me/repo' });
  });

  it('delegates to resolver with server_cwd when both workspacePath and rootUris absent', async () => {
    const fakeResolver = new FakeWorkspaceResolver();
    fakeResolver.response = [{ key: 'git_head_sha', value: 'b'.repeat(40) }];

    const v2 = makeV2(fakeResolver, []);
    const result = await resolveWorkspaceAnchors(v2, undefined);

    expect(result.isOk()).toBe(true);
    expect(fakeResolver.capturedSource).toEqual<WorkspaceSource>({ kind: 'server_cwd' });
  });

  it('explicit_path + empty anchors is NOT a fallthrough — returns empty (absence decides, not failure)', async () => {
    const fakeResolver = new FakeWorkspaceResolver();
    fakeResolver.response = []; // empty — non-git path but not an error
    fakeResolver.shouldFail = false;

    const v2 = makeV2(fakeResolver, ['file:///other/path']); // would give mpc_root_uri
    const result = await resolveWorkspaceAnchors(v2, '/tmp'); // explicit_path wins

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual([]);
    // Must have used explicit_path, NOT fallen through to mcp_root_uri
    expect(fakeResolver.capturedSource).toEqual<WorkspaceSource>({ kind: 'explicit_path', path: '/tmp' });
  });

  it('absorbs resolver errors — returns empty anchors, never propagates', async () => {
    const fakeResolver = new FakeWorkspaceResolver();
    fakeResolver.shouldFail = true;

    const v2 = makeV2(fakeResolver);
    const result = await resolveWorkspaceAnchors(v2, '/Users/me/repo');

    // Error must be absorbed — result is still Ok([])
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual([]);
  });
});
