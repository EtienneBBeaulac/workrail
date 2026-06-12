import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import Anthropic from '@anthropic-ai/sdk';
import { runCommandWithTimeout } from './sandbox.js';

export type GradingResult =
  | { readonly ok: true; readonly score: number; readonly passed: number; readonly total: number }
  | { readonly ok: false; readonly score: number; readonly error: string };

/**
 * Verifies syntax of all TS source files in a directory recursively.
 * Award score 0.1 if syntax passes but compilation/tests fail.
 */
export function verifySyntaxInDir(dirPath: string): { ok: true } | { ok: false; error: string } {
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

export function readAllSourceFiles(dir: string): string {
  try {
    let result = '';
    const recurse = (currentDir: string) => {
      const files = fs.readdirSync(currentDir);
      for (const file of files) {
        const full = path.join(currentDir, file);
        if (fs.statSync(full).isDirectory()) {
          recurse(full);
        } else if (file.endsWith('.ts')) {
          const content = fs.readFileSync(full, 'utf8');
          const relPath = path.relative(dir, full);
          result += `// File: ${relPath}\n${content}\n\n`;
        }
      }
    };
    recurse(dir);
    return result;
  } catch {
    return '';
  }
}

export async function runLlmJudge(
  apiKey: string,
  taskInstructions: string,
  sourceCode: string
): Promise<{ readonly score: number; readonly reasoning: string }> {
  try {
    const anthropic = new Anthropic({ apiKey });
    const response = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1000,
      system: `You are an expert code quality auditor. Your job is to grade the architectural elegance, readability, and modularity of the provided TypeScript solution on a scale from 0.0 (poor, spaghetti code, bad practices) to 1.0 (production-grade, clean, idiomatic code).
You must output your response strictly in JSON format matching this schema:
{
  "reasoning": "A brief explanation of your code quality assessment.",
  "score": 0.95
}`,
      messages: [
        {
          role: 'user',
          content: `Task Instructions:\n${taskInstructions}\n\nTypeScript Source Code:\n\`\`\`typescript\n${sourceCode}\n\`\`\``
        }
      ]
    });

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as any).text)
      .join('\n')
      .trim();

    let jsonText = text;
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/```\s*([\s\S]*?)\s*```/);
    if (jsonMatch && jsonMatch[1]) {
      jsonText = jsonMatch[1].trim();
    }

    const parsed = JSON.parse(jsonText);
    const score = typeof parsed.score === 'number' ? Math.max(0, Math.min(1, parsed.score)) : 0.8;
    const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : 'No reasoning provided';
    return { score, reasoning };
  } catch (err: any) {
    return { score: 0.8, reasoning: `Failed to execute LLM judge: ${err.message}` };
  }
}
