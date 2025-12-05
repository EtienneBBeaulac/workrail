/**
 * Data Normalizer Unit Tests
 * 
 * Tests data normalization, cleaning, and validation logic.
 */

import { DataNormalizer } from '../../web/assets/services/data-normalizer.js';

describe('DataNormalizer', () => {
  let normalizer;
  
  beforeEach(() => {
    normalizer = new DataNormalizer();
  });
  
  describe('normalizeKey()', () => {
    test('converts various formats to camelCase', () => {
      expect(normalizer.normalizeKey('Bug Summary')).toBe('bugSummary');
      expect(normalizer.normalizeKey('bug_summary')).toBe('bugSummary');
      expect(normalizer.normalizeKey('bug-summary')).toBe('bugSummary');
      expect(normalizer.normalizeKey('BUG_SUMMARY')).toBe('bugSummary');
    });
    
    test('recognizes aliases', () => {
      expect(normalizer.normalizeKey('bug summary')).toBe('bugSummary');
      expect(normalizer.normalizeKey('Bug Summary')).toBe('bugSummary');
      expect(normalizer.normalizeKey('bug-summary')).toBe('bugSummary');
    });
    
    test('handles edge cases', () => {
      expect(normalizer.normalizeKey(null)).toBe(null);
      expect(normalizer.normalizeKey(undefined)).toBe(undefined);
      expect(normalizer.normalizeKey('')).toBe('');
    });
  });
  
  describe('normalizeKeys()', () => {
    test('normalizes top-level keys', () => {
      const data = {
        'Bug Summary': 'Test bug',
        'root_cause': 'Memory leak',
        'time-stamp': '2025-10-11'
      };
      
      const result = normalizer.normalizeKeys(data);
      
      expect(result).toHaveProperty('bugSummary');
      expect(result).toHaveProperty('rootCause');
      expect(result).toHaveProperty('timeStamp');
    });
    
    test('normalizes nested keys when deep=true', () => {
      const data = {
        'bug_info': {
          'error_message': 'Failed',
          'stack_trace': 'line 42'
        }
      };
      
      const result = normalizer.normalizeKeys(data, true);
      
      expect(result.bugInfo).toBeDefined();
      expect(result.bugInfo.errorMessage).toBe('Failed');
      expect(result.bugInfo.stackTrace).toBe('line 42');
    });
    
    test('normalizes arrays when deep=true', () => {
      const data = {
        items: [
          { 'item_name': 'Test', 'item_count': 5 }
        ]
      };
      
      const result = normalizer.normalizeKeys(data, true);
      
      expect(result.items[0].itemName).toBe('Test');
      expect(result.items[0].itemCount).toBe(5);
    });
  });
  
  describe('reconstructNested()', () => {
    test('reconstructs dot-notation keys', () => {
      const data = {
        'phases.phase-0': { complete: true },
        'phases.phase-1': { complete: false },
        'dashboard': { title: 'Test' }
      };
      
      const result = normalizer.reconstructNested(data);
      
      expect(result.phases).toBeDefined();
      expect(result.phases['phase-0']).toEqual({ complete: true });
      expect(result.phases['phase-1']).toEqual({ complete: false });
      expect(result.dashboard).toEqual({ title: 'Test' });
    });
    
    test('handles deep nesting', () => {
      const data = {
        'a.b.c': 'value',
        'a.b.d': 'value2'
      };
      
      const result = normalizer.reconstructNested(data);
      
      expect(result.a.b.c).toBe('value');
      expect(result.a.b.d).toBe('value2');
    });
    
    test('handles conflicts gracefully', () => {
      const data = {
        'parent': 'string-value',
        'parent.child': 'nested-value'
      };
      
      const result = normalizer.reconstructNested(data);
      
      // Should preserve original value and warn
      expect(result.parent).toBe('string-value');
    });
    
    test('ignores invalid keys', () => {
      const data = {
        '.invalid': 'value',
        'invalid.': 'value2',
        'valid.key': 'value3'
      };
      
      const result = normalizer.reconstructNested(data);
      
      expect(result['.invalid']).toBe('value');
      expect(result['invalid.']).toBe('value2');
      expect(result.valid.key).toBe('value3');
    });
  });
  
  describe('inferType()', () => {
    test('identifies base types', () => {
      expect(normalizer.inferType(null)).toBe('null');
      expect(normalizer.inferType(undefined)).toBe('undefined');
      expect(normalizer.inferType(123)).toBe('number');
      expect(normalizer.inferType(true)).toBe('boolean');
      expect(normalizer.inferType({})).toBe('object');
      expect(normalizer.inferType([])).toBe('object');
    });
    
    test('identifies string subtypes', () => {
      expect(normalizer.inferType('https://example.com')).toBe('url');
      expect(normalizer.inferType('2025-10-11T12:00:00Z')).toBe('date-string');
      expect(normalizer.inferType('/path/to/file.txt')).toBe('file-path');
      expect(normalizer.inferType('{"key": "value"}')).toBe('json-string');
      expect(normalizer.inferType('function test() {\n  return true;\n}')).toBe('code');
    });
    
    test('identifies number-like strings', () => {
      expect(normalizer.inferType('42')).toBe('integer-string');
      expect(normalizer.inferType('3.14')).toBe('float-string');
      expect(normalizer.inferType('-123')).toBe('integer-string');
    });
    
    test('identifies boolean-like strings', () => {
      expect(normalizer.inferType('true')).toBe('boolean-string');
      expect(normalizer.inferType('false')).toBe('boolean-string');
      expect(normalizer.inferType('yes')).toBe('boolean-string');
      expect(normalizer.inferType('no')).toBe('boolean-string');
    });
  });
  
  describe('cleanValue()', () => {
    test('trims strings', () => {
      expect(normalizer.cleanValue('  test  ')).toBe('test');
      expect(normalizer.cleanValue('\n\ttest\n\t')).toBe('test');
    });
    
    test('removes zero-width characters', () => {
      const withZeroWidth = 'test\u200Bstring';
      expect(normalizer.cleanValue(withZeroWidth)).toBe('teststring');
    });
    
    test('normalizes whitespace', () => {
      expect(normalizer.cleanValue('test   multiple   spaces')).toBe('test multiple spaces');
    });
    
    test('handles non-finite numbers', () => {
      expect(normalizer.cleanValue(Infinity)).toBe(null);
      expect(normalizer.cleanValue(-Infinity)).toBe(null);
      expect(normalizer.cleanValue(NaN)).toBe(null);
    });
    
    test('filters null/undefined from arrays', () => {
      const array = [1, null, 2, undefined, 3];
      const result = normalizer.cleanValue(array);
      expect(result).toEqual([1, 2, 3]);
    });
    
    test('cleans nested objects', () => {
      const obj = {
        clean: 'value',
        undefined: undefined,
        nested: {
          value: '  trimmed  ',
          null: null
        }
      };
      
      const result = normalizer.cleanValue(obj);
      
      expect(result.clean).toBe('value');
      expect(result.undefined).toBeUndefined();
      expect(result.nested.value).toBe('trimmed');
      expect(result.nested.null).toBeUndefined();
    });
  });
  
  describe('extractMetadata()', () => {
    test('counts fields', () => {
      const data = { a: 1, b: 2, c: 3 };
      const meta = normalizer.extractMetadata(data);
      expect(meta.fieldCount).toBe(3);
    });
    
    test('detects known patterns', () => {
      const data = {
        timeline: [],
        phases: {},
        hypotheses: [],
        confidence: 8,
        progress: 75
      };
      
      const meta = normalizer.extractMetadata(data);
      
      expect(meta.hasTimeline).toBe(true);
      expect(meta.hasPhases).toBe(true);
      expect(meta.hasHypotheses).toBe(true);
      expect(meta.hasConfidence).toBe(true);
      expect(meta.hasProgress).toBe(true);
    });
    
    test('categorizes field types', () => {
      const data = {
        array: [1, 2, 3],
        object: { nested: true },
        primitive: 'string'
      };
      
      const meta = normalizer.extractMetadata(data);
      
      expect(meta.arrayFields).toContain('array');
      expect(meta.objectFields).toContain('object');
      expect(meta.primitiveFields).toContain('primitive');
    });
  });
  
  describe('validateStructure()', () => {
    test('validates valid data', () => {
      const data = {
        dashboard: { title: 'Test' },
        items: [1, 2, 3]
      };
      
      const result = normalizer.validateStructure(data);
      
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
    
    test('detects null/undefined data', () => {
      const result1 = normalizer.validateStructure(null);
      expect(result1.valid).toBe(false);
      expect(result1.errors).toContain('Data is null or undefined');
      
      const result2 = normalizer.validateStructure(undefined);
      expect(result2.valid).toBe(false);
    });
    
    test('detects non-object data', () => {
      const result = normalizer.validateStructure('not-an-object');
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('must be an object');
    });
    
    test('detects circular references', () => {
      const circular = { a: 1 };
      circular.self = circular;
      
      const result = normalizer.validateStructure(circular);
      
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('circular references');
    });
    
    test('warns about missing dashboard', () => {
      const data = { items: [] };
      const result = normalizer.validateStructure(data);
      
      expect(result.warnings).toContain('No dashboard field found - hero section will not be rendered');
    });
    
    test('warns about empty arrays', () => {
      const data = { dashboard: {}, items: [] };
      const result = normalizer.validateStructure(data);
      
      expect(result.warnings.some(w => w.includes('empty'))).toBe(true);
    });
    
    test('warns about null items in arrays', () => {
      const data = { dashboard: {}, items: [1, null, 2] };
      const result = normalizer.validateStructure(data);
      
      expect(result.warnings.some(w => w.includes('null/undefined items'))).toBe(true);
    });
  });
  
  describe('normalize()', () => {
    test('runs complete normalization pipeline', () => {
      const data = {
        'phases.phase-0': { complete: true },
        'dashboard': { title: '  Test  ', progress: Infinity },
        'items': [null, 'valid', undefined, 'valid2']
      };
      
      const result = normalizer.normalize(data);
      
      // Should have reconstructed nesting
      expect(result.phases).toBeDefined();
      expect(result.phases['phase-0']).toEqual({ complete: true });
      
      // Should have cleaned values
      expect(result.dashboard.title).toBe('Test');
      // Infinity is converted to null by cleanValue, then filtered out from object
      expect(result.dashboard.progress).toBeUndefined();
      
      // Should have filtered nulls
      expect(result.items).toHaveLength(2);
    });
    
    test('respects options', () => {
      const data = { 'a.b': 'value' };
      
      const result1 = normalizer.normalize(data, { reconstructNested: false });
      expect(result1['a.b']).toBe('value');
      expect(result1.a).toBeUndefined();
      
      const result2 = normalizer.normalize(data, { reconstructNested: true });
      expect(result2.a).toBeDefined();
      expect(result2.a.b).toBe('value');
    });
    
    test('handles errors gracefully', () => {
      const result = normalizer.normalize(null);
      expect(result).toEqual({});
    });
  });
});






