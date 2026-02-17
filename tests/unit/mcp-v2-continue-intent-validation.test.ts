/**
 * Boundary validation tests for V2ContinueWorkflowInput intent discriminant.
 *
 * These tests validate the Zod schema boundary — the first line of defense
 * against invalid agent calls. They verify:
 * - Unknown keys are rejected (.strict())
 * - Missing intent is rejected
 * - Cross-field constraints are enforced (intent + ackToken agreement)
 * - Error messages are agent-actionable (self-correcting)
 */
import { describe, expect, it } from 'vitest';
import { V2ContinueWorkflowInput } from '../../src/mcp/v2/tools.js';

describe('V2ContinueWorkflowInput boundary validation', () => {
  // ── Happy paths ──────────────────────────────────────────────────

  it('accepts valid advance input', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      intent: 'advance',
      stateToken: 'st1abc',
      ackToken: 'ack1abc',
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid advance input with output', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      intent: 'advance',
      stateToken: 'st1abc',
      ackToken: 'ack1abc',
      output: { notesMarkdown: 'Completed phase 1.' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid rehydrate input', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      intent: 'rehydrate',
      stateToken: 'st1abc',
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid rehydrate input with context', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      intent: 'rehydrate',
      stateToken: 'st1abc',
      context: { branch: 'main' },
    });
    expect(result.success).toBe(true);
  });

  // ── Unknown keys rejected (.strict()) ────────────────────────────

  it('rejects unknown key "completedStep"', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      intent: 'advance',
      stateToken: 'st1abc',
      ackToken: 'ack1abc',
      completedStep: 'phase-0-setup',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.errors.map((e) => e.message);
      expect(messages.some((m) => m.includes('Unrecognized key'))).toBe(true);
    }
  });

  it('rejects unknown key "completed_step"', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      intent: 'rehydrate',
      stateToken: 'st1abc',
      completed_step: 'phase-0-setup',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.errors.map((e) => e.message);
      expect(messages.some((m) => m.includes('Unrecognized key'))).toBe(true);
    }
  });

  it('rejects unknown key "step"', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      intent: 'advance',
      stateToken: 'st1abc',
      ackToken: 'ack1abc',
      step: 'next',
    });
    expect(result.success).toBe(false);
  });

  // ── Missing intent ───────────────────────────────────────────────

  it('rejects input without intent field', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      stateToken: 'st1abc',
      ackToken: 'ack1abc',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const intentError = result.error.errors.find((e) => e.path.includes('intent'));
      expect(intentError).toBeDefined();
    }
  });

  // ── Invalid intent value ─────────────────────────────────────────

  it('rejects invalid intent value', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      intent: 'complete',
      stateToken: 'st1abc',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const intentError = result.error.errors.find((e) => e.path.includes('intent'));
      expect(intentError).toBeDefined();
    }
  });

  it('rejects intent value "next"', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      intent: 'next',
      stateToken: 'st1abc',
      ackToken: 'ack1abc',
    });
    expect(result.success).toBe(false);
  });

  // ── Cross-field: advance without ackToken ────────────────────────

  it('rejects advance without ackToken with self-correcting message', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      intent: 'advance',
      stateToken: 'st1abc',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const ackError = result.error.errors.find((e) => e.path.includes('ackToken'));
      expect(ackError).toBeDefined();
      expect(ackError!.message).toContain('intent is "advance" but ackToken is missing');
      expect(ackError!.message).toContain('set intent to "rehydrate"');
    }
  });

  // ── Cross-field: rehydrate with ackToken ─────────────────────────

  it('rejects rehydrate with ackToken with self-correcting message', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      intent: 'rehydrate',
      stateToken: 'st1abc',
      ackToken: 'ack1abc',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const ackError = result.error.errors.find((e) => e.path.includes('ackToken'));
      expect(ackError).toBeDefined();
      expect(ackError!.message).toContain('intent is "rehydrate" but ackToken was provided');
      expect(ackError!.message).toContain('set intent to "advance"');
    }
  });

  // ── Cross-field: rehydrate with output ───────────────────────────

  it('rejects rehydrate with output with self-correcting message', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      intent: 'rehydrate',
      stateToken: 'st1abc',
      output: { notesMarkdown: 'some notes' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const outputError = result.error.errors.find((e) => e.path.includes('output'));
      expect(outputError).toBeDefined();
      expect(outputError!.message).toContain('intent is "rehydrate" but output was provided');
      expect(outputError!.message).toContain('set intent to "advance"');
    }
  });

  // ── Missing stateToken ───────────────────────────────────────────

  it('rejects input without stateToken', () => {
    const result = V2ContinueWorkflowInput.safeParse({
      intent: 'rehydrate',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const stateError = result.error.errors.find((e) => e.path.includes('stateToken'));
      expect(stateError).toBeDefined();
    }
  });
});
