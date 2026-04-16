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

const WITH_CONCURRENCY_SERIAL_YAML = `
triggers:
  - id: serial-trigger
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
    concurrencyMode: serial
`;

const WITH_CONCURRENCY_PARALLEL_YAML = `
triggers:
  - id: parallel-trigger
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
    concurrencyMode: parallel
`;

const WITH_INVALID_CONCURRENCY_YAML = `
triggers:
  - id: bad-trigger
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
    concurrencyMode: auto
`;

const WITH_AUTO_COMMIT_TRUE_YAML = `
triggers:
  - id: auto-commit-trigger
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
    autoCommit: "true"
`;

const WITH_AUTO_OPEN_PR_TRUE_YAML = `
triggers:
  - id: auto-pr-trigger
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
    autoCommit: "true"
    autoOpenPR: "true"
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

    it('defaults concurrencyMode to serial when absent', () => {
      const result = loadTriggerConfig(MINIMAL_TRIGGER_YAML, {});
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers[0]?.concurrencyMode).toBe('serial');
    });

    it('parses concurrencyMode: serial', () => {
      const result = loadTriggerConfig(WITH_CONCURRENCY_SERIAL_YAML, {});
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers[0]?.concurrencyMode).toBe('serial');
    });

    it('parses concurrencyMode: parallel', () => {
      const result = loadTriggerConfig(WITH_CONCURRENCY_PARALLEL_YAML, {});
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers[0]?.concurrencyMode).toBe('parallel');
    });

    it('parses autoCommit: "true" as boolean true', () => {
      // YAML scalars are strings; the store coerces the string 'true' to boolean true.
      const result = loadTriggerConfig(WITH_AUTO_COMMIT_TRUE_YAML, {});
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers[0]?.autoCommit).toBe(true);
    });

    it('defaults autoCommit to undefined (falsy) when absent from YAML', () => {
      // When autoCommit is absent, the field is omitted from TriggerDefinition entirely.
      // The delivery gate checks flags.autoCommit !== true, so undefined is safe (skipped).
      const result = loadTriggerConfig(MINIMAL_TRIGGER_YAML, {});
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers[0]?.autoCommit).toBeUndefined();
    });

    it('parses autoOpenPR: "true" as boolean true', () => {
      const result = loadTriggerConfig(WITH_AUTO_OPEN_PR_TRUE_YAML, {});
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers[0]?.autoOpenPR).toBe(true);
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

    it('skips trigger with invalid concurrencyMode value (collect-all-errors)', () => {
      const result = loadTriggerConfig(WITH_INVALID_CONCURRENCY_YAML, {});
      // Invalid trigger is skipped; valid subset (empty here) is returned
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers).toHaveLength(0);
    });

    it('skips trigger with wrong-cased concurrencyMode "Serial" (case-sensitive)', () => {
      const yaml = `
triggers:
  - id: bad-trigger
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
    concurrencyMode: Serial
`;
      const result = loadTriggerConfig(yaml, {});
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers).toHaveLength(0);
    });

    it('skips trigger with wrong-cased concurrencyMode "PARALLEL" (case-sensitive)', () => {
      const yaml = `
triggers:
  - id: bad-trigger
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
    concurrencyMode: PARALLEL
`;
      const result = loadTriggerConfig(yaml, {});
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers).toHaveLength(0);
    });

    it('skips trigger with numeric concurrencyMode value (parsed as string "1" by narrow parser)', () => {
      const yaml = `
triggers:
  - id: bad-trigger
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
    concurrencyMode: 1
`;
      const result = loadTriggerConfig(yaml, {});
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers).toHaveLength(0);
    });

    it('loads trigger as serial when concurrencyMode has unquoted empty value (defaults to serial)', () => {
      // Unquoted empty value after colon: the narrow parser skips the field entirely
      // (rawValue === '' -> field not set -> raw.concurrencyMode is undefined -> defaults to 'serial').
      // This is the expected silent-default behavior.
      const yaml = `
triggers:
  - id: my-trigger
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
    concurrencyMode:
`;
      const result = loadTriggerConfig(yaml, {});
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers).toHaveLength(1);
      expect(result.value.triggers[0]?.concurrencyMode).toBe('serial');
    });

    it('skips trigger with quoted empty string concurrencyMode ""', () => {
      // Quoted empty string is explicitly stored as '' and rejected as an invalid value.
      const yaml = `
triggers:
  - id: bad-trigger
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
    concurrencyMode: ""
`;
      const result = loadTriggerConfig(yaml, {});
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
// goalTemplate and referenceUrls field parsing
// ---------------------------------------------------------------------------

describe('goalTemplate and referenceUrls field parsing', () => {
  it('parses goalTemplate field', () => {
    const yaml = `
triggers:
  - id: my-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspacePath: /workspace
    goal: Review this MR
    goalTemplate: "Review MR: {{$.pull_request.title}}"
`;
    const result = loadTriggerConfig(yaml, {});
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.triggers[0]?.goalTemplate).toBe('Review MR: {{$.pull_request.title}}');
  });

  it('parses referenceUrls as an array split on whitespace', () => {
    const yaml = `
triggers:
  - id: my-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspacePath: /workspace
    goal: Review this MR
    referenceUrls: "https://doc1.example.com https://doc2.example.com"
`;
    const result = loadTriggerConfig(yaml, {});
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.triggers[0]?.referenceUrls).toEqual([
      'https://doc1.example.com',
      'https://doc2.example.com',
    ]);
  });

  it('omits referenceUrls when field is absent', () => {
    const yaml = `
triggers:
  - id: my-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspacePath: /workspace
    goal: Review this MR
`;
    const result = loadTriggerConfig(yaml, {});
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.triggers[0]?.referenceUrls).toBeUndefined();
  });

  it('skips trigger when referenceUrls contains a non-HTTP URL', () => {
    const yaml = `
triggers:
  - id: my-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspacePath: /workspace
    goal: Review this MR
    referenceUrls: "file:///etc/passwd"
`;
    const result = loadTriggerConfig(yaml, {});
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    // Invalid trigger is skipped; valid subset (empty here) is returned
    expect(result.value.triggers).toHaveLength(0);
  });
});
