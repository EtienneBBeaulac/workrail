import { describe, it, expect } from 'vitest';
import {
  DedupeKeyV1Schema,
  buildDedupeKey,
  isValidDedupeKey,
  MAX_DEDUPE_KEY_LENGTH,
  DEDUPE_KEY_PATTERN,
} from '../../../src/v2/durable-core/schemas/lib/dedupe-key';

describe('dedupe-key', () => {
  describe('DedupeKeyV1Schema', () => {
    it('parses valid dedupeKey', () => {
      const result = DedupeKeyV1Schema.safeParse('session_created:sess_01jh');
      expect(result.success).toBe(true);
    });

    it('parses dedupeKey with arrow (edge pattern)', () => {
      const result = DedupeKeyV1Schema.safeParse('edge_created:sess_01jh:run_01jh:nodea->nodeb:acked_step');
      expect(result.success).toBe(true);
    });

    it('parses dedupeKey with multiple colons', () => {
      const result = DedupeKeyV1Schema.safeParse('node_created:sess:run:node');
      expect(result.success).toBe(true);
    });

    it('rejects empty string', () => {
      const result = DedupeKeyV1Schema.safeParse('');
      expect(result.success).toBe(false);
    });

    it('rejects dedupeKey with spaces', () => {
      const result = DedupeKeyV1Schema.safeParse('has spaces');
      expect(result.success).toBe(false);
    });

    it('rejects dedupeKey with uppercase', () => {
      const result = DedupeKeyV1Schema.safeParse('HAS_UPPERCASE');
      expect(result.success).toBe(false);
    });

    it('rejects dedupeKey with slash', () => {
      const result = DedupeKeyV1Schema.safeParse('has/slash');
      expect(result.success).toBe(false);
    });

    it('rejects dedupeKey exceeding max length', () => {
      const longKey = 'a'.repeat(MAX_DEDUPE_KEY_LENGTH + 1);
      const result = DedupeKeyV1Schema.safeParse(longKey);
      expect(result.success).toBe(false);
    });

    it('accepts dedupeKey at exactly max length', () => {
      const key = 'a'.repeat(MAX_DEDUPE_KEY_LENGTH);
      const result = DedupeKeyV1Schema.safeParse(key);
      expect(result.success).toBe(true);
    });
  });

  describe('buildDedupeKey', () => {
    it('builds valid dedupeKey from kind and parts', () => {
      const key = buildDedupeKey('session_created', ['sess_01jh']);
      expect(key).toBe('session_created:sess_01jh');
    });

    it('builds dedupeKey with multiple parts', () => {
      const key = buildDedupeKey('node_created', ['sess_01jh', 'run_01jh', 'node_01jh']);
      expect(key).toBe('node_created:sess_01jh:run_01jh:node_01jh');
    });

    it('builds dedupeKey with arrow in parts', () => {
      const key = buildDedupeKey('edge_created', ['sess_01jh', 'run_01jh', 'nodea->nodeb', 'acked_step']);
      expect(key).toBe('edge_created:sess_01jh:run_01jh:nodea->nodeb:acked_step');
    });

    it('throws on invalid characters', () => {
      expect(() => buildDedupeKey('invalid', ['has spaces'])).toThrow();
    });

    it('throws on too long key', () => {
      const longPart = 'a'.repeat(MAX_DEDUPE_KEY_LENGTH);
      expect(() => buildDedupeKey('kind', [longPart])).toThrow();
    });
  });

  describe('isValidDedupeKey', () => {
    it('returns true for valid key', () => {
      expect(isValidDedupeKey('session_created:sess_01jh')).toBe(true);
    });

    it('returns false for empty string', () => {
      expect(isValidDedupeKey('')).toBe(false);
    });

    it('returns false for invalid characters', () => {
      expect(isValidDedupeKey('has spaces')).toBe(false);
    });

    it('returns false for too long key', () => {
      expect(isValidDedupeKey('a'.repeat(MAX_DEDUPE_KEY_LENGTH + 1))).toBe(false);
    });
  });

  describe('DEDUPE_KEY_PATTERN (locked)', () => {
    it('allows lowercase letters', () => {
      expect(DEDUPE_KEY_PATTERN.test('abc')).toBe(true);
    });

    it('allows digits', () => {
      expect(DEDUPE_KEY_PATTERN.test('123')).toBe(true);
    });

    it('allows underscore', () => {
      expect(DEDUPE_KEY_PATTERN.test('a_b')).toBe(true);
    });

    it('allows hyphen', () => {
      expect(DEDUPE_KEY_PATTERN.test('a-b')).toBe(true);
    });

    it('allows colon', () => {
      expect(DEDUPE_KEY_PATTERN.test('a:b')).toBe(true);
    });

    it('allows arrow', () => {
      expect(DEDUPE_KEY_PATTERN.test('a->b')).toBe(true);
    });

    it('rejects uppercase', () => {
      expect(DEDUPE_KEY_PATTERN.test('ABC')).toBe(false);
    });

    it('rejects space', () => {
      expect(DEDUPE_KEY_PATTERN.test('a b')).toBe(false);
    });

    it('rejects dot', () => {
      expect(DEDUPE_KEY_PATTERN.test('a.b')).toBe(false);
    });
  });
});
