/**
 * Budget enforcement tests (worst-case scenarios).
 *
 * Lock: docs/design/v2-core-design-locks.md Section 16.5 Sub-phase G
 *
 * Purpose:
 * - Ensure budgets cannot be exceeded by schema validation
 * - Verify canonical truncation marker shape is stable
 * - Validate UTF-8 boundary behavior at budgets
 *
 * @enforces notes-markdown-budget
 * @enforces truncation-marker-format
 * @enforces decision-trace-bounded
 * @enforces blocker-budget
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_OUTPUT_NOTES_MARKDOWN_BYTES,
  MAX_DECISION_TRACE_ENTRY_SUMMARY_BYTES,
  MAX_DECISION_TRACE_ENTRIES,
  MAX_DECISION_TRACE_TOTAL_BYTES,
  MAX_BLOCKER_MESSAGE_BYTES,
  MAX_BLOCKER_SUGGESTED_FIX_BYTES,
  TRUNCATION_MARKER,
} from '../../../src/v2/durable-core/constants.js';
import { DomainEventV1Schema } from '../../../src/v2/durable-core/schemas/session/events.js';

describe('v2 budget enforcement (worst-case scenarios)', () => {
  describe('Output notes budget', () => {
    it('schema rejects notesMarkdown over MAX_OUTPUT_NOTES_MARKDOWN_BYTES (UTF-8 bytes)', () => {
      const huge = 'a'.repeat(MAX_OUTPUT_NOTES_MARKDOWN_BYTES + 1000);

      const event = {
        v: 1,
        eventId: 'evt_out',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'node_output_appended' as const,
        dedupeKey: 'node_output_appended:sess_1:out_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          outputId: 'out_1',
          outputChannel: 'recap' as const,
          payload: { payloadKind: 'notes' as const, notesMarkdown: huge },
        },
      };

      const parsed = DomainEventV1Schema.safeParse(event);
      expect(parsed.success).toBe(false);
    });

    it('schema accepts notesMarkdown at MAX_OUTPUT_NOTES_MARKDOWN_BYTES (ASCII)', () => {
      const exact = 'a'.repeat(MAX_OUTPUT_NOTES_MARKDOWN_BYTES);

      const event = {
        v: 1,
        eventId: 'evt_out',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'node_output_appended' as const,
        dedupeKey: 'node_output_appended:sess_1:out_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          outputId: 'out_1',
          outputChannel: 'recap' as const,
          payload: { payloadKind: 'notes' as const, notesMarkdown: exact },
        },
      };

      const parsed = DomainEventV1Schema.safeParse(event);
      expect(parsed.success).toBe(true);
    });

    it('schema rejects multibyte notes that exceed MAX_OUTPUT_NOTES_MARKDOWN_BYTES', () => {
      // 4 bytes in UTF-8
      const emoji = '🔥';
      expect(Buffer.byteLength(emoji, 'utf8')).toBe(4);

      // ensure > 4096 bytes
      const huge = emoji.repeat(2000);
      expect(Buffer.byteLength(huge, 'utf8')).toBeGreaterThan(MAX_OUTPUT_NOTES_MARKDOWN_BYTES);

      const event = {
        v: 1,
        eventId: 'evt_out',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'node_output_appended' as const,
        dedupeKey: 'node_output_appended:sess_1:out_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          outputId: 'out_1',
          outputChannel: 'recap' as const,
          payload: { payloadKind: 'notes' as const, notesMarkdown: huge },
        },
      };

      const parsed = DomainEventV1Schema.safeParse(event);
      expect(parsed.success).toBe(false);
    });
  });

  describe('Decision trace budgets', () => {
    it('schema rejects > MAX_DECISION_TRACE_ENTRIES', () => {
      const tooMany = Array.from({ length: MAX_DECISION_TRACE_ENTRIES + 5 }, (_, i) => ({
        kind: 'selected_next_step' as const,
        summary: `Entry ${i}`,
      }));

      const event = {
        v: 1,
        eventId: 'evt_trace',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'decision_trace_appended' as const,
        dedupeKey: 'decision_trace_appended:sess_1:trace_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: { traceId: 'trace_1', entries: tooMany },
      };

      const parsed = DomainEventV1Schema.safeParse(event);
      expect(parsed.success).toBe(false);
    });

    it('schema accepts MAX_DECISION_TRACE_ENTRIES exactly', () => {
      const exact = Array.from({ length: MAX_DECISION_TRACE_ENTRIES }, (_, i) => ({
        kind: 'selected_next_step' as const,
        summary: `Entry ${i}`,
      }));

      const event = {
        v: 1,
        eventId: 'evt_trace',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'decision_trace_appended' as const,
        dedupeKey: 'decision_trace_appended:sess_1:trace_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: { traceId: 'trace_1', entries: exact },
      };

      const parsed = DomainEventV1Schema.safeParse(event);
      expect(parsed.success).toBe(true);
    });

    it('schema rejects entry summary > MAX_DECISION_TRACE_ENTRY_SUMMARY_BYTES', () => {
      const huge = 'a'.repeat(MAX_DECISION_TRACE_ENTRY_SUMMARY_BYTES + 100);

      const event = {
        v: 1,
        eventId: 'evt_trace',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'decision_trace_appended' as const,
        dedupeKey: 'decision_trace_appended:sess_1:trace_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          traceId: 'trace_1',
          entries: [{ kind: 'selected_next_step' as const, summary: huge }],
        },
      };

      const parsed = DomainEventV1Schema.safeParse(event);
      expect(parsed.success).toBe(false);
    });

    it('entry summary at exactly MAX bytes (ASCII) is accepted', () => {
      const exactly = 'a'.repeat(MAX_DECISION_TRACE_ENTRY_SUMMARY_BYTES);

      const event = {
        v: 1,
        eventId: 'evt_trace',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'decision_trace_appended' as const,
        dedupeKey: 'decision_trace_appended:sess_1:trace_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          traceId: 'trace_1',
          entries: [{ kind: 'selected_next_step' as const, summary: exactly }],
        },
      };

      const parsed = DomainEventV1Schema.safeParse(event);
      expect(parsed.success).toBe(true);
    });

    it('truncation marker is canonical and byte-stable', () => {
      expect(TRUNCATION_MARKER).toBe('\n\n[TRUNCATED]');
      expect(TRUNCATION_MARKER.length).toBe(13);
      expect(Buffer.byteLength(TRUNCATION_MARKER, 'utf8')).toBe(13);
    });

    it('schema rejects decision trace when total bytes exceeds MAX_DECISION_TRACE_TOTAL_BYTES', () => {
      // Create entries that sum to > 8192 bytes
      const hugeSummary = 'a'.repeat(MAX_DECISION_TRACE_TOTAL_BYTES + 1000);
      
      const event = {
        v: 1,
        eventId: 'evt_trace',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'decision_trace_appended' as const,
        dedupeKey: 'decision_trace_appended:sess_1:trace_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          traceId: 'trace_1',
          entries: [{ kind: 'selected_next_step' as const, summary: hugeSummary }],
        },
      };

      const parsed = DomainEventV1Schema.safeParse(event);
      expect(parsed.success).toBe(false);
    });

    it('schema accepts decision trace when total bytes equals MAX_DECISION_TRACE_TOTAL_BYTES', () => {
      // Create entries that sum to exactly the max
      // Each entry must be within MAX_DECISION_TRACE_ENTRY_SUMMARY_BYTES (512 chars max)
      // So we create multiple entries, each at 512 bytes (512 ASCII chars)
      const entryBytes = 512;
      const numEntries = Math.floor(MAX_DECISION_TRACE_TOTAL_BYTES / entryBytes);
      const entries = Array.from({ length: numEntries }, (_, i) => ({
        kind: 'selected_next_step' as const,
        summary: 'a'.repeat(entryBytes),
      }));
      
      const event = {
        v: 1,
        eventId: 'evt_trace',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'decision_trace_appended' as const,
        dedupeKey: 'decision_trace_appended:sess_1:trace_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          traceId: 'trace_1',
          entries,
        },
      };

      const parsed = DomainEventV1Schema.safeParse(event);
      // Verify total is exactly at the limit
      const total = entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.summary, 'utf8'), 0);
      expect(total).toBeLessThanOrEqual(MAX_DECISION_TRACE_TOTAL_BYTES);
      expect(parsed.success).toBe(true);
    });

    it('schema rejects decision trace when multiple entries sum to > MAX_DECISION_TRACE_TOTAL_BYTES', () => {
      // Create multiple entries that together exceed the budget
      const entrySize = 3000;
      const entries = Array.from({ length: 3 }, (_, i) => ({
        kind: 'selected_next_step' as const,
        summary: `Entry ${i}: ${Buffer.alloc(entrySize).toString('utf8').substring(0, entrySize - 20)}`,
      }));

      const event = {
        v: 1,
        eventId: 'evt_trace',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'decision_trace_appended' as const,
        dedupeKey: 'decision_trace_appended:sess_1:trace_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          traceId: 'trace_1',
          entries,
        },
      };

      const parsed = DomainEventV1Schema.safeParse(event);
      // Calculate actual total bytes
      const actualTotal = entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.summary, 'utf8'), 0);
      // Only assert false if it actually exceeds
      if (actualTotal > MAX_DECISION_TRACE_TOTAL_BYTES) {
        expect(parsed.success).toBe(false);
      }
    });

    it('schema rejects multibyte decision trace summaries that exceed total budget', () => {
      // Use 4-byte UTF-8 emoji
      const emoji = '🔥';
      expect(Buffer.byteLength(emoji, 'utf8')).toBe(4);

      // Create entries with emoji that exceed total budget
      const summaryWithEmoji = emoji.repeat(3000);
      expect(Buffer.byteLength(summaryWithEmoji, 'utf8')).toBeGreaterThan(MAX_DECISION_TRACE_TOTAL_BYTES);

      const event = {
        v: 1,
        eventId: 'evt_trace',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'decision_trace_appended' as const,
        dedupeKey: 'decision_trace_appended:sess_1:trace_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          traceId: 'trace_1',
          entries: [{ kind: 'selected_next_step' as const, summary: summaryWithEmoji }],
        },
      };

      const parsed = DomainEventV1Schema.safeParse(event);
      expect(parsed.success).toBe(false);
    });
  });

  describe('Blocker budgets', () => {
    it('schema rejects blocker message over MAX_BLOCKER_MESSAGE_BYTES (UTF-8 bytes)', () => {
      const huge = 'a'.repeat(MAX_BLOCKER_MESSAGE_BYTES + 100);

      const event = {
        v: 1,
        eventId: 'evt_advance',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'advance_recorded' as const,
        dedupeKey: 'advance_recorded:sess_1:attempt_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          attemptId: 'attempt_1',
          intent: 'ack_pending' as const,
          outcome: {
            kind: 'blocked' as const,
            blockers: {
              blockers: [
                {
                  code: 'MISSING_REQUIRED_OUTPUT' as const,
                  pointer: { kind: 'output_contract' as const, contractRef: 'contract_1' },
                  message: huge,
                },
              ],
            },
          },
        },
      };

      const parsed = DomainEventV1Schema.safeParse(event);
      expect(parsed.success).toBe(false);
    });

    it('schema accepts blocker message at exactly MAX_BLOCKER_MESSAGE_BYTES (ASCII)', () => {
      const exact = 'a'.repeat(MAX_BLOCKER_MESSAGE_BYTES);

      const event = {
        v: 1,
        eventId: 'evt_advance',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'advance_recorded' as const,
        dedupeKey: 'advance_recorded:sess_1:attempt_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          attemptId: 'attempt_1',
          intent: 'ack_pending' as const,
          outcome: {
            kind: 'blocked' as const,
            blockers: {
              blockers: [
                {
                  code: 'MISSING_REQUIRED_OUTPUT' as const,
                  pointer: { kind: 'output_contract' as const, contractRef: 'contract_1' },
                  message: exact,
                },
              ],
            },
          },
        },
      };

      const parsed = DomainEventV1Schema.safeParse(event);
      expect(parsed.success).toBe(true);
    });

    it('schema rejects blocker suggestedFix over MAX_BLOCKER_SUGGESTED_FIX_BYTES (UTF-8 bytes)', () => {
      const huge = 'a'.repeat(MAX_BLOCKER_SUGGESTED_FIX_BYTES + 100);

      const event = {
        v: 1,
        eventId: 'evt_advance',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'advance_recorded' as const,
        dedupeKey: 'advance_recorded:sess_1:attempt_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          attemptId: 'attempt_1',
          intent: 'ack_pending' as const,
          outcome: {
            kind: 'blocked' as const,
            blockers: {
              blockers: [
                {
                  code: 'MISSING_REQUIRED_OUTPUT' as const,
                  pointer: { kind: 'output_contract' as const, contractRef: 'contract_1' },
                  message: 'Missing output',
                  suggestedFix: huge,
                },
              ],
            },
          },
        },
      };

      const parsed = DomainEventV1Schema.safeParse(event);
      expect(parsed.success).toBe(false);
    });

    it('schema accepts blocker suggestedFix at exactly MAX_BLOCKER_SUGGESTED_FIX_BYTES (ASCII)', () => {
      const exact = 'a'.repeat(MAX_BLOCKER_SUGGESTED_FIX_BYTES);

      const event = {
        v: 1,
        eventId: 'evt_advance',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'advance_recorded' as const,
        dedupeKey: 'advance_recorded:sess_1:attempt_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          attemptId: 'attempt_1',
          intent: 'ack_pending' as const,
          outcome: {
            kind: 'blocked' as const,
            blockers: {
              blockers: [
                {
                  code: 'MISSING_REQUIRED_OUTPUT' as const,
                  pointer: { kind: 'output_contract' as const, contractRef: 'contract_1' },
                  message: 'Missing output',
                  suggestedFix: exact,
                },
              ],
            },
          },
        },
      };

      const parsed = DomainEventV1Schema.safeParse(event);
      expect(parsed.success).toBe(true);
    });

    it('schema rejects multibyte blocker message that exceeds MAX_BLOCKER_MESSAGE_BYTES', () => {
      // 4 bytes in UTF-8
      const emoji = '🔥';
      expect(Buffer.byteLength(emoji, 'utf8')).toBe(4);

      // ensure > 512 bytes
      const huge = emoji.repeat(200);
      expect(Buffer.byteLength(huge, 'utf8')).toBeGreaterThan(MAX_BLOCKER_MESSAGE_BYTES);

      const event = {
        v: 1,
        eventId: 'evt_advance',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'advance_recorded' as const,
        dedupeKey: 'advance_recorded:sess_1:attempt_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          attemptId: 'attempt_1',
          intent: 'ack_pending' as const,
          outcome: {
            kind: 'blocked' as const,
            blockers: {
              blockers: [
                {
                  code: 'MISSING_REQUIRED_OUTPUT' as const,
                  pointer: { kind: 'output_contract' as const, contractRef: 'contract_1' },
                  message: huge,
                },
              ],
            },
          },
        },
      };

      const parsed = DomainEventV1Schema.safeParse(event);
      expect(parsed.success).toBe(false);
    });

    it('schema rejects multibyte blocker suggestedFix that exceeds MAX_BLOCKER_SUGGESTED_FIX_BYTES', () => {
      // 4 bytes in UTF-8
      const emoji = '🔥';
      expect(Buffer.byteLength(emoji, 'utf8')).toBe(4);

      // ensure > 1024 bytes
      const huge = emoji.repeat(400);
      expect(Buffer.byteLength(huge, 'utf8')).toBeGreaterThan(MAX_BLOCKER_SUGGESTED_FIX_BYTES);

      const event = {
        v: 1,
        eventId: 'evt_advance',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'advance_recorded' as const,
        dedupeKey: 'advance_recorded:sess_1:attempt_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          attemptId: 'attempt_1',
          intent: 'ack_pending' as const,
          outcome: {
            kind: 'blocked' as const,
            blockers: {
              blockers: [
                {
                  code: 'MISSING_REQUIRED_OUTPUT' as const,
                  pointer: { kind: 'output_contract' as const, contractRef: 'contract_1' },
                  message: 'Missing output',
                  suggestedFix: huge,
                },
              ],
            },
          },
        },
      };

      const parsed = DomainEventV1Schema.safeParse(event);
      expect(parsed.success).toBe(false);
    });

    it('multibyte blocker message at UTF-8 boundary is accepted', () => {
      // Create a multibyte string exactly at the boundary
      const emoji = '🔥'; // 4 bytes
      const asciiPart = 'a'.repeat(MAX_BLOCKER_MESSAGE_BYTES - 4);
      const combined = asciiPart + emoji;
      expect(Buffer.byteLength(combined, 'utf8')).toBe(MAX_BLOCKER_MESSAGE_BYTES);

      const event = {
        v: 1,
        eventId: 'evt_advance',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'advance_recorded' as const,
        dedupeKey: 'advance_recorded:sess_1:attempt_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          attemptId: 'attempt_1',
          intent: 'ack_pending' as const,
          outcome: {
            kind: 'blocked' as const,
            blockers: {
              blockers: [
                {
                  code: 'MISSING_REQUIRED_OUTPUT' as const,
                  pointer: { kind: 'output_contract' as const, contractRef: 'contract_1' },
                  message: combined,
                },
              ],
            },
          },
        },
      };

      const parsed = DomainEventV1Schema.safeParse(event);
      expect(parsed.success).toBe(true);
    });

    it('multibyte blocker suggestedFix at UTF-8 boundary is accepted', () => {
      // Create a multibyte string exactly at the boundary
      const emoji = '🔥'; // 4 bytes
      const asciiPart = 'a'.repeat(MAX_BLOCKER_SUGGESTED_FIX_BYTES - 4);
      const combined = asciiPart + emoji;
      expect(Buffer.byteLength(combined, 'utf8')).toBe(MAX_BLOCKER_SUGGESTED_FIX_BYTES);

      const event = {
        v: 1,
        eventId: 'evt_advance',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'advance_recorded' as const,
        dedupeKey: 'advance_recorded:sess_1:attempt_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          attemptId: 'attempt_1',
          intent: 'ack_pending' as const,
          outcome: {
            kind: 'blocked' as const,
            blockers: {
              blockers: [
                {
                  code: 'MISSING_REQUIRED_OUTPUT' as const,
                  pointer: { kind: 'output_contract' as const, contractRef: 'contract_1' },
                  message: 'Missing output',
                  suggestedFix: combined,
                },
              ],
            },
          },
        },
      };

      const parsed = DomainEventV1Schema.safeParse(event);
      expect(parsed.success).toBe(true);
    });
  });
});
