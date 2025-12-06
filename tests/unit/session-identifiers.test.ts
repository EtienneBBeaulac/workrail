/**
 * Tests for branded session identifier types.
 * 
 * Verifies:
 * - Validation logic
 * - Type safety (via TypeScript compilation)
 * - Smart constructors
 * - Key serialization
 */

import { describe, it, expect } from 'vitest';
import { WorkflowId, SessionId, SessionWatcherKey } from '../../src/types/session-identifiers';

describe('WorkflowId', () => {
  describe('parse', () => {
    it('should parse valid workflow IDs', () => {
      const valid = [
        'bug-investigation',
        'my-workflow-123',
        'test',
        'a',
        '123',
        'workflow-with-many-hyphens',
      ];
      
      for (const id of valid) {
        expect(() => WorkflowId.parse(id)).not.toThrow();
        expect(WorkflowId.parse(id)).toBe(id);
      }
    });

    it('should reject invalid workflow IDs', () => {
      const invalid = [
        'UPPERCASE',                  // Uppercase
        'Invalid_ID',                 // Underscore
        'has spaces',                 // Spaces
        'has/slash',                  // Slash
        'has.dot',                    // Dot
        '../path-traversal',          // Path traversal
        'has@special',                // Special chars
      ];
      
      for (const id of invalid) {
        expect(() => WorkflowId.parse(id)).toThrow(TypeError);
      }
      
      // Empty string has different error message
      expect(() => WorkflowId.parse('')).toThrow(TypeError);
      expect(() => WorkflowId.parse('')).toThrow(/non-empty string/);
    });

    it('should reject non-string inputs', () => {
      expect(() => WorkflowId.parse(null as any)).toThrow(TypeError);
      expect(() => WorkflowId.parse(undefined as any)).toThrow(TypeError);
      expect(() => WorkflowId.parse(123 as any)).toThrow(TypeError);
      expect(() => WorkflowId.parse({} as any)).toThrow(TypeError);
    });
  });

  describe('unsafeCoerce', () => {
    it('should coerce without validation', () => {
      // Even invalid IDs are coerced (use with caution!)
      expect(WorkflowId.unsafeCoerce('INVALID')).toBe('INVALID');
      expect(WorkflowId.unsafeCoerce('has spaces')).toBe('has spaces');
    });
  });
});

describe('SessionId', () => {
  describe('parse', () => {
    it('should parse valid session IDs', () => {
      const valid = [
        'AUTH-123',
        'bug-fix-456',
        'session_with_underscores',
        'MixedCase',
        'ABC123',
        'test',
      ];
      
      for (const id of valid) {
        expect(() => SessionId.parse(id)).not.toThrow();
        expect(SessionId.parse(id)).toBe(id);
      }
    });

    it('should reject invalid session IDs', () => {
      const invalid = [
        'has spaces',                 // Spaces
        'has/slash',                  // Slash
        'has.dot',                    // Dot (not allowed)
        '../path-traversal',          // Path traversal
        'has@special',                // Special chars
      ];
      
      for (const id of invalid) {
        expect(() => SessionId.parse(id)).toThrow(TypeError);
      }
      
      // Empty string has different error message
      expect(() => SessionId.parse('')).toThrow(TypeError);
      expect(() => SessionId.parse('')).toThrow(/non-empty string/);
    });

    it('should reject non-string inputs', () => {
      expect(() => SessionId.parse(null as any)).toThrow(TypeError);
      expect(() => SessionId.parse(undefined as any)).toThrow(TypeError);
    });
  });
});

describe('SessionWatcherKey', () => {
  describe('create', () => {
    it('should create immutable keys', () => {
      const workflowId = WorkflowId.parse('test-workflow');
      const sessionId = SessionId.parse('TEST-123');
      
      const key = SessionWatcherKey.create(workflowId, sessionId);
      
      expect(key.workflowId).toBe(workflowId);
      expect(key.sessionId).toBe(sessionId);
      expect(Object.isFrozen(key)).toBe(true);
    });
  });

  describe('serialize / deserialize', () => {
    it('should serialize and deserialize consistently', () => {
      const workflowId = WorkflowId.parse('bug-investigation');
      const sessionId = SessionId.parse('AUTH-456');
      
      const key = SessionWatcherKey.create(workflowId, sessionId);
      const serialized = SessionWatcherKey.serialize(key);
      const deserialized = SessionWatcherKey.deserialize(serialized);
      
      expect(deserialized.workflowId).toBe(key.workflowId);
      expect(deserialized.sessionId).toBe(key.sessionId);
    });

    it('should use :: as separator to avoid conflicts', () => {
      const key = SessionWatcherKey.create(
        WorkflowId.parse('my-workflow'),
        SessionId.parse('session-123')
      );
      
      const serialized = SessionWatcherKey.serialize(key);
      expect(serialized).toBe('my-workflow::session-123');
      expect(serialized).toContain('::');
      expect(serialized).not.toContain('/');
    });

    it('should reject invalid serialized keys', () => {
      expect(() => SessionWatcherKey.deserialize('no-separator')).toThrow(TypeError);
      expect(() => SessionWatcherKey.deserialize('too::many::parts')).toThrow(TypeError);
      expect(() => SessionWatcherKey.deserialize('::empty-parts')).toThrow(TypeError);
    });
  });

  describe('equals', () => {
    it('should compare keys correctly', () => {
      const key1 = SessionWatcherKey.create(
        WorkflowId.parse('workflow-a'),
        SessionId.parse('session-1')
      );
      
      const key2 = SessionWatcherKey.create(
        WorkflowId.parse('workflow-a'),
        SessionId.parse('session-1')
      );
      
      const key3 = SessionWatcherKey.create(
        WorkflowId.parse('workflow-b'),
        SessionId.parse('session-1')
      );
      
      expect(SessionWatcherKey.equals(key1, key2)).toBe(true);
      expect(SessionWatcherKey.equals(key1, key3)).toBe(false);
    });
  });
});
