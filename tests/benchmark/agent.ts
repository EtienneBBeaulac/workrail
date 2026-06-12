import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { createWorkRailEngine } from '../../src/engine/index.js';
import type { EngineError } from '../../src/engine/types.js';
import { runCommandWithTimeout } from './sandbox.js';

export interface TrialMetrics {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly turns: number;
  readonly commandRuns: number;
}

const PRICING: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  'claude-3-5-sonnet-20241022': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'claude-3-5-haiku-20241022': { inputPerMillion: 0.8, outputPerMillion: 4.0 },
  'default': { inputPerMillion: 3.0, outputPerMillion: 15.0 }
};

function getEngineErrorMessage(err: EngineError): string {
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as any).message);
  }
  return JSON.stringify(err);
}

export function generateSkillPromptFromWorkflow(workflowId: string): string {
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

export async function executeAgentTrial(args: {
  readonly approach: string;
  readonly model: string;
  readonly seed: number;
  readonly sandboxDir: string;
  readonly templateDir: string;
  readonly taskInstance: string;
  readonly smoke: boolean;
  readonly workflow: string;
}): Promise<TrialMetrics> {
  const { approach, model, seed, sandboxDir, templateDir, taskInstance, smoke, workflow } = args;

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

  if (smoke) {
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
      const messages: Anthropic.MessageParam[] = [];

      messages.push({
        role: 'user',
        content: `WorkRail session started. First Step Instructions:\n\n${currentRes.pending?.prompt}`
      });

      let stepLimit = 0;
      let finished = false;

      while (stepLimit++ < 15 && !finished) {
        let turnLimit = 0;
        let completeStepCalled = false;
        let lastOutput = '';

        while (turnLimit++ < 10) {
          const response = await callAnthropic({
            model,
            max_tokens: 1500,
            system: systemPrompt,
            messages,
            tools: [
              ...fileTools,
              {
                name: 'completeStep',
                description: 'Call this tool when you have completed the current step instructions and are ready to advance.',
                input_schema: {
                  type: 'object',
                  properties: {
                    notes: { type: 'string', description: 'Detailed markdown notes of what was accomplished in this step.' }
                  },
                  required: ['notes']
                }
              }
            ]
          });

          const assistantText = response.content
            .filter(c => c.type === 'text')
            .map(c => (c as any).text)
            .join('\n');

          const toolCalls = response.content.filter(c => c.type === 'tool_use');

          if (toolCalls.length === 0) {
            messages.push({
              role: 'assistant',
              content: assistantText || 'I am working on the task.'
            });
            break;
          }

          messages.push({
            role: 'assistant',
            content: response.content
          });

          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const tc of toolCalls) {
            const toolCall = tc as any;
            const tName = toolCall.name;
            const tInput = toolCall.input;
            let result = '';

            if (tName === 'readFile') {
              result = runReadFile(tInput.path);
            } else if (tName === 'writeFile') {
              result = runWriteFile(tInput.path, tInput.content);
            } else if (tName === 'runCommand') {
              result = await runCommand(tInput.command);
            } else if (tName === 'completeStep') {
              completeStepCalled = true;
              lastOutput = tInput.notes || 'Completed step.';
              result = 'Step completion submitted to WorkRail engine.';
            } else {
              result = `Error: Unknown tool: ${tName}`;
            }

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolCall.id,
              content: result
            });
          }

          messages.push({
            role: 'user',
            content: toolResults
          });

          if (completeStepCalled) {
            break;
          }
        }

        if (completeStepCalled) {
          const ackToken = currentRes.ackToken;
          if (!ackToken) {
            break;
          }
          const nextRes = await engine.continueWorkflow(
            currentRes.stateToken,
            ackToken,
            { notesMarkdown: lastOutput }
          );

          if (!nextRes.ok) {
            messages.push({
              role: 'user',
              content: `WorkRail validation failed:\n\n${getEngineErrorMessage(nextRes.error)}\n\nPlease correct the errors and re-submit completeStep.`
            });
            continue;
          }

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
            messages.push({
              role: 'user',
              content: `Step advanced. Next Step Instructions:\n\n${currentRes.pending?.prompt}`
            });
          }
        } else {
          break;
        }
      }
    } finally {
      await engine.close();
    }
  } else {
    // Vanilla or Skills (Standard Agent Loop)
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: `Instructions: ${taskInstructions}\n\nPlease implement the requested code in the workspace and verify correctness using vitest.`
      }
    ];

    let turnLimit = 0;
    while (turnLimit++ < 15) {
      const response = await callAnthropic({
        model,
        max_tokens: 2000,
        system: systemPrompt,
        messages,
        tools: fileTools
      });

      const assistantText = response.content
        .filter(c => c.type === 'text')
        .map(c => (c as any).text)
        .join('\n');

      const toolCalls = response.content.filter(c => c.type === 'tool_use');

      if (toolCalls.length === 0) {
        messages.push({
          role: 'assistant',
          content: assistantText || 'Completed implementation.'
        });
        break;
      }

      messages.push({
        role: 'assistant',
        content: response.content
      });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tc of toolCalls) {
        const toolCall = tc as any;
        const tName = toolCall.name;
        const tInput = toolCall.input;
        let result = '';

        if (tName === 'readFile') {
          result = runReadFile(tInput.path);
        } else if (tName === 'writeFile') {
          result = runWriteFile(tInput.path, tInput.content);
        } else if (tName === 'runCommand') {
          result = await runCommand(tInput.command);
        } else {
          result = `Error: Unknown tool: ${tName}`;
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: result
        });
      }

      messages.push({
        role: 'user',
        content: toolResults
      });
    }
  }

  const price = PRICING[model] || PRICING['default'];
  const costUsd = (inputTokens / 1000000) * price.inputPerMillion + (outputTokens / 1000000) * price.outputPerMillion;
  return { inputTokens, outputTokens, costUsd, turns, commandRuns };
}
