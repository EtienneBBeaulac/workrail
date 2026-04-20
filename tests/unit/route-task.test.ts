/**
 * Unit tests for src/coordinators/routing/route-task.ts
 *
 * Tests routeTask() pure function for all 4 routing rules and edge cases.
 * All tests use an injectable fileExists fake -- no filesystem access.
 */

import { describe, it, expect } from 'vitest';
import {
  routeTask,
  extractPrNumbers,
  type PipelineMode,
} from '../../src/coordinators/routing/route-task.js';

// ─── Fake deps ───────────────────────────────────────────────────────────────

const noPitch = { fileExists: (_path: string) => false };
const hasPitch = { fileExists: (_path: string) => true };

// ═══════════════════════════════════════════════════════════════════════════
// extractPrNumbers -- pure helper
// ═══════════════════════════════════════════════════════════════════════════

describe('extractPrNumbers', () => {
  it('extracts PR #N reference', () => {
    expect(extractPrNumbers('Review PR #123')).toEqual([123]);
  });

  it('extracts PR#N (no space) reference', () => {
    expect(extractPrNumbers('Review PR#456')).toEqual([456]);
  });

  it('extracts MR !N reference (GitLab-style)', () => {
    expect(extractPrNumbers('Review MR !789')).toEqual([789]);
  });

  it('extracts MR #N reference', () => {
    expect(extractPrNumbers('Review MR #321')).toEqual([321]);
  });

  it('extracts multiple PR references', () => {
    expect(extractPrNumbers('Review PR #1 and PR #2')).toEqual([1, 2]);
  });

  it('returns empty array for no PR references', () => {
    expect(extractPrNumbers('Refactor auth code')).toEqual([]);
  });

  it('does NOT match bare ticket numbers like #123', () => {
    // "Fix issue #42" -- bare hash is not a PR reference
    expect(extractPrNumbers('Fix issue #42')).toEqual([]);
  });

  it('does NOT match APPROVE or similar words with numbers', () => {
    expect(extractPrNumbers('APPROVE #5 findings from QA')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// routeTask -- Rule 1: QUICK_REVIEW
// ═══════════════════════════════════════════════════════════════════════════

describe('routeTask - Rule 1: QUICK_REVIEW', () => {
  it('routes dep-bump keyword + PR number to QUICK_REVIEW', () => {
    const mode = routeTask('bump lodash from 4.17.20 to 4.17.21 -- Review PR #99', '/workspace', noPitch);
    expect(mode.kind).toBe('QUICK_REVIEW');
    if (mode.kind === 'QUICK_REVIEW') {
      expect(mode.prNumbers).toContain(99);
    }
  });

  it('routes chore: prefix + PR number to QUICK_REVIEW', () => {
    const mode = routeTask('chore: update deps -- Review PR #42', '/workspace', noPitch);
    expect(mode.kind).toBe('QUICK_REVIEW');
  });

  it('routes dependabot keyword + PR number to QUICK_REVIEW', () => {
    const mode = routeTask('Dependabot: security update -- Review PR #10', '/workspace', noPitch);
    expect(mode.kind).toBe('QUICK_REVIEW');
  });

  it('routes "dependency upgrade" phrase + PR number to QUICK_REVIEW', () => {
    const mode = routeTask('dependency upgrade for axios -- Review PR #55', '/workspace', noPitch);
    expect(mode.kind).toBe('QUICK_REVIEW');
  });

  it('dep-bump WITHOUT PR number does NOT route to QUICK_REVIEW', () => {
    // No PR number -> falls to Rule 3 or Rule 4
    const mode = routeTask('bump lodash from 4.17.20 to 4.17.21', '/workspace', noPitch);
    expect(mode.kind).not.toBe('QUICK_REVIEW');
    expect(mode.kind).toBe('FULL'); // no pitch either
  });

  it('dep-bump + PR number takes priority over IMPLEMENT even if pitch.md exists', () => {
    const mode = routeTask('bump lodash -- Review PR #99', '/workspace', hasPitch);
    expect(mode.kind).toBe('QUICK_REVIEW');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// routeTask -- Rule 2: REVIEW_ONLY
// ═══════════════════════════════════════════════════════════════════════════

describe('routeTask - Rule 2: REVIEW_ONLY', () => {
  it('routes goal with PR #N reference to REVIEW_ONLY', () => {
    const mode = routeTask('Review PR #123 before merge', '/workspace', noPitch);
    expect(mode.kind).toBe('REVIEW_ONLY');
    if (mode.kind === 'REVIEW_ONLY') {
      expect(mode.prNumbers).toContain(123);
    }
  });

  it('routes goal with MR !456 reference to REVIEW_ONLY', () => {
    const mode = routeTask('Review MR !456 for security', '/workspace', noPitch);
    expect(mode.kind).toBe('REVIEW_ONLY');
  });

  it('routes github_prs_poll trigger provider to REVIEW_ONLY with empty prNumbers', () => {
    const mode = routeTask('Review open PRs', '/workspace', noPitch, 'github_prs_poll');
    expect(mode.kind).toBe('REVIEW_ONLY');
    if (mode.kind === 'REVIEW_ONLY') {
      expect(mode.prNumbers).toEqual([]);
    }
  });

  it('REVIEW_ONLY takes priority over IMPLEMENT when pitch.md exists', () => {
    const mode = routeTask('Review PR #123', '/workspace', hasPitch);
    expect(mode.kind).toBe('REVIEW_ONLY');
  });

  // False positive tests
  it('does NOT route bare ticket number to REVIEW_ONLY', () => {
    // "Fix bug #42" -- bare hash must NOT match PR reference
    const mode = routeTask('Fix bug #42 in the auth module', '/workspace', noPitch);
    expect(mode.kind).toBe('FULL');
  });

  it('does NOT route "issue #123" to REVIEW_ONLY', () => {
    const mode = routeTask('Implement the fix for issue #123', '/workspace', noPitch);
    expect(mode.kind).toBe('FULL');
  });

  it('does NOT route random hash number like "report has 3 PRs" to REVIEW_ONLY', () => {
    // "report has 3 PRs" - "3 PRs" != "PR #N"
    const mode = routeTask('the report has 3 PRs in scope', '/workspace', noPitch);
    expect(mode.kind).toBe('FULL');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// routeTask -- Rule 3: IMPLEMENT
// ═══════════════════════════════════════════════════════════════════════════

describe('routeTask - Rule 3: IMPLEMENT', () => {
  it('routes to IMPLEMENT when pitch.md exists', () => {
    const mode = routeTask('Implement the auth feature', '/workspace', hasPitch);
    expect(mode.kind).toBe('IMPLEMENT');
    if (mode.kind === 'IMPLEMENT') {
      expect(mode.pitchPath).toContain('current-pitch.md');
    }
  });

  it('pitchPath contains the workspace path', () => {
    const mode = routeTask('Some task', '/my/workspace', hasPitch);
    expect(mode.kind).toBe('IMPLEMENT');
    if (mode.kind === 'IMPLEMENT') {
      expect(mode.pitchPath).toContain('/my/workspace');
    }
  });

  it('pitchPath contains .workrail/current-pitch.md', () => {
    const mode = routeTask('Some task', '/workspace', hasPitch);
    expect(mode.kind).toBe('IMPLEMENT');
    if (mode.kind === 'IMPLEMENT') {
      expect(mode.pitchPath).toContain('.workrail/current-pitch.md');
    }
  });

  it('does NOT route to IMPLEMENT when fileExists returns false', () => {
    const mode = routeTask('Some task', '/workspace', noPitch);
    expect(mode.kind).toBe('FULL');
  });

  it('fileExists is called with the correct path', () => {
    const calledPaths: string[] = [];
    const trackingDeps = {
      fileExists: (path: string) => {
        calledPaths.push(path);
        return false;
      },
    };
    routeTask('Some task', '/my/workspace', trackingDeps);
    expect(calledPaths.length).toBeGreaterThan(0);
    expect(calledPaths[0]).toContain('/my/workspace');
    expect(calledPaths[0]).toContain('.workrail/current-pitch.md');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// routeTask -- Rule 4: FULL (default)
// ═══════════════════════════════════════════════════════════════════════════

describe('routeTask - Rule 4: FULL (default)', () => {
  it('routes to FULL when no signals match', () => {
    const mode = routeTask('Implement OAuth refresh token rotation', '/workspace', noPitch);
    expect(mode.kind).toBe('FULL');
    if (mode.kind === 'FULL') {
      expect(mode.goal).toBe('Implement OAuth refresh token rotation');
    }
  });

  it('routes to FULL for generic implementation goal', () => {
    const mode = routeTask('Add pagination to the search results', '/workspace', noPitch);
    expect(mode.kind).toBe('FULL');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Priority ordering
// ═══════════════════════════════════════════════════════════════════════════

describe('routeTask - priority ordering', () => {
  it('Rule 1 wins over Rule 2 (dep-bump + PR beats plain PR reference)', () => {
    const mode = routeTask('chore: bump dep -- Review PR #1', '/workspace', noPitch);
    expect(mode.kind).toBe('QUICK_REVIEW');
  });

  it('Rule 1 wins over Rule 3 (dep-bump + PR beats pitch.md)', () => {
    const mode = routeTask('bump dep -- Review PR #1', '/workspace', hasPitch);
    expect(mode.kind).toBe('QUICK_REVIEW');
  });

  it('Rule 2 wins over Rule 3 (PR reference beats pitch.md)', () => {
    const mode = routeTask('Review PR #123', '/workspace', hasPitch);
    expect(mode.kind).toBe('REVIEW_ONLY');
  });

  it('Rule 3 wins over Rule 4 (pitch.md beats default)', () => {
    const mode = routeTask('Some vague task', '/workspace', hasPitch);
    expect(mode.kind).toBe('IMPLEMENT');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Stale pitch edge case
// ═══════════════════════════════════════════════════════════════════════════

describe('routeTask - stale pitch edge cases', () => {
  it('routes to IMPLEMENT even when goal mentions "bump" but no PR number (stale pitch wins over Rule 1 partial)', () => {
    // dep-bump keyword present BUT no PR number -> Rule 1 does not apply
    // pitch.md exists -> Rule 3 applies
    const mode = routeTask('bump lodash', '/workspace', hasPitch);
    expect(mode.kind).toBe('IMPLEMENT');
  });

  it('routes to FULL when pitch.md gone after previous IMPLEMENT archival', () => {
    const mode = routeTask('Continue implementing auth feature', '/workspace', noPitch);
    expect(mode.kind).toBe('FULL');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Workspace path normalization
// ═══════════════════════════════════════════════════════════════════════════

describe('routeTask - workspace path normalization', () => {
  it('handles workspace path with trailing slash', () => {
    const calledPaths: string[] = [];
    const trackingDeps = {
      fileExists: (path: string) => {
        calledPaths.push(path);
        return false;
      },
    };
    routeTask('Some task', '/my/workspace/', trackingDeps);
    // Should not produce double slashes in the pitch path
    expect(calledPaths[0]).not.toContain('//');
  });
});
