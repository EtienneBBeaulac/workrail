import * as fs from 'fs';
import * as path from 'path';
import {
  registerCleanupHandlers,
  createSandboxWorkspace,
  cleanupSandboxWorkspace
} from './sandbox.js';
import {
  gradeWorkspace,
  readAllSourceFiles,
  runLlmJudge
} from './grader.js';
import {
  executeAgentTrial
} from './agent.js';

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
  readonly eleganceScore: number;
  readonly judgeReasoning: string | null;
}

export interface RunOptions {
  readonly limit?: number;
  readonly smoke?: boolean;
  readonly models?: readonly string[];
  readonly tasks?: readonly string[];
  readonly seeds?: readonly number[];
  readonly approaches?: readonly string[];
  readonly workflow?: string;
}

export async function runBenchmark(options: RunOptions = {}): Promise<readonly TrialResult[]> {
  registerCleanupHandlers();

  const smoke = options.smoke ?? false;
  const models = options.models ?? ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022'];
  const seeds = options.seeds ?? [1, 2, 3];
  const approaches = options.approaches ?? ['workrail', 'skills', 'vanilla'];
  const workflow = options.workflow ?? 'wr.coding-task';
  
  let testCorpusRoot = path.join(__dirname, 'corpus', workflow);
  if (!fs.existsSync(testCorpusRoot) || !fs.statSync(testCorpusRoot).isDirectory()) {
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

  // Apply limit if specified
  const limit = options.limit ?? combinations.length;
  const targetCombos = combinations.slice(0, limit);

  console.log(`Running benchmark pilot sequentially: ${targetCombos.length} total trials.`);

  for (let idx = 0; idx < targetCombos.length; idx++) {
    const { approach, model, task, seed } = targetCombos[idx]!;
    
    const taskCategory = task.startsWith('favorable')
      ? 'favorable'
      : (task.startsWith('adversarial') ? 'adversarial' : 'neutral');
    
    const templateDir = path.join(testCorpusRoot, task);

    console.log(`[Trial ${idx + 1}/${targetCombos.length}] Starting: ${approach} | ${model} | ${task} | Seed ${seed}`);

    const sandboxRes = createSandboxWorkspace(task, templateDir);
    if (!sandboxRes.ok) {
      console.error(`[Trial ${idx + 1}/${targetCombos.length}] Failed to create sandbox: ${sandboxRes.error}`);
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
        error: sandboxRes.error,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0.0,
        turns: 0,
        commandRuns: 0,
        eleganceScore: 0.0,
        judgeReasoning: sandboxRes.error
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
    let eleganceScore = 0.0;
    let judgeReasoning: string | null = null;

    try {
      const metrics = await executeAgentTrial({
        approach,
        model,
        seed,
        sandboxDir,
        templateDir,
        taskInstance: task,
        smoke,
        workflow
      });

      inputTokens = metrics.inputTokens;
      outputTokens = metrics.outputTokens;
      costUsd = metrics.costUsd;
      turns = metrics.turns;
      commandRuns = metrics.commandRuns;

      // Grade the workspace
      const gradeRes = await gradeWorkspace(sandboxDir, templateDir);
      if (gradeRes.ok) {
        passed = gradeRes.passed;
        total = gradeRes.total;

        // Run LLM-as-a-judge for elegance on successful functional results
        if (smoke) {
          eleganceScore = approach === 'workrail' ? 0.95 : (approach === 'skills' ? 0.80 : 0.70);
          judgeReasoning = `[SMOKE] Simulated elegance for approach: ${approach}`;
        } else {
          const apiKey = process.env['ANTHROPIC_API_KEY'];
          if (apiKey) {
            // Extract task instructions
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

            const sourceCode = readAllSourceFiles(path.join(sandboxDir, 'src'));
            const judgeResult = await runLlmJudge(apiKey, taskInstructions, sourceCode);
            eleganceScore = judgeResult.score;
            judgeReasoning = judgeResult.reasoning;
          } else {
            eleganceScore = 0.8;
            judgeReasoning = 'Skipped LLM judge (ANTHROPIC_API_KEY not set)';
          }
        }
        score = 0.8 + 0.2 * eleganceScore;
      } else {
        score = gradeRes.score;
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
        commandRuns,
        eleganceScore,
        judgeReasoning
      };
      
      results.push(trialResult);

      // Print status line (no emojis)
      console.log(`[Trial ${idx + 1}/${targetCombos.length}] Finished: Score: ${score.toFixed(2)} | Pass Rate: ${passed}/${total} | Elegance: ${eleganceScore.toFixed(2)} | Duration: ${durationMs}ms | Cost: $${costUsd.toFixed(4)} | Turns: ${turns} | Commands: ${commandRuns}`);
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
  const smoke = args.includes('--smoke') || process.env.WORKRAIL_BENCHMARK_SMOKE === 'true';
  
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

  let models: string[] | undefined;
  const modelsIdx = args.indexOf('--models');
  if (modelsIdx !== -1 && args[modelsIdx + 1]) {
    models = args[modelsIdx + 1]!.split(',');
  }

  let approaches: string[] | undefined;
  const approachesIdx = args.indexOf('--approaches');
  if (approachesIdx !== -1 && args[approachesIdx + 1]) {
    approaches = args[approachesIdx + 1]!.split(',');
  }

  let tasks: string[] | undefined;
  const tasksIdx = args.indexOf('--tasks');
  if (tasksIdx !== -1 && args[tasksIdx + 1]) {
    tasks = args[tasksIdx + 1]!.split(',');
  }

  const results = await runBenchmark({ smoke, limit, workflow, models, approaches, tasks });

  // Save to JSONL and CSV
  const resultsJsonlPath = path.join(__dirname, smoke ? 'results-smoke.jsonl' : 'results.jsonl');
  const resultsCsvPath = path.join(__dirname, smoke ? 'results-smoke.csv' : 'results.csv');

  // JSONL output
  const jsonlLines = results.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(resultsJsonlPath, jsonlLines + '\n');
  console.log(`Results saved to JSONL: ${resultsJsonlPath}`);

  // CSV output
  const csvHeaders = 'workflow,approach,model,taskCategory,taskInstance,seed,score,passed,total,durationMs,inputTokens,outputTokens,costUsd,turns,commandRuns,eleganceScore,judgeReasoning,error\n';
  const csvRows = results.map((r) => {
    const errorMsg = r.error ? `"${r.error.replace(/"/g, '""')}"` : '';
    const cleanReasoning = r.judgeReasoning ? `"${r.judgeReasoning.replace(/"/g, '""')}"` : '""';
    return `${r.workflow},${r.approach},${r.model},${r.taskCategory},${r.taskInstance},${r.seed},${r.score},${r.passed},${r.total},${r.durationMs},${r.inputTokens},${r.outputTokens},${r.costUsd},${r.turns},${r.commandRuns},${r.eleganceScore},${cleanReasoning},${errorMsg}`;
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
