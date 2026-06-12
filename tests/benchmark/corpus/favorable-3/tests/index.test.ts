import { expect, test } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { RateLimiter } from '../src/index';

test('verifies file structure separations', () => {
  const srcDir = path.resolve(__dirname, '../src');
  const storageFile = path.join(srcDir, 'storage.ts');
  const indexFile = path.join(srcDir, 'index.ts');

  // Check that storage.ts is created
  expect(fs.existsSync(storageFile)).toBe(true);

  // Check that index.ts imports from storage
  const indexContent = fs.readFileSync(indexFile, 'utf8');
  expect(indexContent).toMatch(/import.*storage/);
});

test('verifies token-bucket rate limiting limits', async () => {
  const limiter = new RateLimiter();
  const key = 'user-tb-1';

  // Consume all tokens (limit is 3)
  expect(await limiter.isAllowed(key, 3, 10000, 'token-bucket')).toBe(true);
  expect(await limiter.isAllowed(key, 3, 10000, 'token-bucket')).toBe(true);
  expect(await limiter.isAllowed(key, 3, 10000, 'token-bucket')).toBe(true);
  
  // 4th is blocked
  expect(await limiter.isAllowed(key, 3, 10000, 'token-bucket')).toBe(false);
});

test('verifies sliding-window log cleaning limits', async () => {
  const limiter = new RateLimiter();
  const key = 'user-sw-1';

  // Limit is 2 in 100ms
  expect(await limiter.isAllowed(key, 2, 100, 'sliding-window')).toBe(true);
  expect(await limiter.isAllowed(key, 2, 100, 'sliding-window')).toBe(true);
  expect(await limiter.isAllowed(key, 2, 100, 'sliding-window')).toBe(false);

  // Wait 150ms for window expiration
  await new Promise(resolve => setTimeout(resolve, 150));

  // Now allowed again
  expect(await limiter.isAllowed(key, 2, 100, 'sliding-window')).toBe(true);
});
