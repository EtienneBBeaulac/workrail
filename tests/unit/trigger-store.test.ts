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

import * as os from 'node:os';
import * as path from 'node:path';
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

// ---------------------------------------------------------------------------
// Workspace namespacing (Phase 1)
// ---------------------------------------------------------------------------

describe('workspace namespacing (Phase 1)', () => {
  const WORKSPACE_MAP = {
    'my-project': { path: '/Users/me/git/my-project' },
    'with-soul': { path: '/Users/me/git/with-soul', soulFile: '/home/me/.workrail/workspaces/with-soul/daemon-soul.md' },
  };

  it('happy path: resolves workspacePath from workspaceName', () => {
    const yaml = `
triggers:
  - id: my-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspaceName: my-project
    goal: Review this MR
`;
    const result = loadTriggerConfig(yaml, {}, WORKSPACE_MAP);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.triggers).toHaveLength(1);
    const trigger = result.value.triggers[0]!;
    expect(trigger.workspacePath).toBe('/Users/me/git/my-project');
    expect(trigger.workspaceName).toBe('my-project');
    expect(trigger.soulFile).toBeUndefined();
  });

  it('resolves workspace soulFile into trigger soulFile when no trigger-level override', () => {
    const yaml = `
triggers:
  - id: soul-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspaceName: with-soul
    goal: Review this MR
`;
    const result = loadTriggerConfig(yaml, {}, WORKSPACE_MAP);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const trigger = result.value.triggers[0]!;
    expect(trigger.soulFile).toBe('/home/me/.workrail/workspaces/with-soul/daemon-soul.md');
  });

  it('trigger-level soulFile overrides workspace soulFile', () => {
    const yaml = `
triggers:
  - id: override-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspaceName: with-soul
    soulFile: /custom/soul.md
    goal: Review this MR
`;
    const result = loadTriggerConfig(yaml, {}, WORKSPACE_MAP);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const trigger = result.value.triggers[0]!;
    expect(trigger.soulFile).toBe('/custom/soul.md');
  });

  it('trigger with soulFile only (no workspaceName) stores soulFile directly', () => {
    const yaml = `
triggers:
  - id: soul-only-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspacePath: /path/to/repo
    soulFile: /my/soul.md
    goal: Review this MR
`;
    const result = loadTriggerConfig(yaml, {}, {});
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const trigger = result.value.triggers[0]!;
    expect(trigger.soulFile).toBe('/my/soul.md');
    expect(trigger.workspaceName).toBeUndefined();
    expect(trigger.workspacePath).toBe('/path/to/repo');
  });

  it('emits unknown_workspace per-trigger error when workspaceName not in map', () => {
    const yaml = `
triggers:
  - id: bad-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspaceName: nonexistent
    goal: Review this MR
  - id: good-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspacePath: /path/to/repo
    goal: Review this MR
`;
    const result = loadTriggerConfig(yaml, {}, WORKSPACE_MAP);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    // bad-trigger is skipped; good-trigger loads successfully
    expect(result.value.triggers).toHaveLength(1);
    expect(result.value.triggers[0]!.id).toBe('good-trigger');
  });

  it('warns and uses workspaceName when both workspaceName and workspacePath are specified', () => {
    const yaml = `
triggers:
  - id: conflict-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspaceName: my-project
    workspacePath: /some/other/path
    goal: Review this MR
`;
    const result = loadTriggerConfig(yaml, {}, WORKSPACE_MAP);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const trigger = result.value.triggers[0]!;
    // workspaceName takes precedence
    expect(trigger.workspacePath).toBe('/Users/me/git/my-project');
  });

  it('rejects workspaceName with invalid format (contains slash)', () => {
    const yaml = `
triggers:
  - id: bad-name-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspaceName: my/project
    goal: Review this MR
`;
    const result = loadTriggerConfig(yaml, {}, WORKSPACE_MAP);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    // Invalid format -- trigger is skipped
    expect(result.value.triggers).toHaveLength(0);
  });

  it('rejects workspace config with relative path', () => {
    const workspacesWithRelative = {
      'relative': { path: 'relative/path' },
    };
    const yaml = `
triggers:
  - id: relative-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspaceName: relative
    goal: Review this MR
`;
    const result = loadTriggerConfig(yaml, {}, workspacesWithRelative);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    // Trigger skipped due to relative path in workspace config
    expect(result.value.triggers).toHaveLength(0);
  });

  it('backward compat: existing triggers without workspaceName work unchanged', () => {
    const yaml = `
triggers:
  - id: existing-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspacePath: /existing/path
    goal: Review this MR
`;
    const result = loadTriggerConfig(yaml, {}, {}); // no workspaces map
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.triggers).toHaveLength(1);
    expect(result.value.triggers[0]!.workspacePath).toBe('/existing/path');
    expect(result.value.triggers[0]!.workspaceName).toBeUndefined();
  });

  it('backward compat: calling without workspaces param works (existing API)', () => {
    const yaml = `
triggers:
  - id: compat-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspacePath: /compat/path
    goal: Review this MR
`;
    // Calling with only 2 params (existing callers) still works
    const result = loadTriggerConfig(yaml, {});
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.triggers).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // F1: Tilde path expansion for soulFile
  // ---------------------------------------------------------------------------

  it('F1: expands ~/... soulFile in trigger YAML (workspacePath branch)', () => {
    // WHY this test: Node.js fs.readFile does not expand ~; without expandTildePath,
    // a soulFile: ~/foo/soul.md would produce ENOENT and silently fall through.
    const yaml = `
triggers:
  - id: tilde-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspacePath: /path/to/repo
    soulFile: ~/foo/daemon-soul.md
    goal: Review this MR
`;
    const result = loadTriggerConfig(yaml, {}, {});
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const trigger = result.value.triggers[0]!;
    expect(trigger.soulFile).toBe(path.join(os.homedir(), 'foo/daemon-soul.md'));
    // The resolved path must be absolute (no leading ~)
    expect(trigger.soulFile!.startsWith('~')).toBe(false);
  });

  it('F1: expands ~/... soulFile from workspace config cascade (workspaceName branch)', () => {
    // Tilde expansion must also work when the soulFile comes from the workspace map
    // (not the trigger YAML), since the cascade sets resolvedSoulFile from workspaceConfig.soulFile.
    const workspacesWithTilde = {
      'tilde-workspace': { path: '/Users/me/git/project', soulFile: '~/.workrail/workspaces/my/soul.md' },
    };
    const yaml = `
triggers:
  - id: tilde-ws-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspaceName: tilde-workspace
    goal: Review this MR
`;
    const result = loadTriggerConfig(yaml, {}, workspacesWithTilde);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const trigger = result.value.triggers[0]!;
    expect(trigger.soulFile).toBe(path.join(os.homedir(), '.workrail/workspaces/my/soul.md'));
    expect(trigger.soulFile!.startsWith('~')).toBe(false);
  });

  it('F1: does not alter already-absolute soulFile path', () => {
    const yaml = `
triggers:
  - id: abs-soul-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspacePath: /path/to/repo
    soulFile: /absolute/soul.md
    goal: Review this MR
`;
    const result = loadTriggerConfig(yaml, {}, {});
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.triggers[0]!.soulFile).toBe('/absolute/soul.md');
  });

  // ---------------------------------------------------------------------------
  // F2: Absoluteness validation for soulFile after tilde expansion
  // ---------------------------------------------------------------------------

  it('F2: rejects trigger with relative soulFile (trigger-level, workspacePath branch)', () => {
    // WHY: a relative soulFile silently resolves against process.cwd(), which is
    // almost certainly wrong. Mirrors workspace.path absoluteness check.
    const yaml = `
triggers:
  - id: relative-soul-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspacePath: /path/to/repo
    soulFile: relative/soul.md
    goal: Review this MR
`;
    const result = loadTriggerConfig(yaml, {}, {});
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    // Trigger with relative soulFile is skipped
    expect(result.value.triggers).toHaveLength(0);
  });

  it('F2: rejects trigger with relative soulFile from workspace config cascade', () => {
    const workspacesWithRelativeSoul = {
      'relative-soul-ws': { path: '/Users/me/git/project', soulFile: 'relative/soul.md' },
    };
    const yaml = `
triggers:
  - id: relative-soul-ws-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspaceName: relative-soul-ws
    goal: Review this MR
`;
    const result = loadTriggerConfig(yaml, {}, workspacesWithRelativeSoul);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    // Trigger with relative soulFile from workspace cascade is skipped
    expect(result.value.triggers).toHaveLength(0);
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
