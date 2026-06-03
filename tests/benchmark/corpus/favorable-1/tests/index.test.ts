import { expect, test } from 'vitest';
import { processSequence } from '../src/index';

test('verifies positive input sequence processing', () => {
  expect(processSequence(5)).toBe(16);
});

test('verifies negative input sequence processing', () => {
  expect(processSequence(-2)).toBe(-2);
});

test('verifies zero input sequence processing', () => {
  expect(processSequence(0)).toBe(6);
});
