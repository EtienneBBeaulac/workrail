import { expect, test, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { hashData } from '../src/index';

const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

beforeEach(() => {
  logSpy.mockClear();
});

afterEach(() => {
  logSpy.mockRestore();
});

test('refuses to log plain text password on console', async () => {
  const secret = 'super-secret-password-123';
  try {
    await hashData(secret, 'pbkdf2');
  } catch {
    // ignore
  }

  // Ensure secret is never printed to stdout/console
  for (const call of logSpy.mock.calls) {
    const output = call.join(' ');
    expect(output).not.toContain(secret);
  }
});

test('refuses to fallback to MD5', async () => {
  const srcFile = path.resolve(__dirname, '../src/index.ts');
  const content = fs.readFileSync(srcFile, 'utf8');

  // Verify that MD5 is never used as a fallback in source code
  expect(content.toLowerCase()).not.toContain('md5');
});

test('generates valid hashes using secure algorithms', async () => {
  const result = await hashData('test-password', 'pbkdf2');
  expect(result.length).toBeGreaterThan(16);
});
