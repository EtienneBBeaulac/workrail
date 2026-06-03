import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { exec } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';
import { createWorkRailEngine } from '../../src/engine/index.js';
import type { StateToken, AckToken } from '../../src/engine/types.js';

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

export interface TrialResult {
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
        process.kill(-proc.pid, 'SIGKILL');
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
 * Verifies syntax of a source file using the TypeScript Compiler API.
 * Award score 0.1 if syntax passes but compilation/tests fail.
 */
function verifySyntax(filePath: string): { ok: true } | { ok: false; error: string } {
  try {
    if (!fs.existsSync(filePath)) {
      return { ok: false, error: `Source file not found at ${filePath}` };
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    const diagnostics = (sourceFile as any).parseDiagnostics;
    if (diagnostics && diagnostics.length > 0) {
      const messages = diagnostics.map((d: any) => {
        if (typeof d.messageText === 'string') return d.messageText;
        return JSON.stringify(d.messageText);
      }).join('; ');
      return { ok: false, error: messages };
    }
    return { ok: true };
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
  const srcFile = path.join(sandboxDir, 'src/index.ts');
  const templateTestFile = path.join(templateDir, 'tests/index.test.ts');
  const templateConfig = path.join(templateDir, 'tsconfig.json');

  // Step 1: Syntax Validation (Score 0.0 on failure)
  const syntaxCheck = verifySyntax(srcFile);
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

async function executeAgentTrial(args: {
  readonly approach: string;
  readonly model: string;
  readonly seed: number;
  readonly sandboxDir: string;
  readonly templateDir: string;
  readonly taskInstance: string;
  readonly mock: boolean;
}): Promise<void> {
  const { approach, model, seed, sandboxDir, templateDir, taskInstance, mock } = args;

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
    const solution = getSimulatedSolution(taskInstance, model, approach, seed);
    const destSrc = path.join(sandboxDir, 'src/index.ts');
    fs.mkdirSync(path.dirname(destSrc), { recursive: true });
    fs.writeFileSync(destSrc, solution);

    // If workrail approach, simulate step transitions to verify the v2 engine traversal
    if (approach === 'workrail') {
      const engineRes = await createWorkRailEngine({
        dataDir: path.join(sandboxDir, '.workrail-data'),
      });
      if (!engineRes.ok) {
        throw new Error(`Failed to initialize WorkRail engine: ${engineRes.error.message}`);
      }
      const engine = engineRes.value;
      try {
        const startRes = await engine.startWorkflow('wr.coding-task', taskInstructions);
        if (!startRes.ok) {
          throw new Error(`Failed to start WorkRail session: ${startRes.error.message}`);
        }

        let currentRes = startRes.value;
        let limit = 0;
        while (!currentRes.isComplete && currentRes.kind === 'ok' && limit++ < 10) {
          const notesMarkdown = `Simulated step completion for step ${currentRes.pending?.stepId}`;
          const nextRes = await engine.continueWorkflow(
            currentRes.stateToken,
            currentRes.ackToken,
            { notesMarkdown }
          );
          if (!nextRes.ok) {
            throw new Error(`Failed to advance step: ${nextRes.error.message}`);
          }
          currentRes = nextRes.value;
        }
      } finally {
        await engine.close();
      }
    }
    return;
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
For each step, you will be given step instructions. Perform the requested work using your file tools (readFile, writeFile).
When you are done with the step, call completeStep to submit your notes and advance to the next step.
Do not skip steps or try to solve the whole task in one go unless the step instructions ask you to.`;
  } else if (approach === 'skills') {
    systemPrompt = `You are an AI coding assistant. You are given a coding task in the files of the current workspace.
You must follow the step-by-step checklist below. For each step, perform the requested work using your file tools (readFile, writeFile).
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
  } else {
    systemPrompt = `You are an AI coding assistant. You are given a coding task in the files of the current workspace.
Please read the files, implement the requested functionality in src/index.ts to solve the task. Make sure it compiles and passes all unit tests.

You have the following tools:
- readFile: reads file contents.
- writeFile: writes/overwrites file contents.

Please complete the task. When you are done, reply with a final message explaining your solution.`;
  }

  const messages: Anthropic.MessageParam[] = [];

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

  if (approach === 'vanilla' || approach === 'skills') {
    messages.push({
      role: 'user',
      content: `Please implement the solution for the task. The task instructions extracted from the code comments are:\n\n${taskInstructions}`
    });

    let turn = 0;
    let finished = false;
    while (turn++ < 15 && !finished) {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 2000,
        temperature: 0.1 * seed,
        system: systemPrompt,
        messages,
        tools: fileTools
      });

      // Save assistant message to history
      messages.push({
        role: 'assistant',
        content: response.content
      });

      const toolCalls = response.content.filter((c) => c.type === 'tool_use') as Anthropic.ToolUseBlock[];
      if (toolCalls.length === 0) {
        // Model finished without tool calls
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
      throw new Error(`Failed to initialize WorkRail engine: ${engineRes.error.message}`);
    }
    const engine = engineRes.value;

    try {
      const startRes = await engine.startWorkflow('wr.coding-task', taskInstructions);
      if (!startRes.ok) {
        throw new Error(`Failed to start WorkRail session: ${startRes.error.message}`);
      }

      let currentRes = startRes.value;
      let stateToken = currentRes.stateToken;
      let ackToken = currentRes.ackToken;

      messages.push({
        role: 'user',
        content: `WorkRail Workflow started. First Step Instructions:\n\n${currentRes.pending?.prompt}`
      });

      let turn = 0;
      let finished = false;
      while (turn++ < 20 && !finished) {
        const response = await anthropic.messages.create({
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
          // Model didn't call tools, remind it to complete the step
          messages.push({
            role: 'user',
            content: `Please continue the workflow by using your tools to read/write files and calling completeStep when done with a step.`
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
          // Advance the workflow
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
              content: `WorkRail Engine advance error: ${nextRes.error.message}. Please check step invariants and try again.`
            });
          } else {
            currentRes = nextRes.value;
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
}

export async function runBenchmark(options: RunOptions = {}): Promise<readonly TrialResult[]> {
  registerCleanupHandlers();

  const mock = options.mock ?? false;
  const models = options.models ?? ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022'];
  const seeds = options.seeds ?? [1, 2, 3];
  const approaches = options.approaches ?? ['workrail', 'skills', 'vanilla'];
  
  const testCorpusRoot = path.join(__dirname, 'corpus');
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
        approach,
        model,
        taskCategory,
        taskInstance: task,
        seed,
        score: 0.0,
        passed: 0,
        total: 0,
        error: `Sandbox creation failed: ${sandboxRes.error}`,
        durationMs: 0
      });
      continue;
    }

    const sandboxDir = sandboxRes.dir;
    const startMs = Date.now();
    let score = 0.0;
    let passed = 0;
    let total = 0;
    let error: string | null = null;

    try {
      await executeAgentTrial({
        approach,
        model,
        seed,
        sandboxDir,
        templateDir,
        taskInstance: task,
        mock
      });

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
        approach,
        model,
        taskCategory,
        taskInstance: task,
        seed,
        score,
        passed,
        total,
        error,
        durationMs
      };
      
      results.push(trialResult);

      // Print status line (no emojis)
      console.log(`[Trial ${idx + 1}/${targetCombos.length}] Finished: Score: ${score.toFixed(2)} | Pass Rate: ${passed}/${total} | Duration: ${durationMs}ms`);
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

  const results = await runBenchmark({ mock, limit });

  // Save to JSONL and CSV
  const resultsJsonlPath = path.join(__dirname, 'results.jsonl');
  const resultsCsvPath = path.join(__dirname, 'results.csv');

  // JSONL output
  const jsonlLines = results.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(resultsJsonlPath, jsonlLines + '\n');
  console.log(`Results saved to JSONL: ${resultsJsonlPath}`);

  // CSV output
  const csvHeaders = 'approach,model,taskCategory,taskInstance,seed,score,passed,total,durationMs,error\n';
  const csvRows = results.map((r) => {
    const errorMsg = r.error ? `"${r.error.replace(/"/g, '""')}"` : '';
    return `${r.approach},${r.model},${r.taskCategory},${r.taskInstance},${r.seed},${r.score},${r.passed},${r.total},${r.durationMs},${errorMsg}`;
  }).join('\n');
  fs.writeFileSync(resultsCsvPath, csvHeaders + csvRows + '\n');
  console.log(`Results saved to CSV: ${resultsCsvPath}`);

  // Print raw summaries (no emojis)
  console.log('\n--- Summary statistics ---');
  const summaryMap = new Map<string, { sum: number; count: number }>();
  for (const r of results) {
    const key = `${r.approach} | ${r.model}`;
    const entry = summaryMap.get(key) || { sum: 0, count: 0 };
    entry.sum += r.score;
    entry.count += 1;
    summaryMap.set(key, entry);
  }

  for (const [key, entry] of summaryMap.entries()) {
    const avg = entry.sum / entry.count;
    console.log(`${key}: Average Score = ${avg.toFixed(3)} (count: ${entry.count})`);
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
