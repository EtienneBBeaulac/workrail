/**
 * Observation Builder Tests
 *
 * Tests for the pure function that maps workspace anchors to observation event data.
 *
 * Lock: §1 observation_recorded — closed-set keys + tagged scalar values.
 */

import { describe, it, expect } from 'vitest';
import { anchorsToObservations } from '../../../src/v2/durable-core/domain/observation-builder.js';
import type { WorkspaceAnchor } from '../../../src/v2/ports/workspace-anchor.port.js';

describe('anchorsToObservations', () => {
  it('returns empty array for empty input', () => {
    const result = anchorsToObservations([]);
    expect(result).toEqual([]);
  });

  it('maps git_branch to short_string with high confidence', () => {
    const anchors: readonly WorkspaceAnchor[] = [
      { key: 'git_branch', value: 'feature/my-branch' },
    ];
    const result = anchorsToObservations(anchors);
    expect(result).toEqual([
      {
        key: 'git_branch',
        value: { type: 'short_string', value: 'feature/my-branch' },
        confidence: 'high',
      },
    ]);
  });

  it('maps git_head_sha to git_sha1 with high confidence', () => {
    const sha = 'a'.repeat(40);
    const anchors: readonly WorkspaceAnchor[] = [
      { key: 'git_head_sha', value: sha },
    ];
    const result = anchorsToObservations(anchors);
    expect(result).toEqual([
      {
        key: 'git_head_sha',
        value: { type: 'git_sha1', value: sha },
        confidence: 'high',
      },
    ]);
  });

  it('maps repo_root_hash to sha256 with high confidence', () => {
    const hash = `sha256:${'b'.repeat(64)}`;
    const anchors: readonly WorkspaceAnchor[] = [
      { key: 'repo_root_hash', value: hash },
    ];
    const result = anchorsToObservations(anchors);
    expect(result).toEqual([
      {
        key: 'repo_root_hash',
        value: { type: 'sha256', value: hash },
        confidence: 'high',
      },
    ]);
  });

  it('skips git_branch longer than 80 chars', () => {
    const anchors: readonly WorkspaceAnchor[] = [
      { key: 'git_branch', value: 'x'.repeat(81) },
    ];
    const result = anchorsToObservations(anchors);
    expect(result).toEqual([]);
  });

  it('accepts git_branch exactly 80 chars', () => {
    const anchors: readonly WorkspaceAnchor[] = [
      { key: 'git_branch', value: 'x'.repeat(80) },
    ];
    const result = anchorsToObservations(anchors);
    expect(result).toHaveLength(1);
    expect(result[0]!.key).toBe('git_branch');
  });

  it('skips git_head_sha with invalid format (uppercase)', () => {
    const anchors: readonly WorkspaceAnchor[] = [
      { key: 'git_head_sha', value: 'A'.repeat(40) },
    ];
    const result = anchorsToObservations(anchors);
    expect(result).toEqual([]);
  });

  it('skips git_head_sha with wrong length', () => {
    const anchors: readonly WorkspaceAnchor[] = [
      { key: 'git_head_sha', value: 'a'.repeat(39) },
    ];
    const result = anchorsToObservations(anchors);
    expect(result).toEqual([]);
  });

  it('skips repo_root_hash without sha256: prefix', () => {
    const anchors: readonly WorkspaceAnchor[] = [
      { key: 'repo_root_hash', value: 'b'.repeat(64) },
    ];
    const result = anchorsToObservations(anchors);
    expect(result).toEqual([]);
  });

  it('maps multiple anchors in order', () => {
    const anchors: readonly WorkspaceAnchor[] = [
      { key: 'git_branch', value: 'main' },
      { key: 'git_head_sha', value: 'c'.repeat(40) },
    ];
    const result = anchorsToObservations(anchors);
    expect(result).toHaveLength(2);
    expect(result[0]!.key).toBe('git_branch');
    expect(result[1]!.key).toBe('git_head_sha');
  });

  it('skips invalid anchors while keeping valid ones', () => {
    const anchors: readonly WorkspaceAnchor[] = [
      { key: 'git_branch', value: 'main' },
      { key: 'git_head_sha', value: 'INVALID' },
      { key: 'repo_root_hash', value: `sha256:${'d'.repeat(64)}` },
    ];
    const result = anchorsToObservations(anchors);
    expect(result).toHaveLength(2);
    expect(result[0]!.key).toBe('git_branch');
    expect(result[1]!.key).toBe('repo_root_hash');
  });

  it('maps repo_root to path type with high confidence', () => {
    const anchors: readonly WorkspaceAnchor[] = [
      { key: 'repo_root', value: '/Users/user/git/my-project' },
    ];
    const result = anchorsToObservations(anchors);
    expect(result).toHaveLength(1);
    expect(result[0]!.key).toBe('repo_root');
    expect(result[0]!.value).toEqual({ type: 'path', value: '/Users/user/git/my-project' });
    expect(result[0]!.confidence).toBe('high');
  });

  it('maps repo_root longer than 80 chars (path type, not silently dropped)', () => {
    // Regression: short_string type would silently drop paths > 80 chars.
    // path type supports up to 512 chars so deeply nested repos are not lost.
    const longPath = '/Users/user/' + 'deeply-nested-directory/'.repeat(3) + 'my-project';
    expect(longPath.length).toBeGreaterThan(80);
    const anchors: readonly WorkspaceAnchor[] = [
      { key: 'repo_root', value: longPath },
    ];
    const result = anchorsToObservations(anchors);
    expect(result).toHaveLength(1);
    expect(result[0]!.key).toBe('repo_root');
    expect(result[0]!.value).toEqual({ type: 'path', value: longPath });
  });

  it('skips repo_root exceeding 512 chars (MAX_OBSERVATION_PATH_LENGTH)', () => {
    const anchors: readonly WorkspaceAnchor[] = [
      { key: 'repo_root', value: '/Users/user/' + 'a'.repeat(512) },
    ];
    const result = anchorsToObservations(anchors);
    expect(result).toHaveLength(0);
  });
});
