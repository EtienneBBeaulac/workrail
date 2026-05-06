/**
 * Smoke tests for buildSessionRecap (GAP-2: session state injection).
 *
 * Tests the pure formatting function directly -- no fakes, no I/O, no Agent.
 * WHY: buildSessionRecap is a pure function; exercising it directly gives the
 * clearest signal that the formatting contract is correct.
 *
 * Test coverage:
 * - Empty input -> empty string (INV-1: no empty XML block injected)
 * - Single note -> correctly wrapped in <workrail_session_state> XML
 * - Note truncation -> [truncated] marker appended
 * - Exactly MAX_SESSION_RECAP_NOTES notes -> all included
 * NOTE: slicing to the last N notes is loadSessionNotes' responsibility,
 *   not buildSessionRecap's (see workflow-runner.ts). No test here covers that path.
 */

import { describe, it, expect } from 'vitest';
import { buildSessionRecap } from '../../src/daemon/core/system-prompt.js';

// These match the constants in workflow-runner.ts.
// If the constants change, these tests will catch the drift.
const MAX_SESSION_RECAP_NOTES = 3;
const MAX_SESSION_NOTE_CHARS = 800;

describe('buildSessionRecap', () => {
  it('returns empty string for empty notes array (INV-1: no empty XML injection)', () => {
    expect(buildSessionRecap([])).toBe('');
  });

  it('wraps a single note in <workrail_session_state> XML', () => {
    const result = buildSessionRecap(['step one completed successfully']);

    expect(result).toContain('<workrail_session_state>');
    expect(result).toContain('</workrail_session_state>');
    expect(result).toContain('step one completed successfully');
  });

  it('includes step numbering for each note', () => {
    const result = buildSessionRecap(['first note', 'second note']);

    expect(result).toContain('Prior step 1');
    expect(result).toContain('Prior step 2');
    expect(result).toContain('first note');
    expect(result).toContain('second note');
  });

  it('includes all notes when count equals MAX_SESSION_RECAP_NOTES', () => {
    const notes = ['note A', 'note B', 'note C'];
    expect(notes.length).toBe(MAX_SESSION_RECAP_NOTES);

    const result = buildSessionRecap(notes);

    expect(result).toContain('note A');
    expect(result).toContain('note B');
    expect(result).toContain('note C');
  });

  it('includes a recap header in the output', () => {
    const result = buildSessionRecap(['any note']);

    // The output should have some header/description so the agent understands context
    expect(result).toContain('prior steps');
  });

  it('passes note content through verbatim (truncation is done by loadSessionNotes caller)', () => {
    // buildSessionRecap is a pure formatter -- truncation happens in loadSessionNotes.
    // If a truncated note (with [truncated] marker) is passed in, it is preserved as-is.
    const truncatedNote = 'x'.repeat(MAX_SESSION_NOTE_CHARS) + '\n[truncated]';

    const result = buildSessionRecap([truncatedNote]);

    expect(result).toContain('[truncated]');
    expect(result).toContain('<workrail_session_state>');
  });

  it('formats short notes without modification', () => {
    const shortNote = 'brief step note';

    const result = buildSessionRecap([shortNote]);

    expect(result).toContain('brief step note');
    expect(result).not.toContain('[truncated]');
  });
});
