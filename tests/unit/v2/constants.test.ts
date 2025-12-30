import { describe, it, expect } from 'vitest';
import * as constants from '../../../src/v2/durable-core/constants.js';

/**
 * Constants module invariants.
 * 
 * Purpose:
 * - Verify all locked constants are exported
 * - Ensure no accidental modifications
 * - Document expected values for regression
 * 
 * Lock: docs/design/v2-core-design-locks.md Section 16.5 Sub-phase A
 */

describe('v2 constants module', () => {
  it('exports all locked budget constants', () => {
    const required = [
      'MAX_BLOCKERS',
      'MAX_BLOCKER_MESSAGE_BYTES',
      'MAX_BLOCKER_SUGGESTED_FIX_BYTES',
      'MAX_DECISION_TRACE_ENTRIES',
      'MAX_DECISION_TRACE_ENTRY_SUMMARY_BYTES',
      'MAX_DECISION_TRACE_TOTAL_BYTES',
      'MAX_OUTPUT_NOTES_MARKDOWN_BYTES',
      'MAX_CONTEXT_BYTES',
      'MAX_CONTEXT_DEPTH',
      'MAX_OBSERVATION_SHORT_STRING_LENGTH',
      'SESSION_LOCK_RETRY_AFTER_MS',
      'DEFAULT_RETRY_AFTER_MS',
      'TRUNCATION_MARKER',
      'SHA256_DIGEST_PATTERN',
      'DELIMITER_SAFE_ID_PATTERN',
    ];

    const exported = Object.keys(constants);
    for (const name of required) {
      expect(exported, `Missing constant: ${name}`).toContain(name);
    }
  });

  it('locked budget values match design doc', () => {
    expect(constants.MAX_BLOCKERS).toBe(10);
    expect(constants.MAX_BLOCKER_MESSAGE_BYTES).toBe(512);
    expect(constants.MAX_BLOCKER_SUGGESTED_FIX_BYTES).toBe(1024);
    expect(constants.MAX_DECISION_TRACE_ENTRIES).toBe(25);
    expect(constants.MAX_DECISION_TRACE_ENTRY_SUMMARY_BYTES).toBe(512);
    expect(constants.MAX_DECISION_TRACE_TOTAL_BYTES).toBe(8192);
    expect(constants.MAX_OUTPUT_NOTES_MARKDOWN_BYTES).toBe(4096);
    expect(constants.MAX_CONTEXT_BYTES).toBe(256 * 1024);
    expect(constants.MAX_CONTEXT_DEPTH).toBe(64);
    expect(constants.MAX_OBSERVATION_SHORT_STRING_LENGTH).toBe(80);
  });

  it('retry timing constants are reasonable', () => {
    expect(constants.SESSION_LOCK_RETRY_AFTER_MS).toBeGreaterThanOrEqual(100);
    expect(constants.SESSION_LOCK_RETRY_AFTER_MS).toBeLessThanOrEqual(5000);
    expect(constants.DEFAULT_RETRY_AFTER_MS).toBe(1000);
  });

  it('truncation marker is canonical', () => {
    expect(constants.TRUNCATION_MARKER).toBe('\n\n[TRUNCATED]');
    expect(constants.TRUNCATION_MARKER.length).toBe(13);
  });

  it('regex patterns are valid', () => {
    expect(constants.SHA256_DIGEST_PATTERN).toBeInstanceOf(RegExp);
    expect(constants.SHA256_DIGEST_PATTERN.test('sha256:' + 'a'.repeat(64))).toBe(true);
    expect(constants.SHA256_DIGEST_PATTERN.test('sha256:' + 'A'.repeat(64))).toBe(false);
    expect(constants.SHA256_DIGEST_PATTERN.test('sha256:' + 'a'.repeat(63))).toBe(false);
    
    expect(constants.DELIMITER_SAFE_ID_PATTERN).toBeInstanceOf(RegExp);
    expect(constants.DELIMITER_SAFE_ID_PATTERN.test('valid_id-123')).toBe(true);
    expect(constants.DELIMITER_SAFE_ID_PATTERN.test('Invalid@Id')).toBe(false);
    expect(constants.DELIMITER_SAFE_ID_PATTERN.test('invalid::id')).toBe(false);
    expect(constants.DELIMITER_SAFE_ID_PATTERN.test('invalid/id')).toBe(false);
  });
});
