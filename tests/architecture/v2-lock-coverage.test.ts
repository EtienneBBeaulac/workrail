/**
 * v2 Lock Coverage CI Test
 *
 * This test verifies that all design locks have corresponding test coverage.
 * It reads the lock registry and scans test files for @enforces annotations.
 *
 * Purpose:
 * - Fail CI if any lock has zero coverage (prevents uncovered locks from shipping)
 * - Generate coverage report as a side effect
 *
 * Usage:
 * - Run as part of normal test suite: npm test
 * - Run standalone: npm test -- tests/architecture/v2-lock-coverage.test.ts
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT_DIR = path.resolve(__dirname, '../..');
const LOCK_REGISTRY_PATH = path.join(ROOT_DIR, 'docs/design/v2-lock-registry.json');
const TEST_DIRS = [
  path.join(ROOT_DIR, 'tests/unit/v2'),
  path.join(ROOT_DIR, 'tests/architecture'),
  path.join(ROOT_DIR, 'tests/integration'),
];

interface Lock {
  id: string;
  source: string;
  summary: string;
  category: string;
}

interface LockRegistry {
  version: string;
  locks: Lock[];
}

interface TestAnnotation {
  lockId: string;
  testFile: string;
}

function findTestFiles(dirs: string[]): string[] {
  const files: string[] = [];
  
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    
    const entries = fs.readdirSync(dir, { withFileTypes: true });
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
  // Skip this file to avoid self-referential matching
  if (filePath.includes('v2-lock-coverage.test.ts')) {
    return [];
  }
  
  const content = fs.readFileSync(filePath, 'utf-8');
  const annotations: TestAnnotation[] = [];
  
  // Only match @enforces in JSDoc comments (lines starting with * after whitespace)
  const enforcesRegex = /^\s*\*\s*@enforces\s+([a-z0-9-]+)/gim;
  let match;
  while ((match = enforcesRegex.exec(content)) !== null) {
    annotations.push({
      lockId: match[1].toLowerCase(),
      testFile: path.relative(ROOT_DIR, filePath),
    });
  }
  
  return annotations;
}

describe('v2 Lock Coverage', () => {
  const registry: LockRegistry = JSON.parse(fs.readFileSync(LOCK_REGISTRY_PATH, 'utf-8'));
  const lockIds = new Set(registry.locks.map(l => l.id));
  
  const testFiles = findTestFiles(TEST_DIRS);
  const annotations: TestAnnotation[] = [];
  for (const file of testFiles) {
    annotations.push(...extractEnforcesAnnotations(file));
  }
  
  const annotationsByLock = new Map<string, string[]>();
  const unknownLocks: string[] = [];
  
  for (const annotation of annotations) {
    if (!lockIds.has(annotation.lockId)) {
      unknownLocks.push(`${annotation.lockId} in ${annotation.testFile}`);
      continue;
    }
    
    const existing = annotationsByLock.get(annotation.lockId) || [];
    existing.push(annotation.testFile);
    annotationsByLock.set(annotation.lockId, existing);
  }
  
  const coveredLocks = [...annotationsByLock.keys()];
  const uncoveredLocks = registry.locks.filter(l => !annotationsByLock.has(l.id) && !(l as any).obsolete);
  
  it('all @enforces annotations reference valid lock IDs', () => {
    expect(unknownLocks).toEqual([]);
  });
  
  it('reports coverage statistics', () => {
    const total = registry.locks.length;
    const covered = coveredLocks.length;
    const percent = Math.round((covered / total) * 100);
    
    console.log(`\n📊 Lock Coverage: ${covered}/${total} (${percent}%)`);
    console.log(`   Covered: ${covered}`);
    console.log(`   Uncovered: ${total - covered}`);
    
    // Group uncovered by category
    const byCategory = new Map<string, Lock[]>();
    for (const lock of uncoveredLocks) {
      const existing = byCategory.get(lock.category) || [];
      existing.push(lock);
      byCategory.set(lock.category, existing);
    }
    
    if (uncoveredLocks.length > 0) {
      console.log('\n⚠️  Uncovered locks by category:');
      for (const [category, locks] of byCategory) {
        console.log(`   ${category}: ${locks.length}`);
        for (const lock of locks.slice(0, 3)) {
          console.log(`     - ${lock.id}`);
        }
        if (locks.length > 3) {
          console.log(`     ... and ${locks.length - 3} more`);
        }
      }
    }
    
    // Always pass—this test is informational
    expect(true).toBe(true);
  });
  
  it('all locks have test coverage (zero tolerance)', () => {
    const uncoveredIds = uncoveredLocks.map((l) => l.id);
    expect(uncoveredIds).toEqual([]);
  });
});
