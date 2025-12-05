/**
 * Pattern Recognizer Unit Tests
 * 
 * Tests the pattern recognition logic for various data structures.
 */

import { PatternRecognizer } from '../../web/assets/services/pattern-recognizer.js';

describe('PatternRecognizer', () => {
  let recognizer;
  
  beforeEach(() => {
    recognizer = new PatternRecognizer();
  });
  
  describe('recognize()', () => {
    test('handles null/undefined keys gracefully', () => {
      const result = recognizer.recognize(null, 'value');
      expect(result.component).toBe('Empty');
      
      const result2 = recognizer.recognize(undefined, 'value');
      expect(result2.component).toBe('Empty');
    });
    
    test('handles null/undefined values gracefully', () => {
      const result = recognizer.recognize('key', null);
      expect(result.component).toBe('Empty');
      
      const result2 = recognizer.recognize('key', undefined);
      expect(result2.component).toBe('Empty');
    });
    
    test('detects circular references', () => {
      const circular = { a: 1 };
      circular.self = circular;
      
      const result = recognizer.recognize('circular', circular);
      expect(result.component).toBe('ErrorCard');
      expect(result.props.error).toContain('Circular reference');
    });
    
    test('recognizes dashboard field', () => {
      const dashboard = { title: 'Test', progress: 50 };
      const result = recognizer.recognize('dashboard', dashboard);
      
      expect(result.component).toBe('Hero');
      expect(result.priority).toBe(100);
    });
    
    test('handles malformed dashboard field', () => {
      const result = recognizer.recognize('dashboard', 'not-an-object');
      expect(result.component).toBe('Card');
    });
  });
  
  describe('recognizeArray()', () => {
    test('handles empty arrays', () => {
      const result = recognizer.recognize('items', []);
      expect(result.component).toBe('EmptyCard');
    });
    
    test('filters null/undefined items', () => {
      const result = recognizer.recognize('items', [null, { status: 'active' }, undefined, { status: 'pending' }]);
      expect(result.component).toBe('GroupedList');
      expect(result.props.items).toHaveLength(2);
    });
    
    test('recognizes timeline pattern', () => {
      const events = [
        { timestamp: '2025-10-11T12:00:00Z', event: 'Started' },
        { timestamp: '2025-10-11T13:00:00Z', event: 'Completed' }
      ];
      const result = recognizer.recognize('timeline', events);
      
      expect(result.component).toBe('Timeline');
      expect(result.priority).toBe(90);
    });
    
    test('recognizes status-based pattern', () => {
      const items = [
        { status: 'active', description: 'Item 1' },
        { status: 'pending', description: 'Item 2' }
      ];
      const result = recognizer.recognize('hypotheses', items);
      
      expect(result.component).toBe('GroupedList');
      expect(result.props.groupBy).toBe('status');
    });
    
    test('recognizes severity pattern', () => {
      const items = [
        { severity: 'critical', message: 'Error 1' },
        { severity: 'warning', message: 'Warning 1' }
      ];
      const result = recognizer.recognize('issues', items);
      
      expect(result.component).toBe('SeverityList');
      expect(result.props.severityField).toBe('severity');
    });
    
    test('recognizes priority pattern', () => {
      const items = [
        { priority: 10, description: 'High priority' },
        { priority: 5, description: 'Medium priority' }
      ];
      const result = recognizer.recognize('recommendations', items);
      
      expect(result.component).toBe('PriorityList');
      expect(result.props.priorityField).toBe('priority');
    });
    
    test('recognizes string array as checklist', () => {
      const items = ['Item 1', 'Item 2', 'Item 3'];
      const result = recognizer.recognize('tasks', items);
      
      expect(result.component).toBe('Checklist');
      expect(result.props.items).toEqual(items);
    });
  });
  
  describe('recognizeObject()', () => {
    test('recognizes high-confidence object', () => {
      const obj = { confidence: 9.5, description: 'Root cause found' };
      const result = recognizer.recognize('finding', obj);
      
      expect(result.component).toBe('HighlightCard');
      expect(result.priority).toBe(90);
    });
    
    test('recognizes error object', () => {
      const obj = { error: 'Something went wrong', code: 500 };
      const result = recognizer.recognize('failure', obj);
      
      expect(result.component).toBe('ErrorCard');
      expect(result.props.error).toBe('Something went wrong');
    });
    
    test('recognizes stat grid (all numbers)', () => {
      const obj = { files: 42, lines: 1234, functions: 89 };
      const result = recognizer.recognize('metrics', obj);
      
      expect(result.component).toBe('StatGrid');
      expect(result.props.metrics).toEqual(obj);
    });
    
    test('recognizes phases collection', () => {
      const phases = {
        'phase-0': { complete: true, summary: 'Done' },
        'phase-1': { complete: false, summary: 'In progress' }
      };
      const result = recognizer.recognize('phases', phases);
      
      expect(result.component).toBe('PhasesList');
      expect(result.props.phases).toEqual(phases);
    });
    
    test('handles non-object gracefully', () => {
      const result = recognizer.recognize('key', 'not-an-object');
      expect(result.component).not.toBe('Card');
    });
  });
  
  describe('recognizePrimitive()', () => {
    test('recognizes score (0-10)', () => {
      const result = recognizer.recognize('confidence', 8.5);
      expect(result.component).toBe('ScoreDisplay');
      expect(result.props.score).toBe(8.5);
    });
    
    test('recognizes progress (0-100)', () => {
      const result = recognizer.recognize('progress', 75);
      expect(result.component).toBe('ProgressBar');
      expect(result.props.value).toBe(75);
    });
    
    test('handles Infinity/NaN gracefully', () => {
      const result1 = recognizer.recognize('value', Infinity);
      expect(result1.component).toBe('TextField');
      
      const result2 = recognizer.recognize('value', NaN);
      expect(result2.component).toBe('TextField');
    });
    
    test('recognizes timestamps', () => {
      const result = recognizer.recognize('createdAt', '2025-10-11T12:00:00Z');
      expect(result.component).toBe('TimeDisplay');
    });
    
    test('recognizes URLs', () => {
      const result = recognizer.recognize('link', 'https://example.com');
      expect(result.component).toBe('LinkText');
    });
    
    test('recognizes file paths', () => {
      const result = recognizer.recognize('file', '/path/to/file.txt');
      expect(result.component).toBe('PathText');
    });
    
    test('recognizes code blocks', () => {
      const code = 'function test() {\n  return true;\n}';
      const result = recognizer.recognize('snippet', code);
      expect(result.component).toBe('CodeBlock');
    });
    
    test('recognizes booleans', () => {
      const result = recognizer.recognize('enabled', true);
      expect(result.component).toBe('Checkbox');
      expect(result.props.checked).toBe(true);
    });
  });
  
  describe('formatLabel()', () => {
    test('formats camelCase', () => {
      expect(recognizer.formatLabel('bugSummary')).toBe('Bug Summary');
    });
    
    test('formats snake_case', () => {
      expect(recognizer.formatLabel('bug_summary')).toBe('Bug Summary');
    });
    
    test('formats kebab-case', () => {
      expect(recognizer.formatLabel('bug-summary')).toBe('Bug Summary');
    });
    
    test('handles null/undefined', () => {
      expect(recognizer.formatLabel(null)).toBe('Unknown');
      expect(recognizer.formatLabel(undefined)).toBe('Unknown');
    });
    
    test('handles empty string', () => {
      expect(recognizer.formatLabel('')).toBe('Empty');
    });
  });
  
  describe('isTimestamp()', () => {
    test('validates ISO timestamps', () => {
      expect(recognizer.isTimestamp('2025-10-11T12:00:00Z')).toBe(true);
      expect(recognizer.isTimestamp('2025-10-11T12:00:00.123Z')).toBe(true);
    });
    
    test('rejects invalid formats', () => {
      expect(recognizer.isTimestamp('2025-10-11')).toBe(false);
      expect(recognizer.isTimestamp('not-a-date')).toBe(false);
      expect(recognizer.isTimestamp('12:00:00')).toBe(false);
    });
    
    test('rejects malformed dates', () => {
      expect(recognizer.isTimestamp('2025-13-99T99:99:99Z')).toBe(false);
    });
  });
});






