import { expect, test } from 'vitest';
import { updateAge, type ImmutableUser } from '../src/index';

test('updates age by returning a new object and leaving original intact', () => {
  const original: ImmutableUser = { id: '1', name: 'Alice', age: 30 };
  const updated = updateAge(original, 31);
  
  expect(updated.age).toBe(31);
  expect(updated.id).toBe('1');
  expect(updated.name).toBe('Alice');
  expect(original.age).toBe(30); // Ensures original is not mutated
  expect(updated).not.toBe(original); // Ensures copy was created to respect typescript readonly
});
