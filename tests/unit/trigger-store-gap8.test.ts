/**
 * Unit tests for GAP-8: maxSessionMinutes and maxTurns parsing in trigger-store.ts.
 *
 * Strategy: pass real YAML strings to loadTriggerConfig() (pure function, no I/O).
 * Follows the pattern established in tests/unit/trigger-store.test.ts.
 *
 * Coverage:
 * - maxSessionMinutes parses to a number
 * - maxTurns parses to a number
 * - both together
 * - invalid (non-numeric) maxSessionMinutes rejects trigger
 * - invalid (non-numeric) maxTurns rejects trigger
 * - negative maxSessionMinutes rejects trigger
 * - zero maxSessionMinutes rejects trigger (must be positive)
 * - zero maxTurns rejects trigger (must be positive)
 * - missing maxSessionMinutes and maxTurns -- trigger is still valid
 * - values propagate to TriggerDefinition.agentConfig
 */

import { describe, expect, it } from 'vitest';
import { loadTriggerConfig } from '../../src/trigger/trigger-store.js';

// ---------------------------------------------------------------------------
// YAML fixtures
// ---------------------------------------------------------------------------

const BASE = `
triggers:
  - id: test-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspacePath: /path/to/repo
    goal: Run workflow
`;

const WITH_MAX_SESSION_MINUTES = `
triggers:
  - id: test-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspacePath: /path/to/repo
    goal: Run workflow
    agentConfig:
      maxSessionMinutes: 45
`;

const WITH_MAX_TURNS = `
triggers:
  - id: test-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspacePath: /path/to/repo
    goal: Run workflow
    agentConfig:
      maxTurns: 20
`;

const WITH_BOTH = `
triggers:
  - id: test-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspacePath: /path/to/repo
    goal: Run workflow
    agentConfig:
      model: amazon-bedrock/claude-sonnet-4-6
      maxSessionMinutes: 60
      maxTurns: 50
`;

const WITH_INVALID_MAX_SESSION_MINUTES_ALPHA = `
triggers:
  - id: test-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspacePath: /path/to/repo
    goal: Run workflow
    agentConfig:
      maxSessionMinutes: abc
`;

const WITH_INVALID_MAX_TURNS_ALPHA = `
triggers:
  - id: test-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspacePath: /path/to/repo
    goal: Run workflow
    agentConfig:
      maxTurns: not-a-number
`;

const WITH_NEGATIVE_MAX_SESSION_MINUTES = `
triggers:
  - id: test-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspacePath: /path/to/repo
    goal: Run workflow
    agentConfig:
      maxSessionMinutes: -5
`;

const WITH_ZERO_MAX_SESSION_MINUTES = `
triggers:
  - id: test-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspacePath: /path/to/repo
    goal: Run workflow
    agentConfig:
      maxSessionMinutes: 0
`;

const WITH_ZERO_MAX_TURNS = `
triggers:
  - id: test-trigger
    provider: generic
    workflowId: coding-task-workflow-agentic
    workspacePath: /path/to/repo
    goal: Run workflow
    agentConfig:
      maxTurns: 0
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('trigger-store.ts -- GAP-8 agentConfig limits', () => {
  describe('maxSessionMinutes', () => {
    it('parses maxSessionMinutes as a number', () => {
      const result = loadTriggerConfig(WITH_MAX_SESSION_MINUTES);
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;

      const trigger = result.value.triggers[0];
      expect(trigger).toBeDefined();
      expect(trigger!.agentConfig?.maxSessionMinutes).toBe(45);
      expect(typeof trigger!.agentConfig?.maxSessionMinutes).toBe('number');
    });

    it('rejects trigger when maxSessionMinutes is non-numeric', () => {
      const result = loadTriggerConfig(WITH_INVALID_MAX_SESSION_MINUTES_ALPHA);
      // loadTriggerConfig logs a warning and skips invalid triggers; the result is ok
      // but with 0 valid triggers (invalid trigger is skipped).
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers).toHaveLength(0);
    });

    it('rejects trigger when maxSessionMinutes is negative', () => {
      const result = loadTriggerConfig(WITH_NEGATIVE_MAX_SESSION_MINUTES);
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers).toHaveLength(0);
    });

    it('rejects trigger when maxSessionMinutes is zero', () => {
      const result = loadTriggerConfig(WITH_ZERO_MAX_SESSION_MINUTES);
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers).toHaveLength(0);
    });
  });

  describe('maxTurns', () => {
    it('parses maxTurns as a number', () => {
      const result = loadTriggerConfig(WITH_MAX_TURNS);
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;

      const trigger = result.value.triggers[0];
      expect(trigger).toBeDefined();
      expect(trigger!.agentConfig?.maxTurns).toBe(20);
      expect(typeof trigger!.agentConfig?.maxTurns).toBe('number');
    });

    it('rejects trigger when maxTurns is non-numeric', () => {
      const result = loadTriggerConfig(WITH_INVALID_MAX_TURNS_ALPHA);
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers).toHaveLength(0);
    });

    it('rejects trigger when maxTurns is zero', () => {
      const result = loadTriggerConfig(WITH_ZERO_MAX_TURNS);
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;
      expect(result.value.triggers).toHaveLength(0);
    });
  });

  describe('combined', () => {
    it('parses model, maxSessionMinutes, and maxTurns together', () => {
      const result = loadTriggerConfig(WITH_BOTH);
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;

      const trigger = result.value.triggers[0];
      expect(trigger).toBeDefined();
      expect(trigger!.agentConfig?.model).toBe('amazon-bedrock/claude-sonnet-4-6');
      expect(trigger!.agentConfig?.maxSessionMinutes).toBe(60);
      expect(trigger!.agentConfig?.maxTurns).toBe(50);
    });

    it('trigger without agentConfig limits is still valid', () => {
      const result = loadTriggerConfig(BASE);
      expect(result.kind).toBe('ok');
      if (result.kind !== 'ok') return;

      const trigger = result.value.triggers[0];
      expect(trigger).toBeDefined();
      expect(trigger!.agentConfig).toBeUndefined();
    });
  });
});
