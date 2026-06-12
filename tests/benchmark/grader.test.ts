import { expect, test, describe, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  createSandboxWorkspace,
  cleanupSandboxWorkspace,
  runCommandWithTimeout
} from './sandbox.js';
import {
  gradeWorkspace
} from './grader.js';

describe('progressive grader & sandbox validation', () => {
  const testCorpusRoot = path.join(__dirname, 'corpus');
  const favorable1Template = path.join(testCorpusRoot, 'favorable-1');

  test('sandbox creation and cleanup', () => {
    const sandboxRes = createSandboxWorkspace('fav1-test', favorable1Template);
    expect(sandboxRes.ok).toBe(true);
    
    if (sandboxRes.ok) {
      const sandboxDir = sandboxRes.dir;
      expect(fs.existsSync(sandboxDir)).toBe(true);
      expect(fs.existsSync(path.join(sandboxDir, 'tsconfig.json'))).toBe(true);
      expect(fs.existsSync(path.join(sandboxDir, 'src/index.ts'))).toBe(true);

      cleanupSandboxWorkspace(sandboxDir);
      expect(fs.existsSync(sandboxDir)).toBe(false);
    }
  });

  test('subprocess command timeout execution', async () => {
    // A command that sleeps for 10 seconds should time out in 1 second
    const result = await runCommandWithTimeout('sleep 10', __dirname, 1000);
    expect(result.timedOut).toBe(true);
  });

  test('grading a stub/unsolved template', async () => {
    const sandboxRes = createSandboxWorkspace('fav1-stub', favorable1Template);
    expect(sandboxRes.ok).toBe(true);

    if (sandboxRes.ok) {
      const sandboxDir = sandboxRes.dir;
      try {
        const gradeRes = await gradeWorkspace(sandboxDir, favorable1Template);
        // The stub processSequence returns 0, failing all tests. So it should return ok: false with score 0.6
        expect(gradeRes.ok).toBe(false);
        expect(gradeRes.score).toBe(0.6); // 0.6 + 0.4 * (0/3) = 0.6
        if (!gradeRes.ok) {
          expect(gradeRes.error).toContain('Passed 0/3 assertions');
        }
      } finally {
        cleanupSandboxWorkspace(sandboxDir);
      }
    }
  });

  test('grading a syntax-error workspace', async () => {
    const sandboxRes = createSandboxWorkspace('fav1-syntax', favorable1Template);
    expect(sandboxRes.ok).toBe(true);

    if (sandboxRes.ok) {
      const sandboxDir = sandboxRes.dir;
      try {
        // Inject a syntax error into src/index.ts
        fs.writeFileSync(path.join(sandboxDir, 'src/index.ts'), 'export function processSequence(input: number): number { const invalid = ; return 0; }');
        const gradeRes = await gradeWorkspace(sandboxDir, favorable1Template);
        expect(gradeRes.ok).toBe(false);
        expect(gradeRes.score).toBe(0.0);
        if (!gradeRes.ok) {
          expect(gradeRes.error).toContain('[SYNTAX ERROR]');
        }
      } finally {
        cleanupSandboxWorkspace(sandboxDir);
      }
    }
  });

  test('grading a compilation-error workspace', async () => {
    const sandboxRes = createSandboxWorkspace('fav1-compile', favorable1Template);
    expect(sandboxRes.ok).toBe(true);

    if (sandboxRes.ok) {
      const sandboxDir = sandboxRes.dir;
      try {
        // Inject a compilation type error (assigning string to number)
        fs.writeFileSync(path.join(sandboxDir, 'src/index.ts'), 'export function processSequence(input: number): number { return "not-a-number" as any as number; }');
        // Wait, "as any as number" passes compilation! Let's do:
        fs.writeFileSync(path.join(sandboxDir, 'src/index.ts'), 'export function processSequence(input: number): number { return "not-a-number"; }');
        const gradeRes = await gradeWorkspace(sandboxDir, favorable1Template);
        expect(gradeRes.ok).toBe(false);
        expect(gradeRes.score).toBe(0.1);
        if (!gradeRes.ok) {
          expect(gradeRes.error).toContain('[COMPILATION ERROR]');
        }
      } finally {
        cleanupSandboxWorkspace(sandboxDir);
      }
    }
  });

  test('grading a fully successful workspace', async () => {
    const sandboxRes = createSandboxWorkspace('fav1-success', favorable1Template);
    expect(sandboxRes.ok).toBe(true);

    if (sandboxRes.ok) {
      const sandboxDir = sandboxRes.dir;
      try {
        // Inject a correct solution
        const solution = `
export function processSequence(input: number): number {
  const stage1 = input + 3;
  const stage2 = stage1 * 2;
  return input < 0 ? -stage2 : stage2;
}
`;
        fs.writeFileSync(path.join(sandboxDir, 'src/index.ts'), solution);
        const gradeRes = await gradeWorkspace(sandboxDir, favorable1Template);
        expect(gradeRes.ok).toBe(true);
        expect(gradeRes.score).toBe(1.0);
        if (gradeRes.ok) {
          expect(gradeRes.passed).toBe(3);
          expect(gradeRes.total).toBe(3);
        }
      } finally {
        cleanupSandboxWorkspace(sandboxDir);
      }
    }
  });
});
