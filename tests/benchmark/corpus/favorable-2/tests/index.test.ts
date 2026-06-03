import { expect, test } from 'vitest';
import { refineData } from '../src/index';

test('filters records with empty id', () => {
  const result = refineData([
    { id: '1', name: 'alice', value: '100' },
    { id: '', name: 'bob', value: '20' },
  ]);
  expect(result.length).toBe(1);
  expect(result[0]!.id).toBe('1');
});

test('formats names to title case or defaults to Unknown', () => {
  const result = refineData([
    { id: '1', name: '  charlie  ', value: '10' },
    { id: '2', value: '20' },
  ]);
  expect(result[0]!.name).toBe('Charlie');
  expect(result[1]!.name).toBe('Unknown');
});

test('parses value as number and defaults to 0 on failure', () => {
  const result = refineData([
    { id: '1', name: 'alice', value: '123' },
    { id: '2', name: 'bob', value: 'not-a-number' },
  ]);
  expect(result[0]!.value).toBe(123);
  expect(result[1]!.value).toBe(0);
});
