/**
 * Workspace Anchor Adapter Tests
 *
 * Tests for the LocalWorkspaceAnchorV2 adapter that reads git identity.
 * These tests run against the actual git repository (this repo).
 *
 * Lock: §DI — side effects at the edges, graceful degradation.
 */

import { describe, it, expect } from 'vitest';
import { LocalWorkspaceAnchorV2 } from '../../../src/v2/infra/local/workspace-anchor/index.js';

describe('LocalWorkspaceAnchorV2', () => {
  it('resolves anchors from a real git directory', async () => {
    // This test runs against the actual workspace (which IS a git repo)
    const adapter = new LocalWorkspaceAnchorV2(process.cwd());
    const result = await adapter.resolveAnchors();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const anchors = result.value;
      // Should have at least a branch (we're in a git repo)
      expect(anchors.length).toBeGreaterThanOrEqual(1);

      // Check git_branch anchor exists and is a string
      const branchAnchor = anchors.find(a => a.key === 'git_branch');
      if (branchAnchor) {
        expect(typeof branchAnchor.value).toBe('string');
        expect(branchAnchor.value.length).toBeGreaterThan(0);
      }

      // Check git_head_sha anchor exists and is a 40-char hex string
      const shaAnchor = anchors.find(a => a.key === 'git_head_sha');
      if (shaAnchor) {
        expect(shaAnchor.value).toMatch(/^[0-9a-f]{40}$/);
      }
    }
  });

  it('returns empty anchors for non-git directory (graceful degradation)', async () => {
    // /tmp is not a git repo
    const adapter = new LocalWorkspaceAnchorV2('/tmp');
    const result = await adapter.resolveAnchors();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual([]);
    }
  });

  it('returns empty anchors for nonexistent directory (graceful degradation)', async () => {
    const adapter = new LocalWorkspaceAnchorV2('/nonexistent/path/that/definitely/does/not/exist');
    const result = await adapter.resolveAnchors();

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual([]);
    }
  });
});
