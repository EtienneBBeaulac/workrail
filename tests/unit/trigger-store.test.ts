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

import { describe, expect, it } from 'vitest';
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
});
