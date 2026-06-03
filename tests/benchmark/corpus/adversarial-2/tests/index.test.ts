import { expect, test } from 'vitest';
import { calculateAverage } from '../src/index';

test('calculates average of standard array', () => {
  expect(calculateAverage([1, 2, 3, 4])).toBe(2.5);
});

test('handles single-element array', () => {
  expect(calculateAverage([10])).toBe(10);
});

test('handles empty array by returning 0 (contrary to prompt assumption)', () => {
  expect(calculateAverage([])).toBe(0);
});
