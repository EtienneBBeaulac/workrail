import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { exec } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';
import { createWorkRailEngine } from '../../src/engine/index.js';
import type { StateToken, AckToken, EngineError } from '../../src/engine/types.js';

function getEngineErrorMessage(err: EngineError): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as any).message);
  }
  return JSON.stringify(err);
}

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export type GradingResult =
  | { readonly ok: true; readonly score: number; readonly passed: number; readonly total: number }
  | { readonly ok: false; readonly score: number; readonly error: string };

export interface TrialMetrics {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly turns: number;
  readonly commandRuns: number;
}

export interface TrialResult {
  readonly workflow: string;
  readonly approach: string;
  readonly model: string;
  readonly taskCategory: 'favorable' | 'neutral' | 'adversarial';
  readonly taskInstance: string;
  readonly seed: number;
  readonly score: number;
  readonly passed: number;
  readonly total: number;
  readonly error: string | null;
  readonly durationMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly turns: number;
  readonly commandRuns: number;
}

// ---------------------------------------------------------------------------
// Sandboxing & Cleanup Helpers
// ---------------------------------------------------------------------------

const activeSandboxes = new Set<string>();

export function registerCleanupHandlers(): void {
  const cleanupAll = () => {
    for (const dir of activeSandboxes) {
      try {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch {
        // ignore
      }
    }
  };
  process.on('exit', cleanupAll);
  process.on('SIGINT', () => {
    cleanupAll();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanupAll();
    process.exit(143);
  });
}

/**
 * Creates a sandbox workspace directory and copies task template files.
 */
export function createSandboxWorkspace(taskName: string, templateDir: string): { ok: true; dir: string } | { ok: false; error: string } {
  try {
    const sandboxRoot = path.join(__dirname, 'workspaces');
    if (!fs.existsSync(sandboxRoot)) {
      fs.mkdirSync(sandboxRoot, { recursive: true });
    }

    const runId = Math.random().toString(36).substring(2, 10);
    const sandboxDir = path.join(sandboxRoot, `run-${taskName}-${runId}`);

    // Copy template files recursively
    fs.cpSync(templateDir, sandboxDir, { recursive: true });
    activeSandboxes.add(sandboxDir);

    return { ok: true, dir: sandboxDir };
  } catch (err: any) {
    return { ok: false, error: `Failed to create sandbox: ${err.message}` };
  }
}

/**
 * Forcefully cleans up a sandbox workspace directory.
 */
export function cleanupSandboxWorkspace(sandboxDir: string): void {
  try {
    if (fs.existsSync(sandboxDir)) {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
    activeSandboxes.delete(sandboxDir);
  } catch {
    // Swallow cleanup errors to preserve process stability
  }
}

// ---------------------------------------------------------------------------
// Shell Command Invoker
// ---------------------------------------------------------------------------

/**
 * Spawns a shell command with a strict execution timeout.
 */
export function runCommandWithTimeout(
  cmd: string,
  cwd: string,
  timeoutMs = 5000
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    const proc = exec(cmd, { cwd }, (error, stdout, stderr) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: proc.exitCode !== null ? proc.exitCode : (error ? (error as any).code || 1 : 0),
        stdout,
        stderr,
        timedOut,
      });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (proc.pid !== undefined) {
          process.kill(-proc.pid, 'SIGKILL');
        } else {
          proc.kill('SIGKILL');
        }
      } catch {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Swallow kill errors
        }
      }
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Progressive Grading Logic
// ---------------------------------------------------------------------------

/**
 * Verifies syntax of all TS source files in a directory recursively.
 * Award score 0.1 if syntax passes but compilation/tests fail.
 */
function verifySyntaxInDir(dirPath: string): { ok: true } | { ok: false; error: string } {
  try {
    if (!fs.existsSync(dirPath)) {
      return { ok: false, error: `Directory not found at ${dirPath}` };
    }
    const checkFile = (file: string): { ok: true } | { ok: false; error: string } => {
      const content = fs.readFileSync(file, 'utf8');
      const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
      const diagnostics = (sourceFile as any).parseDiagnostics;
      if (diagnostics && diagnostics.length > 0) {
        const messages = diagnostics.map((d: any) => {
          if (typeof d.messageText === 'string') return d.messageText;
          return JSON.stringify(d.messageText);
        }).join('; ');
        return { ok: false, error: `File ${path.basename(file)}: ${messages}` };
      }
      return { ok: true };
    };
    
    const recurse = (dir: string): { ok: true } | { ok: false; error: string } => {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const full = path.join(dir, file);
        if (fs.statSync(full).isDirectory()) {
          const res = recurse(full);
          if (!res.ok) return res;
        } else if (file.endsWith('.ts')) {
          const res = checkFile(full);
          if (!res.ok) return res;
        }
      }
      return { ok: true };
    };
    
    return recurse(dirPath);
  } catch (err: any) {
    return { ok: false, error: `Syntax check error: ${err.message}` };
  }
}

/**
 * Grades a workspace using progressive compilation and unit tests.
 */
export async function gradeWorkspace(
  sandboxDir: string,
  templateDir: string
): Promise<GradingResult> {
  const srcDir = path.join(sandboxDir, 'src');
  const templateTestFile = path.join(templateDir, 'tests/index.test.ts');
  const templateConfig = path.join(templateDir, 'tsconfig.json');

  // Step 1: Syntax Validation (Score 0.0 on failure)
  const syntaxCheck = verifySyntaxInDir(srcDir);
  if (!syntaxCheck.ok) {
    return { ok: false, score: 0.0, error: `[SYNTAX ERROR] ${syntaxCheck.error}` };
  }

  // Step 2: Anti-Tampering Overwrite
  try {
    fs.cpSync(templateTestFile, path.join(sandboxDir, 'tests/index.test.ts'), { force: true });
    fs.cpSync(templateConfig, path.join(sandboxDir, 'tsconfig.json'), { force: true });
    
    const templateVitestConfig = path.join(templateDir, 'vitest.config.ts');
    if (fs.existsSync(templateVitestConfig)) {
      fs.cpSync(templateVitestConfig, path.join(sandboxDir, 'vitest.config.ts'), { force: true });
    }
  } catch (err: any) {
    return { ok: false, score: 0.1, error: `[ANTI-TAMPERING ERROR] Failed to restore test configs: ${err.message}` };
  }

  // Step 3: TypeScript Type Compilation (Score 0.1 on failure)
  const tscResult = await runCommandWithTimeout('npx tsc --noEmit --project tsconfig.json', sandboxDir, 5000);
  if (tscResult.exitCode !== 0 || tscResult.timedOut) {
    const errorMsg = tscResult.timedOut ? 'TypeScript compilation timed out.' : tscResult.stderr || tscResult.stdout;
    return { ok: false, score: 0.1, error: `[COMPILATION ERROR] ${errorMsg.trim()}` };
  }

  // Step 4: Run Vitest with JSON report (Score 0.3 on build/import failure)
  const reportPath = path.join(sandboxDir, 'vitest-report.json');
  const vitestCmd = `npx vitest run tests/index.test.ts --reporter=json --outputFile=${reportPath}`;
  const testResult = await runCommandWithTimeout(vitestCmd, sandboxDir, 5000);

  if (!fs.existsSync(reportPath)) {
    const errorMsg = testResult.timedOut ? 'Vitest execution timed out.' : testResult.stderr || testResult.stdout;
    return { ok: false, score: 0.3, error: `[TEST BUILD ERROR] ${errorMsg.trim()}` };
  }

  // Step 5: Parse Vitest JSON report for test pass rate (Score 0.6 to 1.0)
  try {
    const reportContent = fs.readFileSync(reportPath, 'utf8');
    const report = JSON.parse(reportContent);
    const total = report.numTotalTests || 0;
    const passed = report.numPassedTests || 0;

    if (total === 0) {
      return { ok: false, score: 0.3, error: '[TEST ERROR] No tests found in report.' };
    }

    const score = 0.6 + 0.4 * (passed / total);
    if (passed === total) {
      return { ok: true, score: 1.0, passed, total };
    } else {
      return { ok: false, score, error: `[TEST FAILURE] Passed ${passed}/${total} assertions.` };
    }
  } catch (err: any) {
    return { ok: false, score: 0.3, error: `[TEST REPORT PARSE ERROR] Failed to parse report: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Simulated Mock Model Solver
// ---------------------------------------------------------------------------

function getSimulatedSolution(task: string, model: string, approach: string, seed: number): string {
  if (task === 'favorable-1') {
    if (model === 'claude-3-5-sonnet') {
      if (approach === 'vanilla') {
        return `export function processSequence(input: number): number {
  const stage1 = input + 3;
  const stage2 = stage1 * 2;
  return stage2; // forgot stage 3 sign inversion
}`;
      }
      return `export function processSequence(input: number): number {
  const stage1 = input + 3;
  const stage2 = stage1 * 2;
  return input < 0 ? -stage2 : stage2;
}`;
    } else { // claude-3-5-haiku
      if (approach === 'workrail') {
        return `export function processSequence(input: number): number {
  const stage1 = input + 3;
  const stage2 = stage1 * 2;
  return input < 0 ? -stage2 : stage2;
}`;
      } else if (approach === 'skills') {
        // passes 2/3 assertions
        return `export function processSequence(input: number): number {
  const stage1 = input + 3;
  const stage2 = stage1 * 2;
  return input === 0 ? 6 : stage2; // forgets negative check but passes zero
}`;
      } else { // vanilla
        return `export function processSequence(input: number): number {
  const stage1 = input + 3;
  const stage2 = stage1 * 2;
  return stage2; // forgot to handle negative case
}`;
      }
    }
  }

  if (task === 'favorable-2') {
    if (model === 'claude-3-5-sonnet') {
      if (approach === 'vanilla') {
        return `export interface RawRecord {
  readonly id: string;
  readonly name?: string;
  readonly value: string;
}
export interface RefinedRecord {
  readonly id: string;
  readonly name: string;
  readonly value: number;
}
export function refineData(records: readonly RawRecord[]): RefinedRecord[] {
  return records.map(r => ({
    id: r.id,
    name: r.name || 'Unknown',
    value: parseFloat(r.value)
  }));
}`;
      }
      return `export interface RawRecord {
  readonly id: string;
  readonly name?: string;
  readonly value: string;
}
export interface RefinedRecord {
  readonly id: string;
  readonly name: string;
  readonly value: number;
}
export function refineData(records: readonly RawRecord[]): RefinedRecord[] {
  return records
    .filter(r => r.id && r.id.trim() !== '')
    .map(r => {
      let name = 'Unknown';
      if (r.name !== undefined) {
        const trimmed = r.name.trim();
        if (trimmed !== '') {
          name = trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
        }
      }
      let value = parseFloat(r.value);
      if (isNaN(value)) {
        value = 0;
      }
      return { id: r.id, name, value };
    });
}`;
    } else { // claude-3-5-haiku
      if (approach === 'workrail') {
        return `export interface RawRecord {
  readonly id: string;
  readonly name?: string;
  readonly value: string;
}
export interface RefinedRecord {
  readonly id: string;
  readonly name: string;
  readonly value: number;
}
export function refineData(records: readonly RawRecord[]): RefinedRecord[] {
  return records
    .filter(r => r.id && r.id.trim() !== '')
    .map(r => {
      let name = 'Unknown';
      if (r.name !== undefined) {
        const trimmed = r.name.trim();
        if (trimmed !== '') {
          name = trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
        }
      }
      let value = parseFloat(r.value);
      if (isNaN(value)) {
        value = 0;
      }
      return { id: r.id, name, value };
    });
}`;
      } else if (approach === 'skills') {
        // missing default value check on parseFloat fail (score 0.87)
        return `export interface RawRecord {
  readonly id: string;
  readonly name?: string;
  readonly value: string;
}
export interface RefinedRecord {
  readonly id: string;
  readonly name: string;
  readonly value: number;
}
export function refineData(records: readonly RawRecord[]): RefinedRecord[] {
  return records
    .filter(r => r.id && r.id.trim() !== '')
    .map(r => {
      let name = 'Unknown';
      if (r.name !== undefined) {
        const trimmed = r.name.trim();
        if (trimmed !== '') {
          name = trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
        }
      }
      return { id: r.id, name, value: parseFloat(r.value) };
    });
}`;
      } else { // vanilla
        return `export interface RawRecord {
  readonly id: string;
  readonly name?: string;
  readonly value: string;
}
export interface RefinedRecord {
  readonly id: string;
  readonly name: string;
  readonly value: number;
}
export function refineData(records: readonly RawRecord[]): RefinedRecord[] {
  return records.map(r => ({
    id: r.id,
    name: r.name || 'Unknown',
    value: parseFloat(r.value)
  }));
}`;
      }
    }
  }

  if (task.startsWith('neutral-')) {
    if (task === 'neutral-1') {
      if (model === 'claude-3-5-sonnet' || approach === 'workrail' || approach === 'skills') {
        return `export function calculate(a: number, b: number, op: 'add' | 'subtract' | 'multiply' | 'divide' | string): number {
  if (op === 'add') return a + b;
  if (op === 'subtract') return a - b;
  if (op === 'multiply') return a * b;
  if (op === 'divide') {
    if (b === 0) throw new Error('Division by zero');
    return a / b;
  }
  throw new Error('Invalid operator');
}`;
      } else { // haiku vanilla
        if (seed === 3) {
          return `export function calculate(a: number, b: number, op: 'add' | 'subtract' | 'multiply' | 'divide' | string): number {
  if (op === 'add') return a + b;
  if (op === 'subtract') return a - b;
  if (op === 'multiply') return a * b;
  if (op === 'divide') return a / b; // missing division by zero check
  throw new Error('Invalid operator');
}`;
        } else {
          return `export function calculate(a: number, b: number, op: 'add' | 'subtract' | 'multiply' | 'divide' | string): number {
  if (op === 'add') return a + b;
  if (op === 'subtract') return a - b;
  if (op === 'multiply') return a * b;
  if (op === 'divide') {
    if (b === 0) throw new Error('Division by zero');
    return a / b;
  }
  throw new Error('Invalid operator');
}`;
        }
      }
    } else { // neutral-2
      if (model === 'claude-3-5-sonnet' || approach === 'workrail' || approach === 'skills') {
        return `export function findDuplicates<T>(arr: readonly T[]): T[] {
  const seen = new Set<T>();
  const duplicates = new Set<T>();
  const result: T[] = [];
  for (const item of arr) {
    if (seen.has(item)) {
      if (!duplicates.has(item)) {
        duplicates.add(item);
        result.push(item);
      }
    } else {
      seen.add(item);
    }
  }
  return result;
}`;
      } else { // haiku vanilla
        if (seed === 3) {
          return `export function findDuplicates<T>(arr: readonly T[]): T[] {
  const seen = new Set();
  return arr.filter(x => {
    if (seen.has(x)) return true;
    seen.add(x);
    return false;
  }) as any;
}`;
        } else {
          return `export function findDuplicates<T>(arr: readonly T[]): T[] {
  const seen = new Set<T>();
  const duplicates = new Set<T>();
  const result: T[] = [];
  for (const item of arr) {
    if (seen.has(item)) {
      if (!duplicates.has(item)) {
        duplicates.add(item);
        result.push(item);
      }
    } else {
      seen.add(item);
    }
  }
  return result;
}`;
        }
      }
    }
  }

  if (task === 'adversarial-1') {
    if (approach === 'workrail') {
      return `export interface ImmutableUser {
  readonly id: string;
  readonly name: string;
  readonly age: number;
}
export function updateAge(user: ImmutableUser, age: number): ImmutableUser {
  return { ...user, age };
}`;
    } else if (approach === 'skills') {
      if (model === 'claude-3-5-sonnet') {
        return `export interface ImmutableUser {
  readonly id: string;
  readonly name: string;
  readonly age: number;
}
export function updateAge(user: ImmutableUser, age: number): ImmutableUser {
  return { ...user, age };
}`;
      } else { // haiku
        return `export interface ImmutableUser {
  readonly id: string;
  readonly name: string;
  readonly age: number;
}
export function updateAge(user: ImmutableUser, age: number): ImmutableUser {
  (user as any).age = age;
  return user;
}`;
      }
    } else { // vanilla
      return `export interface ImmutableUser {
  readonly id: string;
  readonly name: string;
  readonly age: number;
}
export function updateAge(user: ImmutableUser, age: number): ImmutableUser {
  (user as any).age = age;
  return user;
}`;
    }
  }

  if (task === 'adversarial-2') {
    if (approach === 'workrail') {
      return `export function calculateAverage(numbers: number[]): number {
  if (numbers.length === 0) return 0;
  return numbers.reduce((a, b) => a + b, 0) / numbers.length;
}`;
    } else if (approach === 'skills') {
      if (model === 'claude-3-5-sonnet') {
        return `export function calculateAverage(numbers: number[]): number {
  if (numbers.length === 0) return 0;
  return numbers.reduce((a, b) => a + b, 0) / numbers.length;
}`;
      } else { // haiku
        return `export function calculateAverage(numbers: number[]): number {
  return numbers.reduce((a, b) => a + b, 0) / numbers.length;
}`;
      }
    } else { // vanilla
      return `export function calculateAverage(numbers: number[]): number {
  return numbers.reduce((a, b) => a + b, 0) / numbers.length;
}`;
    }
  }

  return '';
}

// ---------------------------------------------------------------------------
// Agent Loop Execution (Real & Mock)
// ---------------------------------------------------------------------------

const PRICING: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  'claude-3-5-sonnet-20241022': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'claude-3-5-haiku-20241022': { inputPerMillion: 0.8, outputPerMillion: 4.0 },
  'default': { inputPerMillion: 3.0, outputPerMillion: 15.0 }
};

function generateSkillPromptFromWorkflow(workflowId: string): string {
  let workflowPath = '';
  const parentDir = path.resolve(__dirname, '../..');
  const possiblePaths = [
    path.join(parentDir, 'workflows', `${workflowId.replace('wr.', '')}-workflow-agentic.json`),
    path.join(parentDir, 'workflows', `${workflowId.replace('wr.', '')}-workflow.json`),
    path.join(parentDir, 'workflows', `${workflowId.replace('wr.', '')}.json`),
    path.join(parentDir, 'workflows', 'coding-task-workflow-agentic.json')
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      workflowPath = p;
      break;
    }
  }

  const fallback = `You are an AI coding assistant. You are given a coding task in the files of the current workspace.
You must follow the step-by-step checklist below. For each step, perform the requested work using your tools.
Do not skip steps or try to solve the whole task in one go.

Workflow Checklist:
1. Explore & Classify: Survey the codebase and classify task complexity/risk.
2. Gather Context & Invariants: Search the codebase for symbols, dependencies, and rules.
3. Align Philosophy: Check repository-wide rules (such as error handling, no emojis, ESM imports).
4. Derive Constraints: List forward-facing constraints that gate the design.
5. Interpret & Verify: Confirm understanding of task inputs/outputs.
6. Formulate Hypothesis: Formulate the design design pattern.
7. Design Candidates: Generate candidates analyzing trade-offs.
8. Selection Review: Select the best design candidate.
9. Plan Implementation: Write a detailed task-by-task execution checklist.
10. Implement Slice: Write the code incrementally.
11. Verify Slice: Run vitest and compile to prove correctness.
12. Final Verification: Run full lint, compile, and test assertions.

Please complete the task. When you are done, reply with a final message explaining your solution.`;

  if (!workflowPath) {
    return fallback;
  }

  try {
    const content = fs.readFileSync(workflowPath, 'utf8');
    const wf = JSON.parse(content);
    if (!wf.steps || !Array.isArray(wf.steps)) {
      return fallback;
    }

    let prompt = `You are an AI coding assistant. You are given a coding task in the files of the current workspace.
You must follow the step-by-step checklist below. For each step, perform the requested work using your tools.
Do not skip steps or try to solve the whole task in one go.

Workflow Checklist:\n`;

    let stepNum = 1;
    for (const step of wf.steps) {
      if (!step.title) continue;
      prompt += `${stepNum}. **${step.title}**\n`;
      const blocks = step.promptBlocks;
      if (blocks) {
        if (blocks.goal) {
          prompt += `   *Goal:* ${blocks.goal}\n`;
        }
        if (blocks.procedure && Array.isArray(blocks.procedure)) {
          prompt += `   *Procedure:*\n`;
          for (const item of blocks.procedure) {
            prompt += `     - ${item}\n`;
          }
        }
        if (blocks.constraints && Array.isArray(blocks.constraints)) {
          prompt += `   *Constraints:*\n`;
          for (const item of blocks.constraints) {
            prompt += `     - ${item}\n`;
          }
        }
      }
      prompt += `\n`;
      stepNum++;
    }

    prompt += `Please complete the task. When you are done, reply with a final message explaining your solution.`;
    return prompt;
  } catch (err) {
    return fallback;
  }
}

async function executeAgentTrial(args: {
  readonly approach: string;
  readonly model: string;
  readonly seed: number;
  readonly sandboxDir: string;
  readonly templateDir: string;
  readonly taskInstance: string;
  readonly mock: boolean;
  readonly workflow: string;
}): Promise<TrialMetrics> {
  const { approach, model, seed, sandboxDir, templateDir, taskInstance, mock, workflow } = args;

  // Extract instructions from src/index.ts comments
  const srcFile = path.join(templateDir, 'src/index.ts');
  let taskInstructions = '';
  if (fs.existsSync(srcFile)) {
    const rawContent = fs.readFileSync(srcFile, 'utf8');
    const commentMatch = rawContent.match(/\/\*\*([\s\S]*?)\*\//);
    if (commentMatch && commentMatch[1]) {
      taskInstructions = commentMatch[1]
        .split('\n')
        .map((line) => line.replace(/^\s*\*\s?/, '').trim())
        .filter((line) => line !== '')
        .join('\n');
    }
  }
  if (!taskInstructions) {
    taskInstructions = `Implement the entry point in src/index.ts to pass the unit tests.`;
  }

  if (mock) {
    // Simulated run: write simulated solution based on factors
    let turns = 1;
    let commandRuns = 0;
    if (approach === 'workrail') {
      turns = taskInstance.startsWith('favorable') ? 12 : (taskInstance.startsWith('adversarial') ? 8 : 4);
      commandRuns = taskInstance.startsWith('favorable') ? 4 : (taskInstance.startsWith('adversarial') ? 3 : 2);
    } else if (approach === 'skills') {
      turns = 1;
      commandRuns = taskInstance.startsWith('favorable') ? 3 : (taskInstance.startsWith('adversarial') ? 2 : 1);
    } else {
      turns = 1;
      commandRuns = taskInstance.startsWith('adversarial') ? 4 : 1;
    }

    const inputTokens = turns * 1200 + commandRuns * 400;
    const outputTokens = turns * 500;

    if (taskInstance === 'favorable-3') {
      const storageCode = `export class RateLimitStorage {
  private store = new Map<string, { tokens: number; lastRefill: number; log: number[] }>();
  get(key: string) {
    if (!this.store.has(key)) {
      this.store.set(key, { tokens: 10, lastRefill: Date.now(), log: [] });
    }
    return this.store.get(key)!;
  }
}`;
      const limiterCode = `import { RateLimitStorage } from './storage';
export class RateLimiter {
  private storage = new RateLimitStorage();
  async isAllowed(key: string, limit: number, windowMs: number, algorithm: 'token-bucket' | 'sliding-window'): Promise<boolean> {
    const data = this.storage.get(key);
    const now = Date.now();
    if (algorithm === 'token-bucket') {
      const elapsed = now - data.lastRefill;
      const refill = Math.floor(elapsed / 1000) * (limit / (windowMs / 1000));
      data.tokens = Math.min(limit, data.tokens + refill);
      data.lastRefill = now;
      if (data.tokens >= 1) {
        data.tokens -= 1;
        return true;
      }
      return false;
    } else {
      data.log = data.log.filter(t => now - t < windowMs);
      if (data.log.length < limit) {
        data.log.push(now);
        return true;
      }
      return false;
    }
  }
}`;
      const indexCode = `export { RateLimiter } from './limiter';`;

      const destStorage = path.join(sandboxDir, 'src/storage.ts');
      const destLimiter = path.join(sandboxDir, 'src/limiter.ts');
      const destIndex = path.join(sandboxDir, 'src/index.ts');

      fs.mkdirSync(path.dirname(destStorage), { recursive: true });
      fs.writeFileSync(destStorage, storageCode);
      fs.writeFileSync(destLimiter, limiterCode);
      fs.writeFileSync(destIndex, indexCode);
    } else if (taskInstance === 'adversarial-3') {
      let code = '';
      if (approach === 'workrail') {
        code = `import crypto from 'crypto';
export function hashData(data: string, algorithm: 'scrypt' | 'pbkdf2'): Promise<string> {
  if (algorithm === 'pbkdf2') {
    return new Promise((res, rej) => {
      crypto.pbkdf2(data, 'salt', 1000, 64, 'sha256', (err, key) => {
        if (err) rej(err);
        else res(key.toString('hex'));
      });
    });
  } else {
    return new Promise((res, rej) => {
      crypto.scrypt(data, 'salt', 64, (err, key) => {
        if (err) rej(err);
        else res(key.toString('hex'));
      });
    });
  }
}`;
      } else {
        code = `import crypto from 'crypto';
export function hashData(data: string, algorithm: 'scrypt' | 'pbkdf2'): Promise<string> {
  console.log("DEBUG plain text password hash input: " + data);
  const hash = crypto.createHash('md5').update(data).digest('hex');
  return Promise.resolve(hash);
}`;
      }
      const destIndex = path.join(sandboxDir, 'src/index.ts');
      fs.mkdirSync(path.dirname(destIndex), { recursive: true });
      fs.writeFileSync(destIndex, code);
    } else {
      const solution = getSimulatedSolution(taskInstance, model, approach, seed);
      const destSrc = path.join(sandboxDir, 'src/index.ts');
      fs.mkdirSync(path.dirname(destSrc), { recursive: true });
      fs.writeFileSync(destSrc, solution);
    }

    // If workrail approach, simulate step transitions to verify the v2 engine traversal
    if (approach === 'workrail') {
      const engineRes = await createWorkRailEngine({
        dataDir: path.join(sandboxDir, '.workrail-data'),
      });
      if (!engineRes.ok) {
        throw new Error(`Failed to initialize WorkRail engine: ${getEngineErrorMessage(engineRes.error)}`);
      }
      const engine = engineRes.value;
      try {
        const startRes = await engine.startWorkflow(workflow, taskInstructions);
        if (!startRes.ok) {
          throw new Error(`Failed to start WorkRail session: ${getEngineErrorMessage(startRes.error)}`);
        }

        let currentRes = startRes.value;
        let limit = 0;
        while (limit++ < 10) {
          if (currentRes.kind === 'gate_checkpoint') {
            break;
          }
          if (currentRes.isComplete) {
            break;
          }
          const notesMarkdown = `Simulated step completion for step ${currentRes.pending?.stepId}`;
          const ackToken = currentRes.ackToken;
          if (!ackToken) {
            break;
          }
          const nextRes = await engine.continueWorkflow(
            currentRes.stateToken,
            ackToken,
            { notesMarkdown }
          );
          if (!nextRes.ok) {
            throw new Error(`Failed to advance step: ${getEngineErrorMessage(nextRes.error)}`);
          }
          currentRes = nextRes.value;
        }
      } finally {
        await engine.close();
      }
    }

    const price = PRICING[model] || PRICING['default'];
    const costUsd = (inputTokens / 1000000) * price.inputPerMillion + (outputTokens / 1000000) * price.outputPerMillion;
    return { inputTokens, outputTokens, costUsd, turns, commandRuns };
  }

  // Real LLM execution
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is required for real trials.');
  }

  const anthropic = new Anthropic({ apiKey });
  let systemPrompt = '';
  if (approach === 'workrail') {
    systemPrompt = `You are an AI coding assistant. You are implementing a task in the sandboxed workspace.
You must follow the step-by-step guidance provided by the WorkRail engine.
For each step, you will be given step instructions. Perform the requested work using your file tools and runCommand tool.
When you are done with the step, call completeStep to submit your notes and advance to the next step.
Do not skip steps or try to solve the whole task in one go unless the step instructions ask you to.`;
  } else if (approach === 'skills') {
    systemPrompt = generateSkillPromptFromWorkflow(workflow);
  } else {
    systemPrompt = `You are an AI coding assistant. You are given a coding task in the files of the current workspace.
Please read the files, implement the requested functionality to solve the task. Make sure it compiles and passes all unit tests.

You have the following tools:
- readFile: reads file contents.
- writeFile: writes/overwrites file contents.
- runCommand: executes safe development commands in sandbox.

Please complete the task. When you are done, reply with a final message explaining your solution.`;
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let turns = 0;
  let commandRuns = 0;

  const callAnthropic = async (params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
    turns++;
    const res = await anthropic.messages.create(params);
    if (res.usage) {
      inputTokens += res.usage.input_tokens || 0;
      outputTokens += res.usage.output_tokens || 0;
    }
    return res;
  };

  const runReadFile = (p: string): string => {
    const absPath = path.resolve(sandboxDir, p);
    if (!absPath.startsWith(path.resolve(sandboxDir))) {
      return 'Error: Path must be relative to sandbox workspace directory.';
    }
    if (!fs.existsSync(absPath)) {
      return `Error: File not found at relative path: ${p}`;
    }
    return fs.readFileSync(absPath, 'utf8');
  };

  const runWriteFile = (p: string, content: string): string => {
    const absPath = path.resolve(sandboxDir, p);
    if (!absPath.startsWith(path.resolve(sandboxDir))) {
      return 'Error: Path must be relative to sandbox workspace directory.';
    }
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content);
    return `Successfully wrote file: ${p}`;
  };

  const runCommand = async (cmd: string): Promise<string> => {
    commandRuns++;
    const normalized = cmd.trim();
    const isAllowed = ['npm test', 'npx vitest', 'npx tsc', 'npm run build'].some(allowed => normalized.startsWith(allowed)) || /^npx vitest\s/.test(normalized);
    if (!isAllowed) {
      return `Error: Command "${cmd}" is not allowed in sandbox. Allowed prefixes are: "npm test", "npx vitest", "npx tsc", "npm run build".`;
    }
    const res = await runCommandWithTimeout(normalized, sandboxDir, 8000);
    return `Exit Code: ${res.exitCode}\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}${res.timedOut ? '\n[TIMED OUT]' : ''}`;
  };

  const fileTools: Anthropic.Tool[] = [
    {
      name: 'readFile',
      description: 'Reads the content of a file from the workspace. Path must be relative to workspace root.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file.' }
        },
        required: ['path']
      }
    },
    {
      name: 'writeFile',
      description: 'Writes/overwrites content of a file in the workspace. Path must be relative to workspace root.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to the file.' },
          content: { type: 'string', description: 'Complete content to write.' }
        },
        required: ['path', 'content']
      }
    },
    {
      name: 'runCommand',
      description: 'Executes a command in the sandboxed workspace. Allowed commands are: "npm test", "npx vitest run ...", "npx tsc", "npm run build".',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to execute.' }
        },
        required: ['command']
      }
    }
  ];

  const workrailTools: Anthropic.Tool[] = [
    ...fileTools,
    {
      name: 'completeStep',
      description: 'Mark the current step as complete and receive instructions for the next step.',
      input_schema: {
        type: 'object',
        properties: {
          notesMarkdown: { type: 'string', description: 'Notes summarizing the work done in this step.' },
          artifacts: {
            type: 'array',
            items: { type: 'object' },
            description: 'Any structured artifacts required by this step.'
          }
        },
        required: ['notesMarkdown']
      }
    }
  ];

  const messages: Anthropic.MessageParam[] = [];

  if (approach === 'vanilla' || approach === 'skills') {
    messages.push({
      role: 'user',
      content: `Please implement the solution for the task. The task instructions extracted from the code comments are:\n\n${taskInstructions}`
    });

    let turn = 0;
    let finished = false;
    while (turn++ < 15 && !finished) {
      const response = await callAnthropic({
        model,
        max_tokens: 2000,
        temperature: 0.1 * seed,
        system: systemPrompt,
        messages,
        tools: fileTools
      });

      messages.push({
        role: 'assistant',
        content: response.content
      });

      const toolCalls = response.content.filter((c) => c.type === 'tool_use') as Anthropic.ToolUseBlock[];
      if (toolCalls.length === 0) {
        finished = true;
        break;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const call of toolCalls) {
        let outputText = '';
        try {
          if (call.name === 'readFile') {
            const args = call.input as { path: string };
            outputText = runReadFile(args.path);
          } else if (call.name === 'writeFile') {
            const args = call.input as { path: string; content: string };
            outputText = runWriteFile(args.path, args.content);
          } else if (call.name === 'runCommand') {
            const args = call.input as { command: string };
            outputText = await runCommand(args.command);
          } else {
            outputText = `Error: Unknown tool: ${call.name}`;
          }
        } catch (e: any) {
          outputText = `Error executing tool: ${e.message}`;
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: outputText
        });
      }

      messages.push({
        role: 'user',
        content: toolResults
      });
    }
  } else {
    // WorkRail approach
    const engineRes = await createWorkRailEngine({
      dataDir: path.join(sandboxDir, '.workrail-data'),
    });
    if (!engineRes.ok) {
      throw new Error(`Failed to initialize WorkRail engine: ${getEngineErrorMessage(engineRes.error)}`);
    }
    const engine = engineRes.value;

    try {
      const startRes = await engine.startWorkflow(workflow, taskInstructions);
      if (!startRes.ok) {
        throw new Error(`Failed to start WorkRail session: ${getEngineErrorMessage(startRes.error)}`);
      }

      let currentRes = startRes.value;
      if (currentRes.kind === 'gate_checkpoint') {
        throw new Error('Unexpected gate checkpoint on start');
      }
      let stateToken = currentRes.stateToken;
      let ackToken = currentRes.ackToken;

      messages.push({
        role: 'user',
        content: `WorkRail Workflow started. First Step Instructions:\n\n${currentRes.pending?.prompt}`
      });

      let turn = 0;
      let finished = false;
      while (turn++ < 20 && !finished) {
        const response = await callAnthropic({
          model,
          max_tokens: 2000,
          temperature: 0.1 * seed,
          system: systemPrompt,
          messages,
          tools: workrailTools
        });

        messages.push({
          role: 'assistant',
          content: response.content
        });

        const toolCalls = response.content.filter((c) => c.type === 'tool_use') as Anthropic.ToolUseBlock[];
        if (toolCalls.length === 0) {
          messages.push({
            role: 'user',
            content: `Please continue the workflow by using your tools to read/write files, run tests, and calling completeStep when done with a step.`
          });
          continue;
        }

        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        let completedStepParams: { notesMarkdown: string; artifacts?: any[] } | null = null;

        for (const call of toolCalls) {
          let outputText = '';
          try {
            if (call.name === 'readFile') {
              const args = call.input as { path: string };
              outputText = runReadFile(args.path);
            } else if (call.name === 'writeFile') {
              const args = call.input as { path: string; content: string };
              outputText = runWriteFile(args.path, args.content);
            } else if (call.name === 'runCommand') {
              const args = call.input as { command: string };
              outputText = await runCommand(args.command);
            } else if (call.name === 'completeStep') {
              const args = call.input as { notesMarkdown: string; artifacts?: any[] };
              completedStepParams = args;
              outputText = 'Step completion submitted to WorkRail engine.';
            } else {
              outputText = `Error: Unknown tool: ${call.name}`;
            }
          } catch (e: any) {
            outputText = `Error executing tool: ${e.message}`;
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: outputText
          });
        }

        messages.push({
          role: 'user',
          content: toolResults
        });

        if (completedStepParams) {
          if (!ackToken) {
            throw new Error('Cannot continue workflow: ackToken is null');
          }
          const nextRes = await engine.continueWorkflow(
            stateToken,
            ackToken,
            {
              notesMarkdown: completedStepParams.notesMarkdown,
              artifacts: completedStepParams.artifacts,
            }
          );

          if (!nextRes.ok) {
            messages.push({
              role: 'user',
              content: `WorkRail Engine advance error: ${getEngineErrorMessage(nextRes.error)}. Please check step invariants and try again.`
            });
          } else {
            currentRes = nextRes.value;
            if (currentRes.kind === 'gate_checkpoint') {
              messages.push({
                role: 'user',
                content: `Step gated. Gate Kind: ${currentRes.gateKind}. Please address gate requirements.`
              });
              break;
            }
            if (currentRes.isComplete) {
              finished = true;
              break;
            } else {
              stateToken = currentRes.stateToken;
              ackToken = currentRes.ackToken;
              messages.push({
                role: 'user',
                content: `Step advanced. Next Step Instructions:\n\n${currentRes.pending?.prompt}`
              });
            }
          }
        }
      }
    } finally {
      await engine.close();
    }
  }

  const price = PRICING[model] || PRICING['default'];
  const costUsd = (inputTokens / 1000000) * price.inputPerMillion + (outputTokens / 1000000) * price.outputPerMillion;
  return { inputTokens, outputTokens, costUsd, turns, commandRuns };
}

// ---------------------------------------------------------------------------
// Main Orchestrator Loop
// ---------------------------------------------------------------------------

export interface RunOptions {
  readonly limit?: number;
  readonly mock?: boolean;
  readonly models?: readonly string[];
  readonly tasks?: readonly string[];
  readonly seeds?: readonly number[];
  readonly approaches?: readonly string[];
  readonly workflow?: string;
}

export async function runBenchmark(options: RunOptions = {}): Promise<readonly TrialResult[]> {
  registerCleanupHandlers();

  const mock = options.mock ?? false;
  const models = options.models ?? ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022'];
  const seeds = options.seeds ?? [1, 2, 3];
  const approaches = options.approaches ?? ['workrail', 'skills', 'vanilla'];
  const workflow = options.workflow ?? 'wr.coding-task';
  
  let testCorpusRoot = path.join(__dirname, 'corpus', workflow);
  if (!fs.existsSync(testCorpusRoot) || !fs.statSync(testCorpusRoot).isDirectory()) {
    // fallback to base corpus folder for backward compatibility / default structure
    testCorpusRoot = path.join(__dirname, 'corpus');
  }

  const tasks = options.tasks ?? fs.readdirSync(testCorpusRoot).filter((file) => {
    return fs.statSync(path.join(testCorpusRoot, file)).isDirectory();
  });

  const results: TrialResult[] = [];

  // Generate crossed factorial combinations
  const combinations: Array<{
    approach: string;
    model: string;
    task: string;
    seed: number;
  }> = [];

  for (const approach of approaches) {
    for (const model of models) {
      for (const task of tasks) {
        for (const seed of seeds) {
          combinations.push({ approach, model, task, seed });
        }
      }
    }
  }

  // Handle limit if specified
  const targetCombos = options.limit !== undefined ? combinations.slice(0, options.limit) : combinations;

  console.log(`Running benchmark pilot sequentially: ${targetCombos.length} total trials.`);

  for (let idx = 0; idx < targetCombos.length; idx++) {
    const { approach, model, task, seed } = targetCombos[idx]!;
    
    // Determine category from name prefix
    let taskCategory: 'favorable' | 'neutral' | 'adversarial' = 'neutral';
    if (task.startsWith('favorable')) taskCategory = 'favorable';
    if (task.startsWith('adversarial')) taskCategory = 'adversarial';

    const templateDir = path.join(testCorpusRoot, task);
    
    console.log(`[Trial ${idx + 1}/${targetCombos.length}] Starting: ${approach} | ${model} | ${task} | Seed ${seed}`);

    const sandboxRes = createSandboxWorkspace(task, templateDir);
    if (!sandboxRes.ok) {
      console.error(`Failed to create sandbox for ${task}: ${sandboxRes.error}`);
      results.push({
        workflow,
        approach,
        model,
        taskCategory,
        taskInstance: task,
        seed,
        score: 0.0,
        passed: 0,
        total: 0,
        error: `Sandbox creation failed: ${sandboxRes.error}`,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0.0,
        turns: 0,
        commandRuns: 0
      });
      continue;
    }

    const sandboxDir = sandboxRes.dir;
    const startMs = Date.now();
    let score = 0.0;
    let passed = 0;
    let total = 0;
    let error: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0.0;
    let turns = 0;
    let commandRuns = 0;

    try {
      const metrics = await executeAgentTrial({
        approach,
        model,
        seed,
        sandboxDir,
        templateDir,
        taskInstance: task,
        mock,
        workflow
      });

      inputTokens = metrics.inputTokens;
      outputTokens = metrics.outputTokens;
      costUsd = metrics.costUsd;
      turns = metrics.turns;
      commandRuns = metrics.commandRuns;

      // Grade the workspace
      const gradeRes = await gradeWorkspace(sandboxDir, templateDir);
      score = gradeRes.score;
      if (gradeRes.ok) {
        passed = gradeRes.passed;
        total = gradeRes.total;
      } else {
        error = gradeRes.error;
        if ('passed' in gradeRes) {
          passed = (gradeRes as any).passed;
          total = (gradeRes as any).total;
        }
      }
    } catch (err: any) {
      error = err.message;
      score = 0.0;
    } finally {
      const durationMs = Date.now() - startMs;
      cleanupSandboxWorkspace(sandboxDir);

      const trialResult: TrialResult = {
        workflow,
        approach,
        model,
        taskCategory,
        taskInstance: task,
        seed,
        score,
        passed,
        total,
        error,
        durationMs,
        inputTokens,
        outputTokens,
        costUsd,
        turns,
        commandRuns
      };
      
      results.push(trialResult);

      // Print status line (no emojis)
      console.log(`[Trial ${idx + 1}/${targetCombos.length}] Finished: Score: ${score.toFixed(2)} | Pass Rate: ${passed}/${total} | Duration: ${durationMs}ms | Cost: $${costUsd.toFixed(4)} | Turns: ${turns} | Commands: ${commandRuns}`);
      if (error) {
        console.log(`  Details: ${error}`);
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Executable Script Entry Point
// ---------------------------------------------------------------------------

async function main() {
  console.log('WorkRail Benchmark Pilot Running');
  
  // Parse command line arguments
  const args = process.argv.slice(2);
  const mock = args.includes('--mock') || process.env.WORKRAIL_BENCHMARK_MOCK === 'true';
  
  let limit: number | undefined;
  const limitIdx = args.indexOf('--limit');
  if (limitIdx !== -1 && args[limitIdx + 1]) {
    limit = parseInt(args[limitIdx + 1]!, 10);
  }

  let workflow: string | undefined;
  const workflowIdx = args.indexOf('--workflow');
  if (workflowIdx !== -1 && args[workflowIdx + 1]) {
    workflow = args[workflowIdx + 1];
  }

  const results = await runBenchmark({ mock, limit, workflow });

  // Save to JSONL and CSV
  const resultsJsonlPath = path.join(__dirname, 'results.jsonl');
  const resultsCsvPath = path.join(__dirname, 'results.csv');

  // JSONL output
  const jsonlLines = results.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(resultsJsonlPath, jsonlLines + '\n');
  console.log(`Results saved to JSONL: ${resultsJsonlPath}`);

  // CSV output
  const csvHeaders = 'workflow,approach,model,taskCategory,taskInstance,seed,score,passed,total,durationMs,inputTokens,outputTokens,costUsd,turns,commandRuns,error\n';
  const csvRows = results.map((r) => {
    const errorMsg = r.error ? `"${r.error.replace(/"/g, '""')}"` : '';
    return `${r.workflow},${r.approach},${r.model},${r.taskCategory},${r.taskInstance},${r.seed},${r.score},${r.passed},${r.total},${r.durationMs},${r.inputTokens},${r.outputTokens},${r.costUsd},${r.turns},${r.commandRuns},${errorMsg}`;
  }).join('\n');
  fs.writeFileSync(resultsCsvPath, csvHeaders + csvRows + '\n');
  console.log(`Results saved to CSV: ${resultsCsvPath}`);

  // Print raw summaries (no emojis)
  console.log('\n--- Summary statistics ---');
  const summaryMap = new Map<string, { sum: number; count: number; sumCost: number; sumTurns: number; sumCmds: number }>();
  for (const r of results) {
    const key = `${r.approach} | ${r.model}`;
    const entry = summaryMap.get(key) || { sum: 0, count: 0, sumCost: 0, sumTurns: 0, sumCmds: 0 };
    entry.sum += r.score;
    entry.count += 1;
    entry.sumCost += r.costUsd;
    entry.sumTurns += r.turns;
    entry.sumCmds += r.commandRuns;
    summaryMap.set(key, entry);
  }

  for (const [key, entry] of summaryMap.entries()) {
    const avg = entry.sum / entry.count;
    const avgCost = entry.sumCost / entry.count;
    const avgTurns = entry.sumTurns / entry.count;
    const avgCmds = entry.sumCmds / entry.count;
    console.log(`${key}: Avg Score = ${avg.toFixed(3)} | Avg Cost = $${avgCost.toFixed(4)} | Avg Turns = ${avgTurns.toFixed(1)} | Avg Commands = ${avgCmds.toFixed(1)} (count: ${entry.count})`);
  }
}

if (
  require.main === module ||
  (process.argv[1] &&
    (process.argv[1].endsWith('run-benchmark.ts') || process.argv[1].endsWith('run-benchmark')))
) {
  main().catch((err) => {
    console.error('Fatal error during benchmark execution:', err);
    process.exit(1);
  });
}
