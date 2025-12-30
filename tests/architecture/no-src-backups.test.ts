/**
 * Repo hygiene: forbid backup/scratch files under src/**.
 *
 * Rationale: anything under src/ can be accidentally shipped depending on build tooling.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT_DIR = path.resolve(__dirname, '../..');
const SRC_DIR = path.join(ROOT_DIR, 'src');

const FORBIDDEN_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: '*.bak', pattern: /\.bak$/ },
  { name: '*pre-wave1*', pattern: /pre-wave1/ },
  { name: '*.backup', pattern: /\.backup$/ },
];

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

describe('repo hygiene: no backup/scratch under src/', () => {
  it('contains no forbidden backup files', () => {
    const files = walkFiles(SRC_DIR);

    const forbiddenMatches: string[] = [];
    for (const file of files) {
      const rel = path.relative(ROOT_DIR, file);
      for (const rule of FORBIDDEN_PATTERNS) {
        if (rule.pattern.test(rel)) {
          forbiddenMatches.push(`${rel} (${rule.name})`);
        }
      }
    }

    expect(forbiddenMatches).toEqual([]);
  });
});
