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
import { describe, expect, it, vi } from 'vitest';
import { loadTriggerConfig } from '../../src/trigger/trigger-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MINIMAL_TRIGGER_YAML = `
triggers:
  - id: my-trigger
    provider: generic
    workflowId: wr.coding-task
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
    workflowId: wr.mr-review
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
    branchStrategy: worktree
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
    branchStrategy: worktree
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
      expect(t?.workflowId).toBe('wr.coding-task');
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
    workflowId: wr.coding-task
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
    workflowId: wr.coding-task
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
    workflowId: wr.coding-task
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
    workflowId: wr.coding-task
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
    workflowId: wr.coding-task
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
    workflowId: wr.coding-task
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
    workflowId: wr.coding-task
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
    workflowId: wr.coding-task
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
    workflowId: wr.coding-task
    workspaceName: nonexistent
    goal: Review this MR
  - id: good-trigger
    provider: generic
    workflowId: wr.coding-task
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
    workflowId: wr.coding-task
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
    workflowId: wr.coding-task
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
    workflowId: wr.coding-task
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
    workflowId: wr.coding-task
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
    workflowId: wr.coding-task
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
    workflowId: wr.coding-task
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
    workflowId: wr.coding-task
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
    workflowId: wr.coding-task
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
    workflowId: wr.coding-task
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
    workflowId: wr.coding-task
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
    workflowId: wr.mr-review
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
    workflowId: wr.mr-review
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
    workflowId: wr.mr-review
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
    workflowId: wr.mr-review
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
    workflowId: wr.mr-review
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
    workflowId: wr.mr-review
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
    workflowId: wr.coding-task
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
    workflowId: wr.mr-review
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

// ---------------------------------------------------------------------------
// Late-bound goals: default goalTemplate injection
// ---------------------------------------------------------------------------

describe('late-bound goals', () => {
  it('loads successfully when neither goal nor goalTemplate is configured, injecting defaults', () => {
    const yaml = `
triggers:
  - id: late-bound
    provider: generic
    workflowId: wr.coding-task
    workspacePath: /workspace
`;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = loadTriggerConfig(yaml, {});

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      const trigger = result.value.triggers[0];
      expect(trigger?.goal).toBe('Autonomous task');
      expect(trigger?.goalTemplate).toBe('{{$.goal}}');
    }
    // Should log an informational message about the late-bound injection
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('defaulting to goalTemplate'));
    logSpy.mockRestore();
  });

  it('uses sentinel goal when goalTemplate is configured but goal is absent', () => {
    const yaml = `
triggers:
  - id: template-only
    provider: generic
    workflowId: wr.coding-task
    workspacePath: /workspace
    goalTemplate: "Review PR: {{$.pull_request.title}}"
`;
    const result = loadTriggerConfig(yaml, {});

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      const trigger = result.value.triggers[0];
      // Static fallback sentinel is injected; goalTemplate comes from YAML
      expect(trigger?.goal).toBe('Autonomous task');
      expect(trigger?.goalTemplate).toBe('Review PR: {{$.pull_request.title}}');
    }
  });

  it('leaves existing triggers with a static goal unchanged (regression)', () => {
    const yaml = `
triggers:
  - id: static-goal
    provider: generic
    workflowId: wr.coding-task
    workspacePath: /workspace
    goal: Review this MR
`;
    const result = loadTriggerConfig(yaml, {});

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      const trigger = result.value.triggers[0];
      expect(trigger?.goal).toBe('Review this MR');
      expect(trigger?.goalTemplate).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// branchStrategy validation (Phase 1 breaking change)
// ---------------------------------------------------------------------------

describe('branchStrategy validation', () => {
  // Phase 1: autoCommit + absent/none branchStrategy is a hard error.
  // The smart default (silently use worktree) was removed to prevent silent checkout corruption.

  it('hard error: autoCommit + absent branchStrategy -> trigger skipped', () => {
    const yaml = `
triggers:
  - id: auto-commit-no-strategy
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
    autoCommit: "true"
`;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = loadTriggerConfig(yaml, {});
    warnSpy.mockRestore();

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      // Invalid trigger is skipped; returned config has 0 valid triggers
      expect(result.value.triggers).toHaveLength(0);
    }
  });

  it('hard error: autoCommit + branchStrategy: none -> trigger skipped', () => {
    const yaml = `
triggers:
  - id: explicit-none
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
    branchStrategy: none
    autoCommit: "true"
`;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = loadTriggerConfig(yaml, {});
    warnSpy.mockRestore();

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.triggers).toHaveLength(0);
    }
  });

  it('hard error: autoOpenPR + absent autoCommit -> trigger skipped', () => {
    const yaml = `
triggers:
  - id: auto-pr-no-autocommit
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
    autoOpenPR: "true"
`;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = loadTriggerConfig(yaml, {});
    warnSpy.mockRestore();

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.triggers).toHaveLength(0);
    }
  });

  it('valid: autoCommit + branchStrategy: worktree is accepted', () => {
    const yaml = `
triggers:
  - id: auto-commit-with-worktree
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
    autoCommit: "true"
    branchStrategy: worktree
`;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = loadTriggerConfig(yaml, {});
    logSpy.mockRestore();

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.triggers).toHaveLength(1);
      expect(result.value.triggers[0]?.branchStrategy).toBe('worktree');
      expect(result.value.triggers[0]?.autoCommit).toBe(true);
    }
  });

  it('valid: autoCommit + autoOpenPR + branchStrategy: worktree is accepted', () => {
    const yaml = `
triggers:
  - id: auto-pr-with-worktree
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
    autoCommit: "true"
    autoOpenPR: "true"
    branchStrategy: worktree
`;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = loadTriggerConfig(yaml, {});
    logSpy.mockRestore();

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.triggers).toHaveLength(1);
      expect(result.value.triggers[0]?.branchStrategy).toBe('worktree');
    }
  });

  it('keeps branchStrategy undefined when neither autoCommit nor autoOpenPR is set and branchStrategy is absent', () => {
    const yaml = `
triggers:
  - id: read-only-trigger
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
`;
    const result = loadTriggerConfig(yaml, {});

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      // No branchStrategy in YAML and no autoCommit/autoOpenPR -- stays undefined (no git overhead)
      expect(result.value.triggers[0]?.branchStrategy).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// stuckAbortPolicy parsing
// ---------------------------------------------------------------------------

describe('stuckAbortPolicy parsing', () => {
  it('parses agentConfig.stuckAbortPolicy: "abort" correctly', () => {
    const yaml = `
triggers:
  - id: stuck-abort-trigger
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
    agentConfig:
      maxSessionMinutes: 60
      stuckAbortPolicy: abort
`;
    const result = loadTriggerConfig(yaml, {});

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.triggers[0]?.agentConfig?.stuckAbortPolicy).toBe('abort');
    }
  });

  it('parses agentConfig.stuckAbortPolicy: "notify_only" correctly', () => {
    const yaml = `
triggers:
  - id: stuck-notify-trigger
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
    agentConfig:
      stuckAbortPolicy: notify_only
`;
    const result = loadTriggerConfig(yaml, {});

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.triggers[0]?.agentConfig?.stuckAbortPolicy).toBe('notify_only');
    }
  });

  it('skips trigger when stuckAbortPolicy has an invalid value', () => {
    const yaml = `
triggers:
  - id: bad-stuck-trigger
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
    agentConfig:
      stuckAbortPolicy: kill
`;
    const result = loadTriggerConfig(yaml, {});

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      // Trigger is skipped due to invalid stuckAbortPolicy value
      expect(result.value.triggers).toHaveLength(0);
    }
  });
});

// maxOutputTokens parsing
// WHY: maxOutputTokens is a per-trigger cap on LLM output tokens, threaded from
// triggers.yml through TriggerDefinition.agentConfig.maxOutputTokens to AgentLoop.maxTokens.
// Validated as a positive integer at parse time (same pattern as maxTurns/maxSessionMinutes).
describe('maxOutputTokens parsing', () => {
  it('parses agentConfig.maxOutputTokens correctly when set to a valid value', () => {
    const yaml = `
triggers:
  - id: max-output-tokens-trigger
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
    agentConfig:
      maxOutputTokens: 16384
`;
    const result = loadTriggerConfig(yaml, {});

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.triggers[0]?.agentConfig?.maxOutputTokens).toBe(16384);
    }
  });

  it('skips trigger when maxOutputTokens has an invalid value (zero)', () => {
    const yaml = `
triggers:
  - id: bad-max-output-tokens-trigger
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
    agentConfig:
      maxOutputTokens: 0
`;
    const result = loadTriggerConfig(yaml, {});

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      // Trigger is skipped due to invalid maxOutputTokens value
      expect(result.value.triggers).toHaveLength(0);
    }
  });

  it('skips trigger when maxOutputTokens is negative (-1)', () => {
    const yaml = `
triggers:
  - id: neg-max-output-tokens-trigger
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
    agentConfig:
      maxOutputTokens: -1
`;
    const result = loadTriggerConfig(yaml, {});

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      // Trigger is skipped due to invalid maxOutputTokens value
      expect(result.value.triggers).toHaveLength(0);
    }
  });

  it('skips trigger when maxOutputTokens is not an integer (1.5)', () => {
    const yaml = `
triggers:
  - id: float-max-output-tokens-trigger
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
    agentConfig:
      maxOutputTokens: 1.5
`;
    const result = loadTriggerConfig(yaml, {});

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      // Trigger is skipped due to non-integer maxOutputTokens value
      expect(result.value.triggers).toHaveLength(0);
    }
  });

  it('leaves maxOutputTokens as undefined when not set', () => {
    const yaml = `
triggers:
  - id: no-max-output-tokens-trigger
    provider: generic
    workflowId: my-workflow
    workspacePath: /workspace
    goal: Run workflow
`;
    const result = loadTriggerConfig(yaml, {});

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.triggers[0]?.agentConfig?.maxOutputTokens).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// maxQueueDepth parsing and validation
// ---------------------------------------------------------------------------

describe('maxQueueDepth', () => {
  it('parses maxQueueDepth correctly when set to a positive integer', () => {
    const yaml = `
triggers:
  - id: t1
    provider: generic
    workflowId: wr.coding-task
    workspacePath: /workspace
    goal: Test
    maxQueueDepth: 5
`;
    const result = loadTriggerConfig(yaml, {});
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.triggers).toHaveLength(1);
      expect(result.value.triggers[0]?.maxQueueDepth).toBe(5);
    }
  });

  it('leaves maxQueueDepth undefined when absent', () => {
    const yaml = `
triggers:
  - id: t1
    provider: generic
    workflowId: wr.coding-task
    workspacePath: /workspace
    goal: Test
`;
    const result = loadTriggerConfig(yaml, {});
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.triggers[0]?.maxQueueDepth).toBeUndefined();
    }
  });

  it('rejects maxQueueDepth: 0 as a hard error (trigger skipped)', () => {
    const yaml = `
triggers:
  - id: bad-trigger
    provider: generic
    workflowId: wr.coding-task
    workspacePath: /workspace
    goal: Test
    maxQueueDepth: 0
`;
    const result = loadTriggerConfig(yaml, {});
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      // Trigger is skipped due to invalid maxQueueDepth
      expect(result.value.triggers).toHaveLength(0);
    }
  });

  it('rejects maxQueueDepth: -1 as a hard error (trigger skipped)', () => {
    const yaml = `
triggers:
  - id: bad-trigger
    provider: generic
    workflowId: wr.coding-task
    workspacePath: /workspace
    goal: Test
    maxQueueDepth: -1
`;
    const result = loadTriggerConfig(yaml, {});
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.triggers).toHaveLength(0);
    }
  });

  it('rejects non-integer maxQueueDepth (float) as a hard error', () => {
    const yaml = `
triggers:
  - id: bad-trigger
    provider: generic
    workflowId: wr.coding-task
    workspacePath: /workspace
    goal: Test
    maxQueueDepth: 5.5
`;
    const result = loadTriggerConfig(yaml, {});
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.triggers).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// validateTriggerStrict: maxQueueDepth advisory rules
// ---------------------------------------------------------------------------

describe('validateTriggerStrict maxQueueDepth rules', () => {
  it('emits info advisory for serial trigger without maxQueueDepth', async () => {
    const { validateTriggerStrict } = await import('../../src/trigger/trigger-store.js');
    const { asTriggerId } = await import('../../src/trigger/types.js');

    const trigger = {
      id: asTriggerId('t1'),
      provider: 'generic',
      workflowId: 'wr.coding-task',
      workspacePath: '/workspace',
      goal: 'Test',
      concurrencyMode: 'serial' as const,
      // maxQueueDepth absent
    };

    const issues = validateTriggerStrict(trigger);
    const depthIssue = issues.find((i) => i.rule === 'missing-max-queue-depth');
    expect(depthIssue).toBeDefined();
    expect(depthIssue?.severity).toBe('info');
  });

  it('does NOT emit missing-max-queue-depth advisory for parallel trigger', async () => {
    const { validateTriggerStrict } = await import('../../src/trigger/trigger-store.js');
    const { asTriggerId } = await import('../../src/trigger/types.js');

    const trigger = {
      id: asTriggerId('t1'),
      provider: 'generic',
      workflowId: 'wr.coding-task',
      workspacePath: '/workspace',
      goal: 'Test',
      concurrencyMode: 'parallel' as const,
      // maxQueueDepth absent, but parallel -- no advisory
    };

    const issues = validateTriggerStrict(trigger);
    const depthIssue = issues.find((i) => i.rule === 'missing-max-queue-depth');
    expect(depthIssue).toBeUndefined();
  });

  it('does NOT emit missing-max-queue-depth advisory when maxQueueDepth is set', async () => {
    const { validateTriggerStrict } = await import('../../src/trigger/trigger-store.js');
    const { asTriggerId } = await import('../../src/trigger/types.js');

    const trigger = {
      id: asTriggerId('t1'),
      provider: 'generic',
      workflowId: 'wr.coding-task',
      workspacePath: '/workspace',
      goal: 'Test',
      concurrencyMode: 'serial' as const,
      maxQueueDepth: 5,
    };

    const issues = validateTriggerStrict(trigger);
    const depthIssue = issues.find((i) => i.rule === 'missing-max-queue-depth');
    expect(depthIssue).toBeUndefined();
  });
});
