import { describe, expect, it, beforeEach } from 'vitest';
import { OutputNormalizer } from '../../src/application/services/output-normalizer.js';

describe('OutputNormalizer', () => {
  let normalizer: OutputNormalizer;

  beforeEach(() => {
    normalizer = new OutputNormalizer();
  });

  describe('stripBackticks - inline backticks', () => {
    it('should strip single inline backticks', () => {
      const result = normalizer.normalize('The value is `foo` here');
      expect(result).toBe('The value is foo here');
    });

    it('should strip multiple inline backticks', () => {
      const result = normalizer.normalize('Use `foo` and `bar` together');
      expect(result).toBe('Use foo and bar together');
    });

    it('should handle empty backticks', () => {
      const result = normalizer.normalize('Empty `` backticks');
      // Empty backticks: `` → (nothing), multiple spaces → single space
      expect(result).toBe('Empty backticks');
    });

    it('should handle text without backticks', () => {
      const result = normalizer.normalize('Plain text without any formatting');
      expect(result).toBe('Plain text without any formatting');
    });

    it('should handle unclosed backticks gracefully', () => {
      const result = normalizer.normalize('Unclosed `backtick here');
      expect(result).toBe('Unclosed `backtick here');
    });
  });

  describe('stripCodeFences - multi-line code fences', () => {
    it('should strip multi-line code fence with language tag', () => {
      const input = 'Here is code:\n```javascript\nconst x = 42;\n```\nDone';
      const result = normalizer.normalize(input);
      expect(result).toBe('Here is code:\nconst x = 42;\nDone');
    });

    it('should strip multi-line code fence without language tag', () => {
      const input = 'Start\n```\ncontent here\n```\nEnd';
      const result = normalizer.normalize(input);
      expect(result).toBe('Start\ncontent here\nEnd');
    });

    it('should handle multiple code fences', () => {
      const input = '```\nfirst\n```\nMiddle\n```\nsecond\n```';
      const result = normalizer.normalize(input);
      expect(result).toBe('first\nMiddle\nsecond');
    });

    it('should preserve content inside code fences', () => {
      const input = '```\nline 1\nline 2\nline 3\n```';
      const result = normalizer.normalize(input);
      expect(result).toBe('line 1\nline 2\nline 3');
    });

    it('should handle unclosed code fence gracefully', () => {
      const input = 'Start\n```javascript\ncode here\nno closing';
      const result = normalizer.normalize(input);
      // Unclosed fence: stripBackticks converts ```javascript to `javascript
      // (matches the middle backtick pair: `js`), leaving one backtick
      expect(result).toBe('Start\n`javascript\ncode here\nno closing');
    });
  });

  describe('stripCodeFences - single-line code fences', () => {
    it('should strip single-line code fence', () => {
      const result = normalizer.normalize('The answer is ```42``` units');
      expect(result).toBe('The answer is 42 units');
    });

    it('should strip multiple single-line code fences', () => {
      const result = normalizer.normalize('Values: ```foo```, ```bar```, ```baz```');
      expect(result).toBe('Values: foo, bar, baz');
    });

    it('should handle mixed single-line and multi-line fences', () => {
      const input = 'Inline ```foo``` and block:\n```\nbar\n```';
      const result = normalizer.normalize(input);
      // Multi-line fence strips first: ```\nbar\n``` → bar
      // Leaves: 'Inline ```foo and block:\nbar'
      // Single-line fence with newline after doesn't match pattern [^\n`]
      // Backtick stripping: ```foo matches as `...` → ...
      // Result: 'Inline `\nbar' (one backtick remains from ```)
      expect(result).toBe('Inline `\nbar');
    });
  });

  describe('normalizeWhitespace', () => {
    it('should collapse multiple spaces to single space', () => {
      const result = normalizer.normalize('foo    bar     baz');
      expect(result).toBe('foo bar baz');
    });

    it('should collapse tabs to single space', () => {
      const result = normalizer.normalize('foo\t\t\tbar');
      expect(result).toBe('foo bar');
    });

    it('should normalize CRLF to LF', () => {
      const result = normalizer.normalize('line1\r\nline2\r\nline3');
      expect(result).toBe('line1\nline2\nline3');
    });

    it('should normalize CR to LF', () => {
      const result = normalizer.normalize('line1\rline2\rline3');
      expect(result).toBe('line1\nline2\nline3');
    });

    it('should limit consecutive newlines to 2', () => {
      const result = normalizer.normalize('para1\n\n\n\n\npara2');
      expect(result).toBe('para1\n\npara2');
    });

    it('should trim leading and trailing whitespace', () => {
      const result = normalizer.normalize('  \n\n  content  \n\n  ');
      expect(result).toBe('content');
    });

    it('should preserve bullet list structure', () => {
      const input = '- item1\n- item2\n- item3';
      const result = normalizer.normalize(input);
      expect(result).toBe('- item1\n- item2\n- item3');
    });
  });

  describe('edge cases', () => {
    it('should handle empty string', () => {
      const result = normalizer.normalize('');
      expect(result).toBe('');
    });

    it('should handle only whitespace', () => {
      const result = normalizer.normalize('   \n\n\t  ');
      expect(result).toBe('');
    });

    it('should handle only backticks', () => {
      const result = normalizer.normalize('```');
      // Three backticks get matched as inline backtick pair: `...` → ...
      // Leaves one backtick: ``` → `
      expect(result).toBe('`');
    });

    it('should handle very long output efficiently', () => {
      const longText = 'a'.repeat(100000);
      const start = Date.now();
      const result = normalizer.normalize(longText);
      const elapsed = Date.now() - start;
      
      expect(result).toBe(longText);
      expect(elapsed).toBeLessThan(100); // Should be very fast
    });

    it('should handle complex markdown combinations', () => {
      const input = 'Start `inline` then\n```typescript\ncode\n```\nand `more`';
      const result = normalizer.normalize(input);
      expect(result).toBe('Start inline then\ncode\nand more');
    });

    it('should handle special characters inside backticks', () => {
      const result = normalizer.normalize('Command: `echo "hello $USER"`');
      expect(result).toBe('Command: echo "hello $USER"');
    });

    it('should handle backticks at string boundaries', () => {
      const result = normalizer.normalize('`starts here` middle `ends`');
      expect(result).toBe('starts here middle ends');
    });

    it('should handle nested backticks gracefully', () => {
      // This is malformed markdown, but should handle gracefully
      const result = normalizer.normalize('`outer `inner` outer`');
      // Will match first pair, leaving remainder
      expect(result).toContain('outer');
    });
  });

  describe('real-world agent output patterns', () => {
    it('should normalize continuePlanning with backticks', () => {
      const result = normalizer.normalize('`continuePlanning` = true');
      expect(result).toBe('continuePlanning = true');
    });

    it('should normalize reason with backticks', () => {
      const result = normalizer.normalize('- `reason`: Plan confidence is high');
      expect(result).toBe('- reason: Plan confidence is high');
    });

    it('should handle formatted decision output', () => {
      const input = '- `continuePlanning`: false\n- `reason`: All issues resolved\n- `next`: Proceed to implementation';
      const result = normalizer.normalize(input);
      expect(result).toBe('- continuePlanning: false\n- reason: All issues resolved\n- next: Proceed to implementation');
    });

    it('should handle code blocks in notes', () => {
      const input = 'Created function:\n```typescript\nfunction foo() { return 42; }\n```\nTested successfully';
      const result = normalizer.normalize(input);
      expect(result).toBe('Created function:\nfunction foo() { return 42; }\nTested successfully');
    });

    it('should handle markdown lists with inline code', () => {
      const input = '- Set `rigorMode` to THOROUGH\n- Update `maxQuestions` to 5\n- Verify `planConfidence` >= 8';
      const result = normalizer.normalize(input);
      expect(result).toBe('- Set rigorMode to THOROUGH\n- Update maxQuestions to 5\n- Verify planConfidence >= 8');
    });
  });

  describe('validation rule compatibility', () => {
    it('should make contains validation work with backticks', () => {
      const output = '`continuePlanning = true`';
      const normalized = normalizer.normalize(output);
      expect(normalized).toContain('continuePlanning = true');
    });

    it('should make contains validation work with code fence', () => {
      const output = '```\nreason: All tests passed\n```';
      const normalized = normalizer.normalize(output);
      expect(normalized).toContain('reason:');
    });

    it('should preserve content for length validation', () => {
      const output = 'Short text with `code` inside';
      const normalized = normalizer.normalize(output);
      // Length should be reasonable (backticks removed, content preserved)
      expect(normalized.length).toBeGreaterThan(10);
      expect(normalized.length).toBeLessThan(output.length);
    });
  });

  describe('determinism', () => {
    it('should return same output for same input', () => {
      const input = '`foo` ```\nbar\n``` baz';
      const result1 = normalizer.normalize(input);
      const result2 = normalizer.normalize(input);
      expect(result1).toBe(result2);
    });

    it('should be order-independent for whitespace', () => {
      const input1 = 'foo   bar\n\n\nbaz';
      const input2 = 'foo bar\n\nbaz'; // Already partially normalized
      const result1 = normalizer.normalize(input1);
      const result2 = normalizer.normalize(input2);
      expect(result1).toBe(result2);
    });
  });

  describe('performance', () => {
    it('should handle large outputs without catastrophic backtracking', () => {
      // Potential DoS: many backticks
      const manyBackticks = '`a`'.repeat(10000);
      const start = Date.now();
      const result = normalizer.normalize(manyBackticks);
      const elapsed = Date.now() - start;
      
      expect(result).toBe('a'.repeat(10000));
      expect(elapsed).toBeLessThan(500); // Should complete quickly
    });

    it('should handle deeply nested structures efficiently', () => {
      const nested = '```\n'.repeat(100) + 'content' + '\n```'.repeat(100);
      const start = Date.now();
      normalizer.normalize(nested);
      const elapsed = Date.now() - start;
      
      expect(elapsed).toBeLessThan(100);
    });
  });
});
