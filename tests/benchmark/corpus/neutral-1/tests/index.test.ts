import { expect, test } from 'vitest';
import { calculate } from '../src/index';

test('adds and subtracts correctly', () => {
  expect(calculate(10, 5, 'add')).toBe(15);
  expect(calculate(10, 5, 'subtract')).toBe(5);
});

test('multiplies and divides correctly', () => {
  expect(calculate(4, 3, 'multiply')).toBe(12);
  expect(calculate(12, 3, 'divide')).toBe(4);
});

test('throws on division by zero', () => {
  expect(() => calculate(5, 0, 'divide')).toThrow('Division by zero');
});

test('throws on invalid operator', () => {
  expect(() => calculate(5, 5, 'invalid')).toThrow('Invalid operator');
});
