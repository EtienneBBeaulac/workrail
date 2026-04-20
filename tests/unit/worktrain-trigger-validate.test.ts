/**
 * Unit tests for executeWorktrainTriggerValidateCommand and validateTriggerStrict.
 *
 * Test coverage:
 * 1. validateTriggerStrict: all 9 rules produce correct severity
 * 2. Sync coverage: triggers rejected by validateAndResolveTrigger are also
 *    flagged with error severity by validateTriggerStrict
 * 3. validateAllTriggers: multi-trigger config with one bad trigger
 * 4. executeWorktrainTriggerValidateCommand: clean config -> exit 0
 * 5. executeWorktrainTriggerValidateCommand: error config -> exit 1
 * 6. executeWorktrainTriggerValidateCommand: file not found -> exit 1
 * 7. executeWorktrainTriggerValidateCommand: parse error -> exit 1
 *
 * Uses fake deps (no vi.mock). Follows repo pattern: "prefer fakes over mocks".
 */

import { describe, it, expect } from 'vitest';
import {
  validateTriggerStrict,
  validateAllTriggers,
  loadTriggerConfig,
} from '../../src/trigger/trigger-store.js';
import {
  executeWorktrainTriggerValidateCommand,
  type WorktrainTriggerValidateDeps,
} from '../../src/cli/commands/worktrain-trigger-validate.js';
import type { TriggerDefinition, TriggerConfig } from '../../src/trigger/types.js';

// ═══════════════════════════════════════════════════════════════════════════
// TEST FIXTURES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Base trigger with all required fields set to safe defaults.
 * Tests override specific fields to trigger individual rules.
 */
const BASE_TRIGGER: TriggerDefinition = {
  id: 'base-trigger' as TriggerDefinition['id'],
  provider: 'generic',
  workflowId: 'coding-task-workflow-agentic',
  workspacePath: '/workspace',
  goal: 'Review this PR',
  concurrencyMode: 'serial',
  branchStrategy: 'worktree',
  baseBranch: 'main',
  branchPrefix: 'worktrain/',
  agentConfig: {
    maxSessionMinutes: 60,
    maxTurns: 50,
  },
};

/** Helper: create a trigger from BASE_TRIGGER with specific overrides */
function makeTrigger(overrides: Partial<TriggerDefinition>): TriggerDefinition {
  return { ...BASE_TRIGGER, ...overrides };
}

// ═══════════════════════════════════════════════════════════════════════════
// validateTriggerStrict: all 9 rules
// ═══════════════════════════════════════════════════════════════════════════

describe('validateTriggerStrict', () => {
  it('returns empty array for a fully valid trigger', () => {
    const issues = validateTriggerStrict(BASE_TRIGGER);
    expect(issues).toHaveLength(0);
  });

  describe('rule: autocommit-needs-worktree (error)', () => {
    it('fires when autoCommit is true and branchStrategy is absent', () => {
      const trigger = makeTrigger({ autoCommit: true, branchStrategy: undefined });
      const issues = validateTriggerStrict(trigger);
      const rule = issues.find((i) => i.rule === 'autocommit-needs-worktree');
      expect(rule).toBeDefined();
      expect(rule?.severity).toBe('error');
      expect(rule?.triggerId).toBe('base-trigger');
    });

    it('fires when autoCommit is true and branchStrategy is none', () => {
      const trigger = makeTrigger({ autoCommit: true, branchStrategy: 'none' });
      const issues = validateTriggerStrict(trigger);
      const rule = issues.find((i) => i.rule === 'autocommit-needs-worktree');
      expect(rule).toBeDefined();
      expect(rule?.severity).toBe('error');
    });

    it('does not fire when autoCommit is true and branchStrategy is worktree', () => {
      const trigger = makeTrigger({ autoCommit: true, branchStrategy: 'worktree' });
      const issues = validateTriggerStrict(trigger);
      expect(issues.find((i) => i.rule === 'autocommit-needs-worktree')).toBeUndefined();
    });

    it('does not fire when autoCommit is absent/false', () => {
      const trigger = makeTrigger({ autoCommit: undefined, branchStrategy: undefined });
      const issues = validateTriggerStrict(trigger);
      expect(issues.find((i) => i.rule === 'autocommit-needs-worktree')).toBeUndefined();
    });
  });

  describe('rule: autoopenpr-needs-autocommit (error)', () => {
    it('fires when autoOpenPR is true and autoCommit is absent', () => {
      const trigger = makeTrigger({ autoOpenPR: true, autoCommit: undefined });
      const issues = validateTriggerStrict(trigger);
      const rule = issues.find((i) => i.rule === 'autoopenpr-needs-autocommit');
      expect(rule).toBeDefined();
      expect(rule?.severity).toBe('error');
    });

    it('does not fire when autoOpenPR is true and autoCommit is true', () => {
      const trigger = makeTrigger({ autoOpenPR: true, autoCommit: true });
      const issues = validateTriggerStrict(trigger);
      expect(issues.find((i) => i.rule === 'autoopenpr-needs-autocommit')).toBeUndefined();
    });
  });

  describe('rule: worktree-needs-base-branch (error)', () => {
    it('fires when branchStrategy is worktree and baseBranch is absent', () => {
      const trigger = makeTrigger({ branchStrategy: 'worktree', baseBranch: undefined });
      const issues = validateTriggerStrict(trigger);
      const rule = issues.find((i) => i.rule === 'worktree-needs-base-branch');
      expect(rule).toBeDefined();
      expect(rule?.severity).toBe('error');
    });

    it('does not fire when branchStrategy is worktree and baseBranch is set', () => {
      const trigger = makeTrigger({ branchStrategy: 'worktree', baseBranch: 'main' });
      const issues = validateTriggerStrict(trigger);
      expect(issues.find((i) => i.rule === 'worktree-needs-base-branch')).toBeUndefined();
    });

    it('does not fire when branchStrategy is none', () => {
      const trigger = makeTrigger({ branchStrategy: 'none', baseBranch: undefined });
      const issues = validateTriggerStrict(trigger);
      expect(issues.find((i) => i.rule === 'worktree-needs-base-branch')).toBeUndefined();
    });
  });

  describe('rule: worktree-needs-prefix (error)', () => {
    it('fires when branchStrategy is worktree and branchPrefix is absent', () => {
      const trigger = makeTrigger({ branchStrategy: 'worktree', branchPrefix: undefined });
      const issues = validateTriggerStrict(trigger);
      const rule = issues.find((i) => i.rule === 'worktree-needs-prefix');
      expect(rule).toBeDefined();
      expect(rule?.severity).toBe('error');
    });

    it('does not fire when branchStrategy is worktree and branchPrefix is set', () => {
      const trigger = makeTrigger({ branchStrategy: 'worktree', branchPrefix: 'worktrain/' });
      const issues = validateTriggerStrict(trigger);
      expect(issues.find((i) => i.rule === 'worktree-needs-prefix')).toBeUndefined();
    });
  });

  describe('rule: parallel-without-worktree (warning)', () => {
    it('fires when concurrencyMode is parallel and branchStrategy is absent', () => {
      const trigger = makeTrigger({ concurrencyMode: 'parallel', branchStrategy: undefined });
      const issues = validateTriggerStrict(trigger);
      const rule = issues.find((i) => i.rule === 'parallel-without-worktree');
      expect(rule).toBeDefined();
      expect(rule?.severity).toBe('warning');
    });

    it('fires when concurrencyMode is parallel and branchStrategy is none', () => {
      const trigger = makeTrigger({ concurrencyMode: 'parallel', branchStrategy: 'none' });
      const issues = validateTriggerStrict(trigger);
      const rule = issues.find((i) => i.rule === 'parallel-without-worktree');
      expect(rule).toBeDefined();
      expect(rule?.severity).toBe('warning');
    });

    it('does not fire when concurrencyMode is parallel and branchStrategy is worktree', () => {
      const trigger = makeTrigger({ concurrencyMode: 'parallel', branchStrategy: 'worktree' });
      const issues = validateTriggerStrict(trigger);
      expect(issues.find((i) => i.rule === 'parallel-without-worktree')).toBeUndefined();
    });

    it('does not fire when concurrencyMode is serial', () => {
      const trigger = makeTrigger({ concurrencyMode: 'serial', branchStrategy: 'none' });
      const issues = validateTriggerStrict(trigger);
      expect(issues.find((i) => i.rule === 'parallel-without-worktree')).toBeUndefined();
    });
  });

  describe('rule: missing-goal-template (warning)', () => {
    it('fires when both goalTemplate and goal are the injected sentinels', () => {
      const trigger = makeTrigger({
        goalTemplate: '{{$.goal}}',
        goal: 'Autonomous task',
      });
      const issues = validateTriggerStrict(trigger);
      const rule = issues.find((i) => i.rule === 'missing-goal-template');
      expect(rule).toBeDefined();
      expect(rule?.severity).toBe('warning');
    });

    it('does not fire when goalTemplate is a non-sentinel value', () => {
      const trigger = makeTrigger({
        goalTemplate: 'Review PR {{$.pull_request.number}}',
        goal: 'Autonomous task',
      });
      const issues = validateTriggerStrict(trigger);
      expect(issues.find((i) => i.rule === 'missing-goal-template')).toBeUndefined();
    });

    it('does not fire when goal is a static non-sentinel value', () => {
      const trigger = makeTrigger({ goal: 'Review this PR', goalTemplate: undefined });
      const issues = validateTriggerStrict(trigger);
      expect(issues.find((i) => i.rule === 'missing-goal-template')).toBeUndefined();
    });
  });

  describe('rule: missing-max-session-minutes (warning)', () => {
    it('fires when agentConfig.maxSessionMinutes is absent', () => {
      const trigger = makeTrigger({ agentConfig: { maxTurns: 50 } });
      const issues = validateTriggerStrict(trigger);
      const rule = issues.find((i) => i.rule === 'missing-max-session-minutes');
      expect(rule).toBeDefined();
      expect(rule?.severity).toBe('warning');
    });

    it('fires when agentConfig is absent entirely', () => {
      const trigger = makeTrigger({ agentConfig: undefined });
      const issues = validateTriggerStrict(trigger);
      const rule = issues.find((i) => i.rule === 'missing-max-session-minutes');
      expect(rule).toBeDefined();
      expect(rule?.severity).toBe('warning');
    });

    it('does not fire when agentConfig.maxSessionMinutes is set', () => {
      const trigger = makeTrigger({ agentConfig: { maxSessionMinutes: 60 } });
      const issues = validateTriggerStrict(trigger);
      expect(issues.find((i) => i.rule === 'missing-max-session-minutes')).toBeUndefined();
    });
  });

  describe('rule: missing-max-turns (info)', () => {
    it('fires when agentConfig.maxTurns is absent', () => {
      const trigger = makeTrigger({ agentConfig: { maxSessionMinutes: 60 } });
      const issues = validateTriggerStrict(trigger);
      const rule = issues.find((i) => i.rule === 'missing-max-turns');
      expect(rule).toBeDefined();
      expect(rule?.severity).toBe('info');
    });

    it('does not fire when agentConfig.maxTurns is set', () => {
      const trigger = makeTrigger({ agentConfig: { maxSessionMinutes: 60, maxTurns: 50 } });
      const issues = validateTriggerStrict(trigger);
      expect(issues.find((i) => i.rule === 'missing-max-turns')).toBeUndefined();
    });
  });

  describe('rule: autocommit-on-main-checkout (warning)', () => {
    it('fires when autoCommit is true and branchStrategy is explicitly none', () => {
      const trigger = makeTrigger({ autoCommit: true, branchStrategy: 'none' });
      const issues = validateTriggerStrict(trigger);
      const rule = issues.find((i) => i.rule === 'autocommit-on-main-checkout');
      expect(rule).toBeDefined();
      expect(rule?.severity).toBe('warning');
    });

    it('does not fire when branchStrategy is worktree', () => {
      const trigger = makeTrigger({ autoCommit: true, branchStrategy: 'worktree' });
      const issues = validateTriggerStrict(trigger);
      expect(issues.find((i) => i.rule === 'autocommit-on-main-checkout')).toBeUndefined();
    });

    it('does not fire when autoCommit is absent', () => {
      const trigger = makeTrigger({ autoCommit: undefined, branchStrategy: 'none' });
      const issues = validateTriggerStrict(trigger);
      expect(issues.find((i) => i.rule === 'autocommit-on-main-checkout')).toBeUndefined();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Sync coverage: validateTriggerStrict mirrors validateAndResolveTrigger errors
//
// INVARIANT: every trigger that validateAndResolveTrigger rejects must also
// produce severity:'error' from validateTriggerStrict. These tests enforce
// the sync contract documented in the validateTriggerStrict invariant comment.
// ═══════════════════════════════════════════════════════════════════════════

describe('sync coverage: validateTriggerStrict mirrors validateAndResolveTrigger hard errors', () => {
  it('Phase 1 error: autoCommit + absent branchStrategy', () => {
    // This trigger would be rejected by validateAndResolveTrigger (Phase 1 hard error).
    // validateTriggerStrict must also return severity:'error'.
    const trigger = makeTrigger({ autoCommit: true, branchStrategy: undefined });
    const issues = validateTriggerStrict(trigger);
    const errorIssues = issues.filter((i) => i.severity === 'error');
    expect(errorIssues.length).toBeGreaterThan(0);
    expect(errorIssues.find((i) => i.rule === 'autocommit-needs-worktree')).toBeDefined();
  });

  it('Phase 1 error: autoCommit + branchStrategy: none', () => {
    // autoCommit + explicit branchStrategy: none is the Phase 1 hard error.
    const trigger = makeTrigger({ autoCommit: true, branchStrategy: 'none' });
    const issues = validateTriggerStrict(trigger);
    const errorIssues = issues.filter((i) => i.severity === 'error');
    expect(errorIssues.length).toBeGreaterThan(0);
    expect(errorIssues.find((i) => i.rule === 'autocommit-needs-worktree')).toBeDefined();
  });

  it('Phase 1 error: autoOpenPR + absent autoCommit', () => {
    // autoOpenPR + !autoCommit is the Phase 1 hard error.
    const trigger = makeTrigger({ autoOpenPR: true, autoCommit: undefined });
    const issues = validateTriggerStrict(trigger);
    const errorIssues = issues.filter((i) => i.severity === 'error');
    expect(errorIssues.length).toBeGreaterThan(0);
    expect(errorIssues.find((i) => i.rule === 'autoopenpr-needs-autocommit')).toBeDefined();
  });

  it('clean trigger produces no error-severity issues', () => {
    // A fully valid trigger should produce no errors (may have warnings for missing limits).
    const trigger = makeTrigger({
      autoCommit: true,
      autoOpenPR: true,
      branchStrategy: 'worktree',
      baseBranch: 'main',
      branchPrefix: 'worktrain/',
      goal: 'Review PR {{$.pull_request.number}}',
      goalTemplate: 'Review PR {{$.pull_request.number}}',
      agentConfig: { maxSessionMinutes: 60, maxTurns: 50 },
    });
    const issues = validateTriggerStrict(trigger);
    const errorIssues = issues.filter((i) => i.severity === 'error');
    expect(errorIssues).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// validateAllTriggers
// ═══════════════════════════════════════════════════════════════════════════

describe('validateAllTriggers', () => {
  it('returns empty array for config with all valid triggers', () => {
    const config: TriggerConfig = {
      triggers: [BASE_TRIGGER],
    };
    const issues = validateAllTriggers(config);
    expect(issues).toHaveLength(0);
  });

  it('returns issues only for the bad trigger in a mixed config', () => {
    const badTrigger = makeTrigger({
      id: 'bad-trigger' as TriggerDefinition['id'],
      autoCommit: true,
      branchStrategy: undefined,
    });
    const config: TriggerConfig = {
      triggers: [BASE_TRIGGER, badTrigger],
    };
    const issues = validateAllTriggers(config);

    // Only bad-trigger issues
    const badIssues = issues.filter((i) => i.triggerId === 'bad-trigger');
    expect(badIssues.length).toBeGreaterThan(0);

    // No base-trigger error issues
    const baseErrors = issues.filter((i) => i.triggerId === 'base-trigger' && i.severity === 'error');
    expect(baseErrors).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// executeWorktrainTriggerValidateCommand
// ═══════════════════════════════════════════════════════════════════════════

describe('executeWorktrainTriggerValidateCommand', () => {
  /** Build fake deps with injectable config result. Captures stdout/stderr/exit. */
  function makeDeps(
    configResult: Awaited<ReturnType<WorktrainTriggerValidateDeps['loadTriggerConfigFromFile']>>,
    configFilePath = '/fake/.workrail/triggers.yml',
  ): {
    deps: WorktrainTriggerValidateDeps;
    stdoutLines: string[];
    stderrLines: string[];
    exitCodes: number[];
  } {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const exitCodes: number[] = [];

    const deps: WorktrainTriggerValidateDeps = {
      loadTriggerConfigFromFile: async (_dirPath) => configResult,
      stdout: { write: (s) => { stdoutLines.push(s); } },
      stderr: { write: (s) => { stderrLines.push(s); } },
      exit: (code) => { exitCodes.push(code); throw new Error(`process.exit(${code})`); },
      configFilePath,
    };

    return { deps, stdoutLines, stderrLines, exitCodes };
  }

  it('exits 0 for a clean config with no issues', async () => {
    const config: TriggerConfig = { triggers: [BASE_TRIGGER] };
    const { deps, stdoutLines, exitCodes } = makeDeps({ kind: 'ok', value: config });

    await expect(executeWorktrainTriggerValidateCommand(deps)).rejects.toThrow('process.exit(0)');

    expect(exitCodes[0]).toBe(0);
    const output = stdoutLines.join('');
    expect(output).toContain('Trigger: base-trigger');
    expect(output).toContain('Status:       OK');
    expect(output).toContain('Summary:');
    expect(output).toContain('Exit code: 0');
  });

  it('exits 1 when a trigger has error-severity issues', async () => {
    const errorTrigger = makeTrigger({
      id: 'error-trigger' as TriggerDefinition['id'],
      autoCommit: true,
      branchStrategy: undefined,
    });
    const config: TriggerConfig = { triggers: [errorTrigger] };
    const { deps, stdoutLines, exitCodes } = makeDeps({ kind: 'ok', value: config });

    await expect(executeWorktrainTriggerValidateCommand(deps)).rejects.toThrow('process.exit(1)');

    expect(exitCodes[0]).toBe(1);
    const output = stdoutLines.join('');
    expect(output).toContain('[E]');
    expect(output).toContain('autocommit-needs-worktree');
    expect(output).toContain('Exit code: 1');
  });

  it('exits 0 when a trigger has only warnings (no errors)', async () => {
    // Trigger with only warning/info issues (no autoCommit, so no error)
    const warnTrigger = makeTrigger({
      id: 'warn-trigger' as TriggerDefinition['id'],
      agentConfig: undefined, // triggers missing-max-session-minutes (warning) and missing-max-turns (info)
    });
    const config: TriggerConfig = { triggers: [warnTrigger] };
    const { deps, stdoutLines, exitCodes } = makeDeps({ kind: 'ok', value: config });

    await expect(executeWorktrainTriggerValidateCommand(deps)).rejects.toThrow('process.exit(0)');

    expect(exitCodes[0]).toBe(0);
    const output = stdoutLines.join('');
    expect(output).toContain('[W]');
    expect(output).toContain('Exit code: 0');
  });

  it('exits 1 and writes to stderr when file not found', async () => {
    const { deps, stderrLines, exitCodes } = makeDeps({
      kind: 'err',
      error: { kind: 'file_not_found', filePath: '/fake/.workrail/triggers.yml' },
    });

    await expect(executeWorktrainTriggerValidateCommand(deps)).rejects.toThrow('process.exit(1)');

    expect(exitCodes[0]).toBe(1);
    const errOutput = stderrLines.join('');
    expect(errOutput).toContain('triggers.yml not found');
  });

  it('exits 1 and writes to stderr on parse error', async () => {
    const { deps, stderrLines, exitCodes } = makeDeps({
      kind: 'err',
      error: { kind: 'parse_error', message: 'Expected "triggers:" at line 1' },
    });

    await expect(executeWorktrainTriggerValidateCommand(deps)).rejects.toThrow('process.exit(1)');

    expect(exitCodes[0]).toBe(1);
    expect(stderrLines.join('')).toContain('Error:');
  });

  it('exits 0 for empty triggers.yml (no triggers)', async () => {
    const config: TriggerConfig = { triggers: [] };
    const { deps, stdoutLines, exitCodes } = makeDeps({ kind: 'ok', value: config });

    await expect(executeWorktrainTriggerValidateCommand(deps)).rejects.toThrow('process.exit(0)');

    expect(exitCodes[0]).toBe(0);
    const output = stdoutLines.join('');
    expect(output).toContain('No triggers found');
  });

  it('output includes per-trigger block with branch and delivery info', async () => {
    const trigger = makeTrigger({
      autoCommit: true,
      autoOpenPR: true,
      branchStrategy: 'worktree',
      baseBranch: 'main',
      branchPrefix: 'worktrain/',
    });
    const config: TriggerConfig = { triggers: [trigger] };
    const { deps, stdoutLines } = makeDeps({ kind: 'ok', value: config });

    await expect(executeWorktrainTriggerValidateCommand(deps)).rejects.toThrow('process.exit(0)');

    const output = stdoutLines.join('');
    expect(output).toContain('Delivery:');
    expect(output).toContain('autoCommit=true');
    expect(output).toContain('autoOpenPR=true');
    expect(output).toContain('Branch:');
    expect(output).toContain('worktree');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration: real triggers.yml YAML -> validateAllTriggers
// ═══════════════════════════════════════════════════════════════════════════

describe('integration: load and validate real YAML fixture', () => {
  it('clean triggers.yml with all fields produces no error-severity issues', () => {
    const yaml = `
triggers:
  - id: clean-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspacePath: /workspace
    goal: Review this PR
    branchStrategy: worktree
    baseBranch: main
    branchPrefix: "worktrain/"
    autoCommit: "true"
    autoOpenPR: "true"
    agentConfig:
      maxSessionMinutes: 60
      maxTurns: 50
`;
    const result = loadTriggerConfig(yaml, {});
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const issues = validateAllTriggers(result.value);
    const errors = issues.filter((i) => i.severity === 'error');
    expect(errors).toHaveLength(0);
  });
});
