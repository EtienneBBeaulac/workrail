import { expect, test } from 'vitest';
import { findDuplicates } from '../src/index';

test('finds duplicates in numbers array', () => {
  expect(findDuplicates([1, 2, 3, 2, 4, 3, 5])).toEqual([2, 3]);
});

test('finds duplicates in strings array', () => {
  expect(findDuplicates(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b']);
});

test('returns empty array when no duplicates exist', () => {
  expect(findDuplicates([1, 2, 3, 4, 5])).toEqual([]);
});
