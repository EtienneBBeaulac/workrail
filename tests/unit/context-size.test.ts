import { describe, it, expect } from 'vitest';
import { calculateObjectSize, checkContextSize, CONTEXT_SIZE_LIMITS } from '../../src/utils/context-size';

describe('Context Size Utilities', () => {
  describe('calculateObjectSize', () => {
    it('should calculate size of primitive values', () => {
      expect(calculateObjectSize(null)).toBe(4);
      expect(calculateObjectSize(undefined)).toBe(0);
      expect(calculateObjectSize(true)).toBe(4);
      expect(calculateObjectSize(false)).toBe(4);
      expect(calculateObjectSize(42)).toBe(8);
      expect(calculateObjectSize('hello')).toBe(10); // 5 chars * 2 bytes
    });

    it('should calculate size of objects', () => {
      const obj = {
        name: 'test',
        value: 42,
        active: true
      };
      // 4 (object) + 8 (name key+value) + 10 (value key) + 8 (number) + 12 (active key) + 4 (boolean) = 46
      const size = calculateObjectSize(obj);
      expect(size).toBeGreaterThan(40);
      expect(size).toBeLessThan(60);
    });

    it('should calculate size of arrays', () => {
      const arr = [1, 2, 3, 'test'];
      // 4 (array) + 8*3 (numbers) + 8 (string) = 36
      const size = calculateObjectSize(arr);
      expect(size).toBeGreaterThan(30);
      expect(size).toBeLessThan(50);
    });

    it('should handle circular references', () => {
      const obj: any = { name: 'test' };
      obj.self = obj;
      const size = calculateObjectSize(obj);
      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThan(100); // Should not infinite loop
    });

    it('should ignore functions', () => {
      const obj = {
        name: 'test',
        func: () => console.log('test')
      };
      const sizeWithFunc = calculateObjectSize(obj);
      const sizeWithoutFunc = calculateObjectSize({ name: 'test' });
      expect(sizeWithFunc).toBe(sizeWithoutFunc + 8); // Only the 'func' key adds size
    });
  });

  describe('checkContextSize', () => {
    it('should add _contextSize to context', () => {
      const context = { test: 'value' };
      const result = checkContextSize(context);
      expect(result.context._contextSize).toBe(result.sizeBytes);
    });

    it('should not warn for small contexts', () => {
      const context = { small: 'context' };
      const result = checkContextSize(context);
      expect(result.isWarning).toBe(false);
      expect(result.isError).toBe(false);
      expect(result.context._warnings).toBeUndefined();
    });

    it('should warn when context exceeds 80% of max size', () => {
      // Create a large context (over 204KB but under 256KB)
      const largeString = 'x'.repeat(105 * 1024); // 210KB string (105k chars * 2 bytes)
      const context = { data: largeString };
      const result = checkContextSize(context);
      
      expect(result.sizeBytes).toBeGreaterThan(204 * 1024); // Over 204KB
      expect(result.sizeBytes).toBeLessThan(256 * 1024); // Under 256KB
      expect(result.isWarning).toBe(true);
      expect(result.isError).toBe(false);
      expect(result.context._warnings?.contextSize).toBeDefined();
      expect(result.context._warnings.contextSize[0]).toContain('exceeds 80%');
    });

    it('should error when context exceeds max size', () => {
      // Create a very large context (over 256KB)
      const veryLargeString = 'x'.repeat(130 * 1024); // 260KB string (130k chars * 2 bytes)
      const context = { data: veryLargeString };
      const result = checkContextSize(context);
      
      expect(result.sizeBytes).toBeGreaterThan(256 * 1024); // Over 256KB
      expect(result.isWarning).toBe(true);
      expect(result.isError).toBe(true);
    });

    it('should preserve existing warnings', () => {
      const largeString = 'x'.repeat(105 * 1024); // 210KB to trigger warning
      const context = {
        data: largeString,
        _warnings: {
          other: ['existing warning']
        }
      };
      const result = checkContextSize(context);
      
      expect(result.context._warnings.other).toEqual(['existing warning']);
      expect(result.context._warnings.contextSize).toBeDefined();
    });
  });

  describe('CONTEXT_SIZE_LIMITS', () => {
    it('should export correct size limits', () => {
      expect(CONTEXT_SIZE_LIMITS.MAX_SIZE).toBe(256 * 1024);
      expect(CONTEXT_SIZE_LIMITS.WARNING_THRESHOLD).toBe(0.8);
      expect(CONTEXT_SIZE_LIMITS.WARNING_SIZE).toBe(256 * 1024 * 0.8);
    });
  });
}); 