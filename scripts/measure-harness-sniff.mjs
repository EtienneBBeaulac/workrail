import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COUNTS = Object.freeze({ first: 200, warm: 10000 });
export const THRESHOLD_MS = 2;
export const SCENARIOS = Object.freeze([
  { id: 'unknown', env: {}, expected: 'mcp' },
  { id: 'generic-vscode', env: { TERM_PROGRAM: 'vscode' }, expected: 'mcp' },
  { id: 'explicit-cursor', env: { CURSOR_APP: 'true' }, expected: 'cursor' },
  { id: 'claude-code', env: { CLAUDE_CODE: 'true' }, expected: 'claude_code' },
  { id: 'claude-cli', env: { CLAUDE_CLI: 'true' }, expected: 'claude_code' },
  { id: 'daemon-marker', env: { WORKRAIL_IS_DAEMON: 'true' }, expected: 'daemon' },
  { id: 'trusted-daemon', env: {}, currentHost: 'daemon', expected: 'daemon' },
  { id: 'trusted-mcp', env: {}, currentHost: 'mcp', expected: 'mcp' },
  ...['mcp', 'cursor', 'claude_code', 'daemon'].map(expected => ({
    id: `override-${expected}`, env: { WORKRAIL_FORCE_HARNESS: expected, CLAUDE_CODE: 'true', CURSOR_APP: 'true', WORKRAIL_IS_DAEMON: 'true' }, currentHost: 'daemon', expected,
  })),
  { id: 'claude-conflict', env: { CLAUDE_CODE: 'true', CURSOR_APP: 'true', WORKRAIL_IS_DAEMON: 'true' }, currentHost: 'daemon', expected: 'claude_code' },
  { id: 'cursor-conflict', env: { CURSOR_APP: 'true', WORKRAIL_IS_DAEMON: 'true' }, currentHost: 'daemon', expected: 'cursor' },
  { id: 'invalid-override', env: { WORKRAIL_FORCE_HARNESS: 'invalid', CLAUDE_CLI: 'true' }, expected: 'claude_code' },
  { id: 'false-markers', env: { CLAUDE_CODE: 'false', CLAUDE_CLI: '1', CURSOR_APP: 'false', WORKRAIL_IS_DAEMON: '1' }, expected: 'mcp' },
]);
const ENV_KEYS = ['WORKRAIL_FORCE_HARNESS', 'CLAUDE_CODE', 'CLAUDE_CLI', 'CURSOR_APP', 'WORKRAIL_IS_DAEMON', 'TERM_PROGRAM'];
export const SOURCE_FILES = [
  'src/v2/durable-core/domain/harness-detection.ts',
  'src/v2/infra/local/harness-sniff.ts',
  'src/v2/usecases/start-workflow.ts',
  'src/mcp/handlers/v2-execution/continue-advance.ts',
  'scripts/measure-harness-sniff.mjs',
  'scripts/verify-harness-sniff-receipt.mjs',
];
export const BUILD_FILES = SOURCE_FILES.filter(p => p.endsWith('.ts')).map(p => p.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js'));
export async function bindings(files) {
  return Object.fromEntries(await Promise.all(files.map(async p => [p, createHash('sha256').update(await readFile(path.join(ROOT, p))).digest('hex')])));
}
export function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { median: sorted[Math.ceil(0.5 * sorted.length) - 1], p99: sorted[Math.ceil(0.99 * sorted.length) - 1], max: sorted.at(-1) };
}
function setEnvironment(values) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
}
async function worker(scenario, mode, count) {
  setEnvironment(scenario.env);
  const importStart = performance.now();
  const { sniffHarness, captureProcessHarnessIndicators } = await import(pathToFileURL(path.join(ROOT, 'dist/v2/infra/local/harness-sniff.js')).href);
  const importMs = performance.now() - importStart;
  const capture = mode === 'slow-control' ? () => {
    const start = performance.now();
    while (performance.now() - start < 3) { /* Bounded intentional timing fault inside capture. */ }
    return captureProcessHarnessIndicators();
  } : undefined;
  const invoke = () => capture ? sniffHarness(scenario.currentHost, capture) : sniffHarness(scenario.currentHost);
  if (count > 1) {
    for (let i = 0; i < 100; i++) {
      if (invoke() !== scenario.expected) throw new Error('Warm-up functional classification failed');
    }
  }
  const samples = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    const actual = invoke();
    samples.push(performance.now() - start);
    if (actual !== scenario.expected) throw new Error(`${scenario.id}: expected ${scenario.expected}, got ${actual}`);
  }
  // These functional controls exercise live capture again after changing env in this process.
  setEnvironment({ CURSOR_APP: 'true' });
  const changed = sniffHarness();
  setEnvironment({});
  const recovered = sniffHarness();
  if (changed !== 'cursor' || recovered !== 'mcp') throw new Error('Live environment recapture failed');
  return { samples, importMs, actual: scenario.expected, recovery: { changed, recovered } };
}
function subprocess(scenario, mode, count, deadlineMs) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', JSON.stringify({ scenario, mode, count })], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Measurement subprocess deadline exceeded')); }, deadlineMs);
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr += b; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Measurement subprocess failed (${code}): ${stderr}`));
      try { resolve({ ...JSON.parse(stdout), processMs: performance.now() - start }); } catch (e) { reject(e); }
    });
  });
}
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--worker') {
    const { scenario, mode, count } = JSON.parse(args[1]);
    process.stdout.write(JSON.stringify(await worker(scenario, mode, count)));
    return;
  }
  const mode = args[args.indexOf('--mode') + 1];
  const out = args[args.indexOf('--out') + 1];
  if (!args.includes('--mode') || !args.includes('--out') || !['baseline', 'slow-control'].includes(mode) || !out || !path.isAbsolute(out)) throw new Error('Usage: --mode baseline|slow-control --out absolutePath');
  const source = await bindings(SOURCE_FILES), build = await bindings(BUILD_FILES);
  const startedAt = new Date().toISOString();
  const deadline = performance.now() + 600000;
  const results = [];
  for (const scenario of mode === 'slow-control' ? SCENARIOS.slice(0, 1) : SCENARIOS) {
    const first = [], imports = [], processes = [];
    const run = count => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error('Overall measurement deadline exceeded');
      return subprocess(scenario, mode, count, Math.min(remaining, count === 1 ? 10000 : 60000));
    };
    for (let i = 0; i < COUNTS.first; i++) {
      const receipt = await run(1);
      first.push(receipt.samples[0]); imports.push(receipt.importMs); processes.push(receipt.processMs);
    }
    // Warm-up takes place in a separate worker only through the same production function.
    const warm = await run(COUNTS.warm);
    const samples = warm.samples;
    results.push({ scenario, actual: warm.actual, recovery: warm.recovery,
      first: { samples: first, summary: summarize(first) }, warm: { samples, summary: summarize(samples) },
      import: { samples: imports, summary: summarize(imports) }, process: { samples: processes, summary: summarize(processes) },
      warmWorker: { importMs: warm.importMs, processMs: warm.processMs, untimedWarmupCalls: 100 },
    });
  }
  if (JSON.stringify(source) !== JSON.stringify(await bindings(SOURCE_FILES)) || JSON.stringify(build) !== JSON.stringify(await bindings(BUILD_FILES))) throw new Error('Source/build changed during measurement');
  const outcome = results.every(r => r.first.summary.p99 < THRESHOLD_MS && r.warm.summary.p99 < THRESHOLD_MS) ? 'threshold_met' : 'threshold_exceeded';
  const receipt = { version: 1, mode, execution: 'successful', outcome, startedAt, endedAt: new Date().toISOString(), counts: COUNTS, thresholdMs: THRESHOLD_MS,
    provenance: { root: ROOT, source, build, node: process.version, execPath: process.execPath, platform: process.platform, arch: process.arch, hostname: os.hostname(), release: os.release(), cpu: os.cpus()[0]?.model }, results };
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(receipt)}\n`);
  console.log(JSON.stringify({ out, mode, outcome, scenarioCount: results.length }));
  process.exitCode = outcome === 'threshold_met' ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exitCode = 2; });
