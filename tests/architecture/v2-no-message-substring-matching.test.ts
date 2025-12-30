/**
 * v2 No Message Substring Matching
 *
 * Enforces "errors are data" by forbidding control-flow based on error message text.
 * v2 code must branch on structured error codes (e.g., FsError.code), not message substrings.
 *
 * @enforces errors-as-data
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const V2_SOURCE_DIRS = [
  path.resolve(__dirname, '../../src/v2'),
];

function findAllTypeScriptFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findAllTypeScriptFiles(fullPath));
    } else if (entry.name.endsWith('.ts')) {
      results.push(fullPath);
    }
  }

  return results;
}

describe('v2 No Message Substring Matching', () => {
  it('forbids .message.includes( in v2 source code', () => {
    const files: string[] = [];
    for (const dir of V2_SOURCE_DIRS) {
      if (fs.existsSync(dir)) {
        files.push(...findAllTypeScriptFiles(dir));
      }
    }

    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes('.message.includes(')) {
          violations.push({
            file: path.relative(path.resolve(__dirname, '../../'), file),
            line: i + 1,
            text: line.trim(),
          });
        }
      }
    }

    if (violations.length > 0) {
      const formatted = violations
        .map((v) => `${v.file}:${v.line}  ${v.text}`)
        .join('\n  ');

      throw new Error(
        `Found .message.includes( in v2 source code (violates errors-as-data):\n  ${formatted}\n\n` +
          `v2 code must branch on structured error codes (e.g., error.code === 'FS_NOT_FOUND'), not message substrings.`
      );
    }

    expect(violations).toEqual([]);
  });
});
