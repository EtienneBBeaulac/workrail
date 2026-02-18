/**
 * Workspace Anchor Adapter Tests
 *
 * Tests for LocalWorkspaceAnchorV2 — the adapter that resolves git identity
 * from a WorkspaceSource variant.
 *
 * All three WorkspaceSource variants are covered:
 * - explicit_path: absolute filesystem path provided by the tool caller
 * - mcp_root_uri: file:// URI from the MCP roots protocol
 * - server_cwd: fallback to the server's process.cwd()
 *
 * These tests run against the actual git repository (this repo) for real paths,
 * and use non-git directories to verify graceful degradation.
 *
 * Lock: §DI — side effects at the edges, graceful degradation.
 */

import { describe, it, expect } from 'vitest';
import { pathToFileURL } from 'url';
import { LocalWorkspaceAnchorV2 } from '../../../src/v2/infra/local/workspace-anchor/index.js';
import type { WorkspaceSource } from '../../../src/v2/ports/workspace-anchor.port.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gitRepoSource(path: string): WorkspaceSource {
  return { kind: 'explicit_path', path };
}

function nonGitSource(path: string): WorkspaceSource {
  return { kind: 'explicit_path', path };
}

function mcpRootSource(uri: string): WorkspaceSource {
  return { kind: 'mcp_root_uri', uri };
}

const serverCwdSource: WorkspaceSource = { kind: 'server_cwd' };

// ---------------------------------------------------------------------------
// explicit_path variant
// ---------------------------------------------------------------------------

describe('explicit_path source', () => {
  it('resolves git branch and SHA from a real git repo', async () => {
    const adapter = new LocalWorkspaceAnchorV2(process.cwd());
    const result = await adapter.resolve(gitRepoSource(process.cwd()));

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const anchors = result.value;
      expect(anchors.length).toBeGreaterThanOrEqual(1);

      const branch = anchors.find((a) => a.key === 'git_branch');
      if (branch) expect(typeof branch.value).toBe('string');

      const sha = anchors.find((a) => a.key === 'git_head_sha');
      if (sha) expect(sha.value).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('returns empty anchors for a non-git directory (graceful degradation)', async () => {
    const adapter = new LocalWorkspaceAnchorV2(process.cwd());
    const result = await adapter.resolve(nonGitSource('/tmp'));

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual([]);
  });

  it('returns empty anchors for a nonexistent path (graceful degradation)', async () => {
    const adapter = new LocalWorkspaceAnchorV2(process.cwd());
    const result = await adapter.resolve(nonGitSource('/nonexistent/path/that/does/not/exist'));

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mcp_root_uri variant
// ---------------------------------------------------------------------------

describe('mcp_root_uri source', () => {
  it('resolves git identity from a file:// URI pointing to a real git repo', async () => {
    const adapter = new LocalWorkspaceAnchorV2(process.cwd());
    const uri = pathToFileURL(process.cwd()).href;
    const result = await adapter.resolve(mcpRootSource(uri));

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('returns empty anchors for a non-file:// URI (http:// etc.) — graceful, not an error', async () => {
    const adapter = new LocalWorkspaceAnchorV2(process.cwd());
    const result = await adapter.resolve(mcpRootSource('https://github.com/example/repo'));

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual([]);
  });

  it('returns empty anchors for a file:// URI pointing to a non-git directory', async () => {
    const adapter = new LocalWorkspaceAnchorV2(process.cwd());
    const result = await adapter.resolve(mcpRootSource('file:///tmp'));

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual([]);
  });

  it('returns empty anchors for a malformed URI (graceful degradation)', async () => {
    const adapter = new LocalWorkspaceAnchorV2(process.cwd());
    const result = await adapter.resolve(mcpRootSource('file:///[invalid'));

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// server_cwd variant
// ---------------------------------------------------------------------------

describe('server_cwd source', () => {
  it('resolves git identity from the server process CWD (this is a git repo)', async () => {
    const adapter = new LocalWorkspaceAnchorV2(process.cwd());
    const result = await adapter.resolve(serverCwdSource);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('returns empty anchors when defaultCwd is not a git repo', async () => {
    const adapter = new LocalWorkspaceAnchorV2('/tmp');
    const result = await adapter.resolve(serverCwdSource);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual([]);
  });
});
