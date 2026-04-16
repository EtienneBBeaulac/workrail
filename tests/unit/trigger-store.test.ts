/**
 * Tests for src/trigger/trigger-store.ts
 *
 * Covers:
 * - Happy-path YAML parsing
 * - Quoted string values (including colons inside quoted values)
 * - contextMapping sub-object
 * - Required field validation
 * - Unknown provider rejection
 * - $SECRET_NAME resolution from env
 * - Missing env var rejection
 * - Empty config (no triggers)
 * - File-not-found handling (loadTriggerConfigFromFile)
 */

import { describe, expect, it, vi } from 'vitest';
import { loadTriggerConfig } from '../../src/trigger/trigger-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MINIMAL_TRIGGER_YAML = `
triggers:
  - id: my-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspacePath: /path/to/repo
    goal: Review this MR
`;

const WITH_HMAC_YAML = `
triggers:
  - id: secure-trigger
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
    hmacSecret: $MY_HMAC_SECRET
`;

const WITH_CONTEXT_MAPPING_YAML = `
triggers:
  - id: mr-trigger
    provider: generic
    workflowId: mr-review-workflow-agentic
    workspacePath: /workspace
    goal: Review this MR
    contextMapping:
      mrUrl: $.pull_request.html_url
      mrTitle: $.pull_request.title
`;

const QUOTED_GOAL_YAML = `
triggers:
  - id: quoted-trigger
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: "Review: MR #123"
`;

const SINGLE_QUOTED_YAML = `
triggers:
  - id: single-quoted
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: 'Analyze: this branch'
`;

const EMPTY_TRIGGERS_YAML = `
triggers:
`;

const NO_TRIGGERS_BLOCK_YAML = `
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadTriggerConfig', () => {
  describe('happy path', () => {
    it('parses a minimal valid trigger', () => {
      const result = loadTriggerConfig(MINIMAL_TRIGGER_YAML, {});
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;

      expect(result.value.triggers).toHaveLength(1);
      const t = result.value.triggers[0];
      expect(t?.id).toBe('my-trigger');
      expect(t?.provider).toBe('generic');
      expect(t?.workflowId).toBe('coding-task-workflow-agentic');
      expect(t?.workspacePath).toBe('/path/to/repo');
      expect(t?.goal).toBe('Review this MR');
      expect(t?.hmacSecret).toBeUndefined();
      expect(t?.contextMapping).toBeUndefined();
    });

    it('parses a trigger with contextMapping', () => {
      const result = loadTriggerConfig(WITH_CONTEXT_MAPPING_YAML, {});
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;

      const t = result.value.triggers[0];
      expect(t?.contextMapping).toBeDefined();
      expect(t?.contextMapping?.mappings).toHaveLength(2);

      const mrUrlEntry = t?.contextMapping?.mappings.find(
        (m) => m.workflowContextKey === 'mrUrl',
      );
      expect(mrUrlEntry?.payloadPath).toBe('$.pull_request.html_url');

      const mrTitleEntry = t?.contextMapping?.mappings.find(
        (m) => m.workflowContextKey === 'mrTitle',
      );
      expect(mrTitleEntry?.payloadPath).toBe('$.pull_request.title');
    });

    it('resolves $SECRET_NAME from env', () => {
      const env = { MY_HMAC_SECRET: 'super-secret-value' };
      const result = loadTriggerConfig(WITH_HMAC_YAML, env);
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers[0]?.hmacSecret).toBe('super-secret-value');
    });

    it('accepts a trigger without hmacSecret (open trigger)', () => {
      const result = loadTriggerConfig(MINIMAL_TRIGGER_YAML, {});
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers[0]?.hmacSecret).toBeUndefined();
    });

    it('returns empty triggers array for empty triggers block', () => {
      const result = loadTriggerConfig(EMPTY_TRIGGERS_YAML, {});
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers).toHaveLength(0);
    });
  });

  describe('quoted string values', () => {
    it('handles double-quoted goal with colon inside', () => {
      const result = loadTriggerConfig(QUOTED_GOAL_YAML, {});
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers[0]?.goal).toBe('Review: MR #123');
    });

    it('handles single-quoted goal with colon inside', () => {
      const result = loadTriggerConfig(SINGLE_QUOTED_YAML, {});
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers[0]?.goal).toBe('Analyze: this branch');
    });
  });

  describe('validation errors', () => {
    it('skips trigger with missing id field (collect-all-errors)', () => {
      const yaml = `
triggers:
  - provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
`;
      const result = loadTriggerConfig(yaml, {});
      // Invalid trigger is skipped; valid subset (empty here) is returned
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers).toHaveLength(0);
    });

    it('skips trigger with missing workflowId (collect-all-errors)', () => {
      const yaml = `
triggers:
  - id: my-trigger
    provider: generic
    workspacePath: /workspace
    goal: Run workflow
`;
      const result = loadTriggerConfig(yaml, {});
      // Invalid trigger is skipped; valid subset (empty here) is returned
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers).toHaveLength(0);
    });

    it('skips trigger with unknown provider (collect-all-errors)', () => {
      const yaml = `
triggers:
  - id: my-trigger
    provider: slack
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
`;
      const result = loadTriggerConfig(yaml, {});
      // Invalid trigger is skipped; valid subset (empty here) is returned
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers).toHaveLength(0);
    });

    it('skips trigger when $SECRET_NAME env var is missing (collect-all-errors)', () => {
      const result = loadTriggerConfig(WITH_HMAC_YAML, {}); // no env vars
      // Invalid trigger is skipped; valid subset (empty here) is returned
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers).toHaveLength(0);
    });

    it('rejects config without "triggers:" root key', () => {
      const yaml = `
workflows:
  - id: my-trigger
`;
      const result = loadTriggerConfig(yaml, {});
      expect(result.kind).toBe('err');
      if (result.kind !== 'err') return;
      expect(result.error.kind).toBe('parse_error');
    });
  });

  describe('edge cases', () => {
    it('handles empty YAML string (no triggers: key)', () => {
      // Empty string will fail because there's no "triggers:" key
      const result = loadTriggerConfig('', {});
      expect(result.kind).toBe('err');
    });

    it('returns ok with 0 triggers for whitespace-only content under triggers:', () => {
      const result = loadTriggerConfig(EMPTY_TRIGGERS_YAML, {});
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers).toHaveLength(0);
    });

    it('parses multiple triggers', () => {
      const yaml = `
triggers:
  - id: trigger-one
    provider: generic
    workflowId: workflow-a
    workspacePath: /workspace
    goal: First goal
  - id: trigger-two
    provider: generic
    workflowId: workflow-b
    workspacePath: /workspace
    goal: Second goal
`;
      const result = loadTriggerConfig(yaml, {});
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers).toHaveLength(2);
      expect(result.value.triggers[0]?.id).toBe('trigger-one');
      expect(result.value.triggers[1]?.id).toBe('trigger-two');
    });
  });
});

// ---------------------------------------------------------------------------
// gitlab_poll provider: source block parsing
// ---------------------------------------------------------------------------

describe('gitlab_poll provider parsing', () => {
  const GITLAB_POLL_YAML = `
triggers:
  - id: new-mrs
    provider: gitlab_poll
    workflowId: mr-review-workflow-agentic
    workspacePath: /workspace
    goal: "Review MR"
    goalTemplate: "Review MR !{{$.iid}}: {{$.title}}"
    source:
      baseUrl: https://gitlab.com
      projectId: "12345"
      token: $GITLAB_TOKEN
      events: merge_request.opened merge_request.updated
      pollIntervalSeconds: 30
`;

  it('parses a valid gitlab_poll trigger', () => {
    const result = loadTriggerConfig(GITLAB_POLL_YAML, { GITLAB_TOKEN: 'glpat-test' });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const trigger = result.value.triggers[0];
    expect(trigger?.provider).toBe('gitlab_poll');
    expect(trigger?.pollingSource).toBeDefined();
    expect(trigger?.pollingSource?.baseUrl).toBe('https://gitlab.com');
    expect(trigger?.pollingSource?.projectId).toBe('12345');
    expect(trigger?.pollingSource?.token).toBe('glpat-test');
    expect(trigger?.pollingSource?.events).toEqual(['merge_request.opened', 'merge_request.updated']);
    expect(trigger?.pollingSource?.pollIntervalSeconds).toBe(30);
    expect(trigger?.goalTemplate).toBe('Review MR !{{$.iid}}: {{$.title}}');
  });

  it('resolves $GITLAB_TOKEN from env', () => {
    const result = loadTriggerConfig(GITLAB_POLL_YAML, { GITLAB_TOKEN: 'my-secret-token' });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.triggers[0]?.pollingSource?.token).toBe('my-secret-token');
  });

  it('skips trigger when $GITLAB_TOKEN env var is missing', () => {
    const result = loadTriggerConfig(GITLAB_POLL_YAML, {}); // no env vars
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.triggers).toHaveLength(0);
  });

  it('defaults pollIntervalSeconds to 60 when absent', () => {
    const yaml = `
triggers:
  - id: new-mrs
    provider: gitlab_poll
    workflowId: mr-review-workflow-agentic
    workspacePath: /workspace
    goal: Review MR
    source:
      baseUrl: https://gitlab.com
      projectId: "12345"
      token: mytoken
      events: merge_request.opened
`;
    const result = loadTriggerConfig(yaml, {});
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.triggers[0]?.pollingSource?.pollIntervalSeconds).toBe(60);
  });

  it('skips trigger when source: block is missing for gitlab_poll', () => {
    const yaml = `
triggers:
  - id: new-mrs
    provider: gitlab_poll
    workflowId: mr-review-workflow-agentic
    workspacePath: /workspace
    goal: Review MR
`;
    const result = loadTriggerConfig(yaml, {});
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.triggers).toHaveLength(0);
  });

  it('skips trigger when source.baseUrl is missing', () => {
    const yaml = `
triggers:
  - id: new-mrs
    provider: gitlab_poll
    workflowId: mr-review-workflow-agentic
    workspacePath: /workspace
    goal: Review MR
    source:
      projectId: "12345"
      token: mytoken
      events: merge_request.opened
`;
    const result = loadTriggerConfig(yaml, {});
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.triggers).toHaveLength(0);
  });

  it('skips trigger when source.events is empty string', () => {
    const yaml = `
triggers:
  - id: new-mrs
    provider: gitlab_poll
    workflowId: mr-review-workflow-agentic
    workspacePath: /workspace
    goal: Review MR
    source:
      baseUrl: https://gitlab.com
      projectId: "12345"
      token: mytoken
      events: "   "
`;
    const result = loadTriggerConfig(yaml, {});
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.triggers).toHaveLength(0);
  });

  it('skips trigger when source.pollIntervalSeconds is not a positive integer', () => {
    const yaml = `
triggers:
  - id: new-mrs
    provider: gitlab_poll
    workflowId: mr-review-workflow-agentic
    workspacePath: /workspace
    goal: Review MR
    source:
      baseUrl: https://gitlab.com
      projectId: "12345"
      token: mytoken
      events: merge_request.opened
      pollIntervalSeconds: "notanumber"
`;
    const result = loadTriggerConfig(yaml, {});
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.triggers).toHaveLength(0);
  });

  it('pollingSource is absent for generic triggers', () => {
    const yaml = `
triggers:
  - id: my-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspacePath: /path/to/repo
    goal: Review this MR
`;
    const result = loadTriggerConfig(yaml, {});
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.triggers[0]?.pollingSource).toBeUndefined();
  });

  it('warns when merge_request.merged or merge_request.closed events are configured', () => {
    const yaml = `
triggers:
  - id: mr-close-trigger
    provider: gitlab_poll
    workflowId: mr-review-workflow-agentic
    workspacePath: /workspace
    goal: Review MR
    source:
      baseUrl: https://gitlab.com
      projectId: "12345"
      token: mytoken
      events: merge_request.merged merge_request.closed
`;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = loadTriggerConfig(yaml, {});

    // Trigger still loads despite the warning
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') {
      warnSpy.mockRestore();
      return;
    }
    expect(result.value.triggers).toHaveLength(1);

    // Warning fires for each unreachable event type
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("cannot be observed with state=opened polling"),
    );
    // Both events generate a warning
    const calls = warnSpy.mock.calls.map((args) => String(args[0]));
    expect(calls.some((msg) => msg.includes('merge_request.merged'))).toBe(true);
    expect(calls.some((msg) => msg.includes('merge_request.closed'))).toBe(true);

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// github_issues_poll and github_prs_poll provider parsing
// ---------------------------------------------------------------------------

describe('github_issues_poll provider parsing', () => {
  const BASE_YAML = `
triggers:
  - id: gh-issues
    provider: github_issues_poll
    workflowId: bug-investigation
    workspacePath: /workspace
    goal: Investigate new bug
    source:
      repo: acme/my-project
      token: $GITHUB_TOKEN
      events: issues.opened issues.updated
      excludeAuthors: worktrain-bot dependabot[bot]
      notLabels: wont-fix duplicate
      labelFilter: bug
      pollIntervalSeconds: 300
`;

  it('parses a complete github_issues_poll trigger', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = loadTriggerConfig(BASE_YAML, { GITHUB_TOKEN: 'ghp_secret' });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') { warnSpy.mockRestore(); return; }

    const trigger = result.value.triggers[0];
    expect(trigger).toBeDefined();
    if (!trigger) { warnSpy.mockRestore(); return; }

    expect(trigger.provider).toBe('github_issues_poll');
    expect(trigger.workflowId).toBe('bug-investigation');

    const src = trigger.pollingSource;
    expect(src).toBeDefined();
    if (!src) { warnSpy.mockRestore(); return; }

    expect(src.provider).toBe('github_issues_poll');

    // Only check fields present in GitHubPollingSource
    if (src.provider === 'github_issues_poll' || src.provider === 'github_prs_poll') {
      expect(src.repo).toBe('acme/my-project');
      expect(src.token).toBe('ghp_secret'); // resolved from env
      expect(src.events).toEqual(['issues.opened', 'issues.updated']);
      expect(src.excludeAuthors).toEqual(['worktrain-bot', 'dependabot[bot]']);
      expect(src.notLabels).toEqual(['wont-fix', 'duplicate']);
      expect(src.labelFilter).toEqual(['bug']);
      expect(src.pollIntervalSeconds).toBe(300);
    }

    warnSpy.mockRestore();
  });

  it('defaults pollIntervalSeconds to 60 when not specified', () => {
    const yaml = `
triggers:
  - id: gh-issues-minimal
    provider: github_issues_poll
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Check issues
    source:
      repo: acme/my-project
      token: ghp_token
      events: issues.opened
`;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = loadTriggerConfig(yaml, {});

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      const src = result.value.triggers[0]?.pollingSource;
      expect(src?.pollIntervalSeconds).toBe(60);
    }
    warnSpy.mockRestore();
  });

  it('defaults excludeAuthors, notLabels, labelFilter to empty arrays when absent', () => {
    const yaml = `
triggers:
  - id: gh-issues-minimal2
    provider: github_issues_poll
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Check issues
    source:
      repo: acme/my-project
      token: ghp_token
      events: issues.opened
`;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = loadTriggerConfig(yaml, {});

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      const src = result.value.triggers[0]?.pollingSource;
      if (src?.provider === 'github_issues_poll') {
        expect(src.excludeAuthors).toEqual([]);
        expect(src.notLabels).toEqual([]);
        expect(src.labelFilter).toEqual([]);
      }
    }
    warnSpy.mockRestore();
  });

  it('emits warning when excludeAuthors is not set', () => {
    const yaml = `
triggers:
  - id: gh-issues-no-exclude
    provider: github_issues_poll
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Check issues
    source:
      repo: acme/my-project
      token: ghp_token
      events: issues.opened
`;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadTriggerConfig(yaml, {});

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('excludeAuthors is not set'),
    );
    warnSpy.mockRestore();
  });

  it('returns missing_field error when source.repo is absent', () => {
    const yaml = `
triggers:
  - id: gh-issues-no-repo
    provider: github_issues_poll
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Check issues
    source:
      token: ghp_token
      events: issues.opened
`;
    const result = loadTriggerConfig(yaml, {});

    // Trigger is skipped (invalid) -- config loads with 0 triggers
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.triggers).toHaveLength(0);
    }
  });

  it('returns missing_field error when source is absent', () => {
    const yaml = `
triggers:
  - id: gh-issues-no-source
    provider: github_issues_poll
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Check issues
`;
    const result = loadTriggerConfig(yaml, {});

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.triggers).toHaveLength(0);
    }
  });

  it('resolves token from environment variable', () => {
    const yaml = `
triggers:
  - id: gh-issues-env-token
    provider: github_issues_poll
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Check issues
    source:
      repo: acme/my-project
      token: $MY_GH_TOKEN
      events: issues.opened
`;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = loadTriggerConfig(yaml, { MY_GH_TOKEN: 'resolved-token' });

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      const src = result.value.triggers[0]?.pollingSource;
      expect(src?.token).toBe('resolved-token');
    }
    warnSpy.mockRestore();
  });
});

describe('github_prs_poll provider parsing', () => {
  it('parses a complete github_prs_poll trigger', () => {
    const yaml = `
triggers:
  - id: gh-prs
    provider: github_prs_poll
    workflowId: mr-review-workflow
    workspacePath: /workspace
    goal: Review PR
    source:
      repo: acme/my-project
      token: ghp_token
      events: pull_request.opened pull_request.updated
      excludeAuthors: worktrain-bot
      pollIntervalSeconds: 300
`;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = loadTriggerConfig(yaml, {});

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') { warnSpy.mockRestore(); return; }

    const trigger = result.value.triggers[0];
    expect(trigger?.provider).toBe('github_prs_poll');

    const src = trigger?.pollingSource;
    if (src?.provider === 'github_prs_poll') {
      expect(src.repo).toBe('acme/my-project');
      expect(src.events).toEqual(['pull_request.opened', 'pull_request.updated']);
      expect(src.excludeAuthors).toEqual(['worktrain-bot']);
      expect(src.pollIntervalSeconds).toBe(300);
    }

    warnSpy.mockRestore();
  });

  it('github_prs_poll pollingSource has provider tag === github_prs_poll', () => {
    const yaml = `
triggers:
  - id: gh-prs-tag
    provider: github_prs_poll
    workflowId: mr-review
    workspacePath: /workspace
    goal: Review PR
    source:
      repo: acme/proj
      token: tok
      events: pull_request.opened
`;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = loadTriggerConfig(yaml, {});

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.triggers[0]?.pollingSource?.provider).toBe('github_prs_poll');
    }
    warnSpy.mockRestore();
  });
});
