import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOT, COUNTS, SCENARIOS, THRESHOLD_MS, SOURCE_FILES, BUILD_FILES, bindings, summarize } from './measure-harness-sniff.mjs';

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function invalid(reason) { return { kind: 'invalid_receipt', reason }; }
export function verifyReceipt(receipt, mode, current) {
  if (!receipt || receipt.version !== 1 || receipt.mode !== mode || receipt.execution !== 'successful') return invalid('Successful typed execution receipt required');
  if (!equal(receipt.counts, COUNTS) || receipt.thresholdMs !== THRESHOLD_MS) return invalid('Fixed counts or threshold mismatch');
  const provenance = receipt.provenance;
  if (!provenance || provenance.root !== ROOT || !equal(provenance.source, current.source) || !equal(provenance.build, current.build)) return invalid('Current source/build binding mismatch');
  if (provenance.node !== process.version || provenance.execPath !== process.execPath || provenance.platform !== process.platform || provenance.arch !== process.arch || provenance.hostname !== os.hostname() || provenance.release !== os.release() || provenance.cpu !== os.cpus()[0]?.model) return invalid('Host/runtime provenance missing or changed');
  const start = Date.parse(receipt.startedAt), end = Date.parse(receipt.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 600000) return invalid('Invalid or out-of-timebox execution');
  const required = mode === 'slow-control' ? SCENARIOS.slice(0, 1) : SCENARIOS;
  if (!Array.isArray(receipt.results) || receipt.results.length !== required.length) return invalid('Scenario coverage mismatch');
  for (let i = 0; i < required.length; i++) {
    const row = receipt.results[i];
    if (!equal(row?.scenario, required[i]) || row.actual !== required[i].expected || !equal(row.recovery, { changed: 'cursor', recovered: 'mcp' })) return invalid('Functional classification or recovery control failed');
    for (const [distribution, count] of [['first', COUNTS.first], ['warm', COUNTS.warm], ['import', COUNTS.first], ['process', COUNTS.first]]) {
      const measured = row[distribution];
      if (!Array.isArray(measured?.samples) || measured.samples.length !== count || measured.samples.some(n => !Number.isFinite(n) || n < 0)) return invalid(`Invalid raw ${distribution} samples`);
      if (!equal(measured.summary, summarize(measured.samples))) return invalid(`Incorrect ${distribution} nearest-rank quantiles`);
    }
    if (row.warmWorker?.untimedWarmupCalls !== 100 || !Number.isFinite(row.warmWorker.importMs) || row.warmWorker.importMs < 0 || !Number.isFinite(row.warmWorker.processMs) || row.warmWorker.processMs < row.warmWorker.importMs) return invalid('Separate warm-worker costs missing');
    if (row.process.samples.some((n, j) => n < row.import.samples[j] || n < row.first.samples[j])) return invalid('Process cost excludes measured child time');
  }
  const met = receipt.results.every(row => row.first.summary.p99 < THRESHOLD_MS && row.warm.summary.p99 < THRESHOLD_MS);
  const outcome = met ? 'threshold_met' : 'threshold_exceeded';
  if (receipt.outcome !== outcome) return invalid('Recorded outcome disagrees with samples');
  if (mode === 'slow-control' && (met || receipt.results[0].first.summary.p99 < 3 || receipt.results[0].warm.summary.p99 < 3)) return invalid('Semantic timing fault was not demonstrated');
  return { kind: 'verified_receipt', mode, outcome };
}
export function verifyPair(baseline, control, current) {
  const baselineResult = verifyReceipt(baseline, 'baseline', current);
  if (baselineResult.kind !== 'verified_receipt') return baselineResult;
  const controlResult = verifyReceipt(control, 'slow-control', current);
  if (controlResult.kind !== 'verified_receipt') return controlResult;
  return { kind: 'verified_assay', outcome: baselineResult.outcome, negativeControl: 'threshold_exceeded' };
}
export async function verifyCurrentFunctionalCases() {
  const keys = ['WORKRAIL_FORCE_HARNESS', 'CLAUDE_CODE', 'CLAUDE_CLI', 'CURSOR_APP', 'WORKRAIL_IS_DAEMON', 'TERM_PROGRAM'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const { sniffHarness } = await import(pathToFileURL(path.join(ROOT, 'dist/v2/infra/local/harness-sniff.js')).href);
  try {
    for (const scenario of SCENARIOS) {
      for (const key of keys) delete process.env[key];
      Object.assign(process.env, scenario.env);
      if (sniffHarness(scenario.currentHost) !== scenario.expected) return invalid(`Current production functional case failed: ${scenario.id}`);
    }
    for (const key of keys) delete process.env[key];
    process.env.CURSOR_APP = 'true';
    const changed = sniffHarness();
    delete process.env.CURSOR_APP;
    if (changed !== 'cursor' || sniffHarness() !== 'mcp') return invalid('Current production recovery recapture failed');
    return { kind: 'verified_functional_cases' };
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}
async function main() {
  const args = process.argv.slice(2);
  const baselinePath = args[args.indexOf('--baseline') + 1], controlPath = args[args.indexOf('--control') + 1];
  if (!args.includes('--baseline') || !args.includes('--control') || !baselinePath || !controlPath) throw new Error('Usage: --baseline receiptPath --control receiptPath');
  let baseline, control;
  try { [baseline, control] = await Promise.all([baselinePath, controlPath].map(async p => JSON.parse(await readFile(p, 'utf8')))); }
  catch (error) {
    console.log(JSON.stringify({ kind: error.code === 'ENOENT' ? 'receipt_unavailable' : 'invalid_receipt', reason: error.message }));
    process.exitCode = 2; return;
  }
  const current = { source: await bindings(SOURCE_FILES), build: await bindings(BUILD_FILES) };
  const result = verifyPair(baseline, control, current);
  if (result.kind === 'verified_assay') {
    const functional = await verifyCurrentFunctionalCases();
    if (functional.kind !== 'verified_functional_cases') { console.log(JSON.stringify(functional)); process.exitCode = 2; return; }
  }
  console.log(JSON.stringify(result));
  process.exitCode = result.kind === 'verified_assay' ? (result.outcome === 'threshold_met' ? 0 : 1) : 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(JSON.stringify({ kind: 'verification_unavailable', reason: e.message })); process.exitCode = 2; });
