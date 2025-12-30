#!/usr/bin/env npx ts-node

/**
 * Lock Coverage Generator
 *
 * Determinism locks (docs/design/v2-core-design-locks.md:1289-1295):
 * - Stable ordering
 * - No timestamps in generated content
 * - Stable formatting
 *
 * This script generates an enforcement coverage report by:
 * 1. Reading the lock registry (docs/design/v2-lock-registry.json)
 * 2. Scanning test files for @enforces annotations
 * 3. Producing deterministic coverage outputs under docs/generated/
 *
 * Usage:
 *   npx ts-node scripts/generate-lock-coverage.ts           # Generate markdown + closure plan
 *   npx ts-node scripts/generate-lock-coverage.ts --json    # Generate JSON + closure plan
 *   npx ts-node scripts/generate-lock-coverage.ts --check   # CI mode: fail if coverage gaps
 *
 * Test annotation format:
 *   /**
 *    * @enforces lock-id-here
 *    * @enforces another-lock-id
 *    *\/
 *   describe('...', () => { ... });
 */

import * as fs from 'fs';
import * as path from 'path';

// Types
interface Lock {
  id: string;
  source: string;
  summary: string;
  category: string;
}

interface LockRegistry {
  version: string;
  locks: Lock[];
  categories: Record<string, string>;
}

interface TestAnnotation {
  lockId: string;
  testFile: string;
  line: number;
}

interface CoverageReport {
  registryVersion: string;
  totalLocks: number;
  coveredLocks: number;
  uncoveredLocks: number;
  coveragePercent: number;
  byCategory: Record<string, { total: number; covered: number; uncovered: string[] }>;
  covered: Array<{ lockId: string; tests: string[] }>;
  uncovered: Array<{ lockId: string; source: string; summary: string; category: string }>;
  warnings: string[];
}

// Constants
const ROOT_DIR = path.resolve(__dirname, '..');
const LOCK_REGISTRY_PATH = path.join(ROOT_DIR, 'docs/design/v2-lock-registry.json');
const TEST_DIRS = [
  path.join(ROOT_DIR, 'tests/unit/v2'),
  path.join(ROOT_DIR, 'tests/architecture'),
  path.join(ROOT_DIR, 'tests/integration'),
];
const OUTPUT_PATH = path.join(ROOT_DIR, 'docs/generated/v2-lock-coverage.md');
const OUTPUT_JSON_PATH = path.join(ROOT_DIR, 'docs/generated/v2-lock-coverage.json');
const OUTPUT_PLAN_PATH = path.join(ROOT_DIR, 'docs/generated/v2-lock-closure-plan.md');

// Parse command line args
const args = process.argv.slice(2);
const checkMode = args.includes('--check');
const jsonMode = args.includes('--json');

function readLockRegistry(): LockRegistry {
  const content = fs.readFileSync(LOCK_REGISTRY_PATH, 'utf-8');
  return JSON.parse(content) as LockRegistry;
}

function findTestFiles(dirs: readonly string[]): string[] {
  const files: string[] = [];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...findTestFiles([fullPath]));
      } else if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts')) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function extractEnforcesAnnotations(filePath: string): TestAnnotation[] {
  // Skip the coverage test itself
  if (filePath.includes('v2-lock-coverage.test.ts')) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const annotations: TestAnnotation[] = [];

  // Match @enforces only in JSDoc comment lines (lines with * prefix after whitespace)
  const enforcesRegex = /^\s*\*\s*@enforces\s+([a-z0-9-]+)/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = enforcesRegex.exec(line);
    if (match) {
      annotations.push({
        lockId: match[1].toLowerCase(),
        testFile: path.relative(ROOT_DIR, filePath),
        line: i + 1,
      });
    }
  }

  return annotations;
}

function generateCoverageReport(registry: LockRegistry, annotations: readonly TestAnnotation[]): CoverageReport {
  const locksSorted = [...registry.locks].sort((a, b) => a.id.localeCompare(b.id));
  const lockIds = new Set(locksSorted.map((l) => l.id));
  const annotationsByLock = new Map<string, string[]>();
  const warnings: string[] = [];

  for (const annotation of annotations) {
    if (!lockIds.has(annotation.lockId)) {
      warnings.push(`Unknown lock ID "${annotation.lockId}" in ${annotation.testFile}:${annotation.line}`);
      continue;
    }

    const existing = annotationsByLock.get(annotation.lockId) ?? [];
    existing.push(annotation.testFile);
    annotationsByLock.set(annotation.lockId, existing);
  }

  const covered: Array<{ lockId: string; tests: string[] }> = [];
  const uncovered: Array<{ lockId: string; source: string; summary: string; category: string }> = [];

  for (const lock of locksSorted) {
    const tests = annotationsByLock.get(lock.id);
    if (tests && tests.length > 0) {
      covered.push({ lockId: lock.id, tests: [...new Set(tests)].sort() });
    } else {
      uncovered.push({
        lockId: lock.id,
        source: lock.source,
        summary: lock.summary,
        category: lock.category,
      });
    }
  }

  covered.sort((a, b) => a.lockId.localeCompare(b.lockId));
  uncovered.sort((a, b) => a.lockId.localeCompare(b.lockId));

  const byCategory: Record<string, { total: number; covered: number; uncovered: string[] }> = {};
  for (const catId of Object.keys(registry.categories).sort()) {
    const catLocks = locksSorted.filter((l) => l.category === catId);
    const catCovered = catLocks.filter((l) => annotationsByLock.has(l.id));
    const catUncovered = catLocks.filter((l) => !annotationsByLock.has(l.id)).map((l) => l.id).sort();

    byCategory[catId] = {
      total: catLocks.length,
      covered: catCovered.length,
      uncovered: catUncovered,
    };
  }

  const totalLocks = locksSorted.length;
  const coveredCount = covered.length;

  return {
    registryVersion: registry.version,
    totalLocks,
    coveredLocks: coveredCount,
    uncoveredLocks: totalLocks - coveredCount,
    coveragePercent: Math.round((coveredCount / totalLocks) * 100),
    byCategory,
    covered,
    uncovered,
    warnings: warnings.sort(),
  };
}

function formatMarkdownReport(report: CoverageReport): string {
  const lines: string[] = [];

  lines.push('# v2 Lock Enforcement Coverage Report');
  lines.push('');
  lines.push('> **Auto-generated** — Do not edit manually.');
  lines.push(`> Registry version: ${report.registryVersion}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Total locks | ${report.totalLocks} |`);
  lines.push(`| Covered | ${report.coveredLocks} |`);
  lines.push(`| Uncovered | ${report.uncoveredLocks} |`);
  lines.push(`| Coverage | **${report.coveragePercent}%** |`);
  lines.push('');

  lines.push('## Coverage by Category');
  lines.push('');
  lines.push('| Category | Total | Covered | % |');
  lines.push('|----------|-------|---------|---|');
  for (const catId of Object.keys(report.byCategory).sort()) {
    const data = report.byCategory[catId]!;
    const pct = data.total > 0 ? Math.round((data.covered / data.total) * 100) : 0;
    lines.push(`| ${catId} | ${data.total} | ${data.covered} | ${pct}% |`);
  }
  lines.push('');

  if (report.uncovered.length > 0) {
    lines.push('## Uncovered Locks (Action Required)');
    lines.push('');
    lines.push('These locks have no `@enforces` annotations in any test file:');
    lines.push('');
    lines.push('| Lock ID | Category | Summary |');
    lines.push('|---------|----------|---------|');
    for (const lock of report.uncovered) {
      lines.push(`| \`${lock.lockId}\` | ${lock.category} | ${lock.summary} |`);
    }
    lines.push('');
    lines.push('To fix: Add `@enforces <lock-id>` to test file JSDoc comments.');
    lines.push('');
  }

  if (report.covered.length > 0) {
    lines.push('## Covered Locks');
    lines.push('');
    lines.push('<details>');
    lines.push(`<summary>Click to expand (${report.covered.length} locks)</summary>`);
    lines.push('');
    lines.push('| Lock ID | Test Files |');
    lines.push('|---------|------------|');
    for (const lock of report.covered) {
      const files = lock.tests.map((f) => `\`${f}\``).join(', ');
      lines.push(`| \`${lock.lockId}\` | ${files} |`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  if (report.warnings.length > 0) {
    lines.push('## Warnings');
    lines.push('');
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## How to Add Coverage');
  lines.push('');
  lines.push('Add `@enforces` annotations to your test files:');
  lines.push('');
  lines.push('```typescript');
  lines.push('/**');
  lines.push(' * @enforces event-index-zero-based');
  lines.push(' * @enforces event-index-monotonic-contiguous');
  lines.push(' */');
  lines.push("describe('session event ordering', () => {");
  lines.push('  // tests that verify these locks...');
  lines.push('});');
  lines.push('```');
  lines.push('');
  lines.push('Then run: `npm run generate:locks`');
  lines.push('');

  return lines.join('\n');
}

type CategoryPriority = { readonly category: string; readonly title: string };

const CATEGORY_PRIORITY: readonly CategoryPriority[] = [
  { category: 'protocol', title: 'Protocol (MCP correctness semantics)' },
  { category: 'storage', title: 'Storage (append-only truth substrate)' },
  { category: 'tokens', title: 'Tokens (format, signing, keyring)' },
  { category: 'errors', title: 'Errors (unified envelope + mapping)' },
  { category: 'bundle', title: 'Bundle (export/import portability)' },
  { category: 'schema', title: 'Schema (closed sets, versioning, budgets)' },
  { category: 'model', title: 'Model (derived semantics)' },
  { category: 'types', title: 'Types (branded identifiers)' },
  { category: 'projection', title: 'Projections (deterministic read models)' },
  { category: 'hashing', title: 'Hashing (JCS + sha256)' },
  { category: 'architecture', title: 'Architecture (layering boundaries)' },
] as const;

function suggestionForLock(lockId: string, category: string): { readonly files: string[]; readonly note?: string } {
  // Deterministic suggestions: single best “home” file (existing or to-be-created).
  // The goal is to reduce decision churn for newcomers while keeping the plan stable.
  switch (category) {
    case 'protocol':
      return {
        files: ['tests/unit/v2/v2-execution-protocol.test.ts'],
        note: 'May require implementing missing protocol behavior before tests can pass.',
      };
    case 'storage':
      if (lockId === 'paths-relative-only') return { files: ['tests/unit/v2/session-manifest-schema.test.ts'] };
      if (lockId === 'data-dir-workrail-owned') {
        return {
          files: ['tests/unit/v2/data-dir.test.ts'],
          note: 'Requires a precise definition of “WorkRail-owned default”.',
        };
      }
      if (lockId === 'projection-cache-rebuildable') {
        return {
          files: ['tests/unit/v2/projection-cache.test.ts'],
          note: 'If cache is not implemented yet, implement minimal rebuildable cache semantics first.',
        };
      }
      return { files: ['tests/unit/v2/session-store.test.ts'] };
    case 'tokens':
      return { files: ['tests/unit/v2/tokens.test.ts'] };
    case 'errors':
      return {
        files: ['tests/unit/v2/mcp-error-envelope.test.ts'],
        note: 'Prefer testing handler outputs (envelope shape) over implementation details.',
      };
    case 'bundle':
      return {
        files: ['tests/unit/v2/export-bundle-schema.test.ts'],
        note: 'If bundle schemas are not implemented, implement minimal schemas first.',
      };
    case 'schema':
      if (lockId.startsWith('snapshot-')) return { files: ['tests/unit/v2/execution-snapshot.test.ts'] };
      if (lockId.endsWith('-closed-set') || lockId.startsWith('schema-') || lockId === 'reason-code-unified') {
        return { files: ['tests/unit/v2/schema-locks.test.ts'] };
      }
      return { files: ['tests/unit/v2/schema-locks.test.ts'] };
    case 'model':
      if (lockId.startsWith('gaps-')) return { files: ['tests/unit/v2/gaps-projection.test.ts'] };
      if (lockId.startsWith('preferences-')) return { files: ['tests/unit/v2/preferences-projection.test.ts'] };
      return { files: ['tests/unit/v2/run-status-signals-projection.test.ts'] };
    case 'types':
      return { files: ['tests/unit/v2/ids.test.ts'] };
    default:
      return { files: ['tests/unit/v2/schema-locks.test.ts'] };
  }
}

function formatClosurePlanMarkdown(registry: LockRegistry, report: CoverageReport): string {
  const lines: string[] = [];

  lines.push('# v2 Lock Closure Plan');
  lines.push('');
  lines.push('> **Auto-generated** — Do not edit manually.');
  lines.push(`> Registry version: ${report.registryVersion}`);
  lines.push('');
  lines.push('This file is a deterministic “what to do next” plan for driving **uncovered locks → 0**.');
  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push(`- Total locks: **${report.totalLocks}**`);
  lines.push(`- Covered: **${report.coveredLocks}**`);
  lines.push(`- Uncovered: **${report.uncoveredLocks}**`);
  lines.push('');

  lines.push('## Uncovered locks by priority');
  lines.push('');
  lines.push('Rule: add `@enforces <lockId>` only when the test truly asserts the invariant.');
  lines.push('');

  const uncoveredByCategory = new Map<string, Array<{ lockId: string; source: string; summary: string }>>();
  for (const u of report.uncovered) {
    const existing = uncoveredByCategory.get(u.category) ?? [];
    existing.push({ lockId: u.lockId, source: u.source, summary: u.summary });
    uncoveredByCategory.set(u.category, existing);
  }
  for (const [cat, list] of uncoveredByCategory) {
    list.sort((a, b) => a.lockId.localeCompare(b.lockId));
    uncoveredByCategory.set(cat, list);
  }

  for (const { category, title } of CATEGORY_PRIORITY) {
    const list = uncoveredByCategory.get(category);
    if (!list || list.length === 0) continue;

    const catDesc = registry.categories?.[category] ?? category;
    lines.push(`### ${title}`);
    lines.push('');
    lines.push(`- Category: \`${category}\` — ${catDesc}`);
    lines.push(`- Uncovered: **${list.length}**`);
    lines.push('');
    lines.push('| Lock ID | Summary | Suggested test file(s) | Notes |');
    lines.push('|--------|---------|------------------------|-------|');

    for (const item of list) {
      const suggestion = suggestionForLock(item.lockId, category);
      const files = suggestion.files.map((f) => `\`${f}\``).join(', ');
      const note = suggestion.note ?? '';
      lines.push(`| \`${item.lockId}\` | ${item.summary} | ${files} | ${note} |`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## How to close a lock');
  lines.push('');
  lines.push('1. Add or extend a test that **asserts** the invariant.');
  lines.push('2. Add `@enforces <lockId>` in that test file JSDoc comment.');
  lines.push('3. Run `npm run generate:locks` and ensure uncovered locks decrease.');
  lines.push('');

  return lines.join('\n');
}

function main(): void {
  console.log('Reading lock registry...');
  const registry = readLockRegistry();
  console.log(`  Found ${registry.locks.length} locks`);

  console.log('Scanning test files...');
  const testFiles = findTestFiles(TEST_DIRS);
  console.log(`  Found ${testFiles.length} test files`);

  console.log('Extracting @enforces annotations...');
  const annotations: TestAnnotation[] = [];
  for (const file of testFiles) {
    annotations.push(...extractEnforcesAnnotations(file));
  }
  console.log(`  Found ${annotations.length} annotations`);

  console.log('Generating coverage report...');
  const report = generateCoverageReport(registry, annotations);

  if (jsonMode) {
    const jsonOutput = JSON.stringify(report, null, 2);
    fs.mkdirSync(path.dirname(OUTPUT_JSON_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_JSON_PATH, jsonOutput);
    console.log(`Wrote JSON report to ${OUTPUT_JSON_PATH}`);
  } else {
    const markdown = formatMarkdownReport(report);
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, markdown);
    console.log(`Wrote report to ${OUTPUT_PATH}`);
  }

  // Always write the closure plan markdown (deterministic “next actions”)
  const plan = formatClosurePlanMarkdown(registry, report);
  fs.mkdirSync(path.dirname(OUTPUT_PLAN_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PLAN_PATH, plan);
  console.log(`Wrote closure plan to ${OUTPUT_PLAN_PATH}`);

  console.log('');
  console.log(`Coverage: ${report.coveredLocks}/${report.totalLocks} (${report.coveragePercent}%)`);

  if (report.warnings.length > 0) {
    console.log('');
    console.log('Warnings:');
    for (const w of report.warnings) {
      console.log(`  - ${w}`);
    }
  }

  if (checkMode && report.uncovered.length > 0) {
    console.log('');
    console.error(`ERROR: ${report.uncovered.length} locks have no test coverage`);
    console.error('Uncovered locks:');
    for (const lock of report.uncovered.slice(0, 10)) {
      console.error(`  - ${lock.lockId}: ${lock.summary}`);
    }
    if (report.uncovered.length > 10) {
      console.error(`  ... and ${report.uncovered.length - 10} more`);
    }
    process.exit(1);
  }

  console.log('');
  console.log('Done!');
}

main();
