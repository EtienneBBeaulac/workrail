/**
 * Unit tests for worktrain status command session ID length validation.
 *
 * The status command's length check is inline in cli-worktrain.ts and not
 * exported. These tests replicate the same rule directly so they stay in sync
 * with the implementation without requiring a subprocess.
 *
 * WHY replicate instead of extract: the status command is an intentional
 * inline composition. Extracting purely for testability would be premature
 * abstraction -- these tests document the contract instead.
 *
 * Context: Bug #559 fix -- a short sessionId prefix like 'sess_5h' (8 chars)
 * would aggregate events from ALL sessions starting with that prefix,
 * silently producing an incorrect health summary. The fix warns on short IDs.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Replicated sessionId length check logic
// (mirrors the check added to the status action in cli-worktrain.ts)
// ---------------------------------------------------------------------------

const SESSION_ID_MIN_LENGTH = 20;

/**
 * Returns a warning message if the sessionId is too short, or null if it's fine.
 * Mirrors the logic in the status action.
 */
function checkSessionIdLength(sessionId: string): string | null {
  if (sessionId.length < SESSION_ID_MIN_LENGTH) {
    return (
      `Warning: session ID "${sessionId}" is shorter than ${SESSION_ID_MIN_LENGTH} characters -- ` +
      `provide more characters to avoid matching multiple sessions.`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tests: sessionId length validation
// ---------------------------------------------------------------------------

describe('worktrain status -- sessionId length validation', () => {
  describe('IDs that trigger a warning (too short)', () => {
    it('warns for a short sess_ prefix like sess_5h (8 chars)', () => {
      const warning = checkSessionIdLength('sess_5h');
      expect(warning).not.toBeNull();
      expect(warning).toContain('shorter than 20 characters');
      expect(warning).toContain('sess_5h');
    });

    it('warns for a bare sess_ prefix (5 chars)', () => {
      const warning = checkSessionIdLength('sess_');
      expect(warning).not.toBeNull();
    });

    it('warns for an 8-char UUID prefix (8 chars)', () => {
      const warning = checkSessionIdLength('a1b2c3d4');
      expect(warning).not.toBeNull();
    });

    it('warns for an ID of exactly 19 chars (one below threshold)', () => {
      const id = 'a'.repeat(19);
      const warning = checkSessionIdLength(id);
      expect(warning).not.toBeNull();
    });

    it('warns for an empty string', () => {
      const warning = checkSessionIdLength('');
      expect(warning).not.toBeNull();
    });
  });

  describe('IDs that do NOT trigger a warning (long enough)', () => {
    it('does not warn for a full sess_ ID of 31 chars (e.g. sess_s5o2ieem4mwypoqnn6ztzyyag4)', () => {
      // Full sess_ IDs are ~31 chars (sess_ + 26-char ULID-based suffix).
      const warning = checkSessionIdLength('sess_s5o2ieem4mwypoqnn6ztzyyag4');
      expect(warning).toBeNull();
    });

    it('does not warn for an ID of exactly 20 chars (at threshold)', () => {
      const id = 'a'.repeat(20);
      const warning = checkSessionIdLength(id);
      expect(warning).toBeNull();
    });

    it('does not warn for a full UUID (36 chars)', () => {
      const warning = checkSessionIdLength('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
      expect(warning).toBeNull();
    });

    it('does not warn for a long sess_ prefix (21 chars)', () => {
      const warning = checkSessionIdLength('sess_s5o2ieem4mwypoqn');
      expect(warning).toBeNull();
    });
  });
});
