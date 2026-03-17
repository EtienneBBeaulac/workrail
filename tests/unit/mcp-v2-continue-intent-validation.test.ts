/**
 * Boundary validation tests for V2ContinueWorkflowInput.
 *
 * These tests validate the Zod schema boundary — the first line of defense
 * against invalid agent calls. They verify:
 * - continueToken is required
 * - Unknown keys are rejected (.strict())
 * - Intent auto-inference works correctly
 * - Cross-field constraints are enforced
 * - Error messages are agent-actionable (self-correcting)
 */
import { describe, expect, it } from 'vitest';
import { V2ContinueWorkflowInput } from '../../src/mcp/v2/tools.js';

describe('V2ContinueWorkflowInput boundary validation', () => {
  // ── Happy paths ──────────────────────────────────────────────────

  it('accepts valid advance input with continueToken and output', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      continueToken: 'ct_abc123',
      output: { notesMarkdown: 'Completed phase 1.' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.intent).toBe('advance');
      expect(result.data.continueToken).toBe('ct_abc123');
    }
  });

  it('accepts valid rehydrate input (no output)', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      continueToken: 'ct_abc123',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.intent).toBe('rehydrate');
    }
  });

  it('accepts valid rehydrate input with context', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      continueToken: 'ct_abc123',
      context: { branch: 'main' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.intent).toBe('rehydrate');
      expect(result.data.context).toEqual({ branch: 'main' });
    }
  });

  it('accepts explicit advance intent', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      continueToken: 'ct_abc123',
      intent: 'advance',
      output: { notesMarkdown: 'Done.' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.intent).toBe('advance');
    }
  });

  it('accepts explicit rehydrate intent', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      continueToken: 'ct_abc123',
      intent: 'rehydrate',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.intent).toBe('rehydrate');
    }
  });

  // ── Unknown keys rejected (.strict()) ────────────────────────────

  it('rejects unknown key "completedStep"', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      continueToken: 'ct_abc123',
      completedStep: 'phase-0-setup',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.errors.map((e) => e.message);
      expect(messages.some((m) => m.includes('Unrecognized key'))).toBe(true);
    }
  });

  it('rejects unknown key "stateToken"', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      continueToken: 'ct_abc123',
      stateToken: 'st1test',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.errors.map((e) => e.message);
      expect(messages.some((m) => m.includes('Unrecognized key'))).toBe(true);
    }
  });

  it('rejects unknown key "ackToken"', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      continueToken: 'ct_abc123',
      ackToken: 'ack1test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown key "nextToken"', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      continueToken: 'ct_abc123',
      nextToken: 'ack1abc',
    });
    expect(result.success).toBe(false);
  });

  // ── Intent auto-inference ───────────────────────────────────────

  it('auto-infers advance when output present', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      continueToken: 'ct_abc123',
      output: { notesMarkdown: 'Done.' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.intent).toBe('advance');
    }
  });

  it('auto-infers rehydrate when output absent', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      continueToken: 'ct_abc123',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.intent).toBe('rehydrate');
    }
  });

  // ── Invalid intent value ─────────────────────────────────────────

  it('rejects invalid intent value', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      continueToken: 'ct_abc123',
      intent: 'complete',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const intentError = result.error.errors.find((e) => e.path.includes('intent'));
      expect(intentError).toBeDefined();
    }
  });

  // ── Cross-field: rehydrate with output ───────────────────────────

  it('rejects rehydrate with output with self-correcting message', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      continueToken: 'ct_abc123',
      intent: 'rehydrate',
      output: { notesMarkdown: 'some notes' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const outputError = result.error.errors.find((e) => e.path.includes('output'));
      expect(outputError).toBeDefined();
      expect(outputError!.message).toContain('intent is "rehydrate" but output was provided');
    }
  });

  // ── Missing continueToken ────────────────────────────────────────

  it('rejects input without continueToken', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      intent: 'rehydrate',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty continueToken', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      continueToken: '',
    });
    expect(result.success).toBe(false);
  });
});
