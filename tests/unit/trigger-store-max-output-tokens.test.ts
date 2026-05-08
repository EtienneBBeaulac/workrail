/**
 * Unit tests for maxOutputTokens parsing in trigger-store.ts.
 *
 * Strategy: pass real YAML strings to loadTriggerConfig() (pure function, no I/O).
 * Follows the pattern established in tests/unit/trigger-store-gap8.test.ts.
 *
 * Coverage:
 * - maxOutputTokens parses to a number
 * - maxOutputTokens together with existing agentConfig fields
 * - invalid (non-numeric) maxOutputTokens rejects trigger
 * - negative maxOutputTokens rejects trigger
 * - zero maxOutputTokens rejects trigger (must be positive)
 * - missing maxOutputTokens -- trigger is still valid (default 8192 applies at runtime)
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
    workflowId: wr.coding-task
    workspacePath: /path/to/repo
    goal: Run workflow
`;

const WITH_MAX_OUTPUT_TOKENS = `
triggers:
  - id: test-trigger
    provider: generic
    workflowId: wr.coding-task
    workspacePath: /path/to/repo
    goal: Run workflow
    agentConfig:
      maxOutputTokens: 32768
`;

const WITH_ALL_AGENT_CONFIG = `
triggers:
  - id: test-trigger
    provider: generic
    workflowId: wr.coding-task
    workspacePath: /path/to/repo
    goal: Run workflow
    agentConfig:
      model: amazon-bedrock/claude-sonnet-4-6
      maxSessionMinutes: 60
      maxTurns: 100
      maxOutputTokens: 64000
`;

const WITH_INVALID_ALPHA = `
triggers:
  - id: test-trigger
    provider: generic
    workflowId: wr.coding-task
    workspacePath: /path/to/repo
    goal: Run workflow
    agentConfig:
      maxOutputTokens: not-a-number
`;

const WITH_NEGATIVE = `
triggers:
  - id: test-trigger
    provider: generic
    workflowId: wr.coding-task
    workspacePath: /path/to/repo
    goal: Run workflow
    agentConfig:
      maxOutputTokens: -1
`;

const WITH_ZERO = `
triggers:
  - id: test-trigger
    provider: generic
    workflowId: wr.coding-task
    workspacePath: /path/to/repo
    goal: Run workflow
    agentConfig:
      maxOutputTokens: 0
`;

const WITH_FLOAT = `
triggers:
  - id: test-trigger
    provider: generic
    workflowId: wr.coding-task
    workspacePath: /path/to/repo
    goal: Run workflow
    agentConfig:
      maxOutputTokens: 8192.5
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('trigger-store.ts -- maxOutputTokens parsing', () => {
  it('parses maxOutputTokens as a number', () => {
    const result = loadTriggerConfig(WITH_MAX_OUTPUT_TOKENS);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const trigger = result.value.triggers[0];
    expect(trigger).toBeDefined();
    expect(trigger!.agentConfig?.maxOutputTokens).toBe(32768);
    expect(typeof trigger!.agentConfig?.maxOutputTokens).toBe('number');
  });

  it('parses model, maxSessionMinutes, maxTurns, and maxOutputTokens together', () => {
    const result = loadTriggerConfig(WITH_ALL_AGENT_CONFIG);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const trigger = result.value.triggers[0];
    expect(trigger).toBeDefined();
    expect(trigger!.agentConfig?.model).toBe('amazon-bedrock/claude-sonnet-4-6');
    expect(trigger!.agentConfig?.maxSessionMinutes).toBe(60);
    expect(trigger!.agentConfig?.maxTurns).toBe(100);
    expect(trigger!.agentConfig?.maxOutputTokens).toBe(64000);
  });

  it('rejects trigger when maxOutputTokens is non-numeric', () => {
    const result = loadTriggerConfig(WITH_INVALID_ALPHA);
    // loadTriggerConfig logs a warning and skips invalid triggers; result is ok
    // but with 0 valid triggers (invalid trigger is skipped).
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.triggers).toHaveLength(0);
  });

  it('rejects trigger when maxOutputTokens is negative', () => {
    const result = loadTriggerConfig(WITH_NEGATIVE);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.triggers).toHaveLength(0);
  });

  it('rejects trigger when maxOutputTokens is zero', () => {
    const result = loadTriggerConfig(WITH_ZERO);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.triggers).toHaveLength(0);
  });

  it('rejects trigger when maxOutputTokens is a float', () => {
    const result = loadTriggerConfig(WITH_FLOAT);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.triggers).toHaveLength(0);
  });

  it('trigger without maxOutputTokens is still valid', () => {
    const result = loadTriggerConfig(BASE);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const trigger = result.value.triggers[0];
    expect(trigger).toBeDefined();
    expect(trigger!.agentConfig).toBeUndefined();
  });

  it('maxOutputTokens absent means agentConfig.maxOutputTokens is undefined', () => {
    // When maxOutputTokens is absent (but other agentConfig fields present),
    // maxOutputTokens should be undefined -- runtime default (8192) applies.
    const yaml = `
triggers:
  - id: test-trigger
    provider: generic
    workflowId: wr.coding-task
    workspacePath: /path/to/repo
    goal: Run workflow
    agentConfig:
      maxSessionMinutes: 30
`;
    const result = loadTriggerConfig(yaml);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    const trigger = result.value.triggers[0];
    expect(trigger).toBeDefined();
    expect(trigger!.agentConfig?.maxSessionMinutes).toBe(30);
    expect(trigger!.agentConfig?.maxOutputTokens).toBeUndefined();
  });
});
