/**
 * Type escape quarantine enforcement.
 *
 * @enforces type-escapes-quarantined
 *
 * Rule N3: no `as any` in v2 code except explicitly quarantined paths.
 *
 * Rationale:
 * - Type safety as first line of defense (philosophy core principle)
 * - Escape hatches must be explicit and documented
 * - Prevents cargo-culting of type unsafety across the codebase
 *
 * Allowed escape hatches:
 * - `src/v2/read-only/**`: transitional shim to v1 code
 *
 * Any new escape hatch must be:
 * 1. Added to ALLOWED_ESCAPES below
 * 2. Accompanied by a WHY comment in the source code
 * 3. Discussed and approved in design review
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const V2_ROOT = path.join(__dirname, '../../src/v2');

/**
 * Paths where `as any` is explicitly permitted (with justification).
 * Paths use glob-like patterns (must match file path).
 */
const ALLOWED_ESCAPES = [
  'src/v2/read-only/**', // transitional shim to v1; will be removed in future refactor
];

/**
 * Checks if a file path matches any of the allowed escape glob patterns.
 */
function isAllowedEscape(filePath: string): boolean {
  // Normalize paths for cross-platform matching (Windows uses backslashes).
  const normalized = filePath.replace(/\\/g, '/');
  return ALLOWED_ESCAPES.some((pattern) => {
    // Convert glob pattern to regex: src/v2/read-only/** -> matches anything in that dir
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape special regex chars
      .replace(/\*\*/g, '.*'); // ** -> .* (any chars)
    const regex = new RegExp(`^.*${regexPattern}$`);
    return regex.test(normalized);
  });
}

/**
 * Get all TypeScript files in a directory recursively.
 */
function getAllTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllTsFiles(fullPath));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('v2 type-escape quarantine', () => {
  it('no `as any` outside quarantined paths', () => {
    const files = getAllTsFiles(V2_ROOT);
    const violations: string[] = [];

    for (const file of files) {
      // Skip allowed escapes
      if (isAllowedEscape(file)) continue;

      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // Skip comment-only lines (design notes shouldn't trigger violations)
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        
        // Look for `as any` pattern (word boundary ensures we match the actual pattern)
        if (/\bas\s+any\b/.test(line)) {
          const relativePath = path.relative(process.cwd(), file);
          violations.push(`  ${relativePath}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    if (violations.length > 0) {
      const message = [
        'Found `as any` outside quarantined paths (Rule N3 violation):',
        '',
        'Type escapes erode type safety via cargo-culting.',
        'All non-quarantined escapes must be fixed with type-safe narrowing.',
        '',
        'Violations:',
        ...violations,
        '',
        'Allowed escape paths:',
        ...ALLOWED_ESCAPES.map((p) => `  - ${p}`),
      ].join('\n');

      expect.fail(message);
    }

    // Sanity check: ensure at least some allowed files exist
    const allowedFiles = files.filter(f => isAllowedEscape(f));
    expect(allowedFiles.length).toBeGreaterThan(0);
  });

  it('verifies WHY comments exist for all allowed escapes', () => {
    const escapesRequiringWhy = [
      'src/v2/infra/local/fs/index.ts',
      'src/v2/infra/local/snapshot-store/index.ts',
    ];

    const violations: string[] = [];

    for (const escapePath of escapesRequiringWhy) {
      const fullPath = path.join(process.cwd(), escapePath);
      if (!fs.existsSync(fullPath)) {
        violations.push(`  File missing: ${escapePath}`);
        continue;
      }

      const content = fs.readFileSync(fullPath, 'utf-8');

      // Check if file has WHY comment for its `as any` usage
      // This is a soft check—it ensures developers are thinking about the escape
      if (content.includes('as any') && !content.includes('WHY:')) {
        violations.push(`  ${escapePath}: has \`as any\` but missing "WHY:" comment explaining rationale`);
      }
    }

    if (violations.length > 0) {
      const message = [
        'Found `as any` escapes without adequate documentation:',
        '',
        'All non-trivial escapes should include inline "WHY:" comments.',
        '',
        'Violations:',
        ...violations,
      ].join('\n');

      expect.fail(message);
    }
  });
});
