import { describe, expect, it } from 'vitest';
import os from 'node:os';
// This standalone measurement tool intentionally stays executable without a TS loader.
// @ts-expect-error Standalone .mjs tools have no declaration files.
import { verifyPair, verifyReceipt } from '../../../scripts/verify-harness-sniff-receipt.mjs';
// @ts-expect-error Standalone .mjs tools have no declaration files.
import { ROOT, COUNTS, SCENARIOS, summarize } from '../../../scripts/measure-harness-sniff.mjs';

const current = { source: { synthetic: 'source' }, build: { synthetic: 'build' } };
// Synthetic samples test verifier logic only; they are never saved as assay evidence.
function fixture(mode: 'baseline' | 'slow-control') {
  const distribution = (count: number, value: number) => {
    const samples = Array.from({ length: count }, () => value);
    return { samples, summary: summarize(samples) };
  };
  const scenarios: readonly { expected: string }[] = mode === 'baseline' ? SCENARIOS : SCENARIOS.slice(0, 1);
  return {
    version: 1, mode, execution: 'successful', outcome: mode === 'baseline' ? 'threshold_met' : 'threshold_exceeded',
    counts: COUNTS, thresholdMs: 2, startedAt: '2026-10-10T00:00:00.000Z', endedAt: '2026-10-10T00:01:00.000Z',
    provenance: { root: ROOT, ...current, node: process.version, execPath: process.execPath, platform: process.platform, arch: process.arch, hostname: os.hostname(), release: os.release(), cpu: os.cpus()[0]?.model },
    results: scenarios.map(scenario => ({ scenario, actual: scenario.expected, recovery: { changed: 'cursor', recovered: 'mcp' },
      first: distribution(200, mode === 'baseline' ? 0.01 : 3.1), warm: distribution(10000, mode === 'baseline' ? 0.01 : 3.1),
      import: distribution(200, 1), process: distribution(200, 10), warmWorker: { importMs: 1, processMs: 40000, untimedWarmupCalls: 100 },
    })),
  };
}
describe('harness performance receipt verifier', () => {
  it('accepts complete functional receipts only with a successful semantic negative control', () => {
    expect(verifyPair(fixture('baseline'), fixture('slow-control'), current)).toEqual({ kind: 'verified_assay', outcome: 'threshold_met', negativeControl: 'threshold_exceeded' });
  });
  it('uses nearest rank rather than interpolating quantiles', () => {
    expect(summarize(Array.from({ length: 200 }, (_, i) => i))).toEqual({ median: 99, p99: 197, max: 199 });
  });
  it('rejects stale source bindings', () => {
    expect(verifyPair(fixture('baseline'), fixture('slow-control'), { ...current, source: {} }).kind).toBe('invalid_receipt');
  });
  it('rejects omitted scenarios and sample count changes', () => {
    const missingScenario = fixture('baseline'); missingScenario.results.pop();
    expect(verifyReceipt(missingScenario, 'baseline', current).kind).toBe('invalid_receipt');
    const missingSample = fixture('baseline'); missingSample.results[0]!.warm.samples.pop();
    expect(verifyReceipt(missingSample, 'baseline', current).kind).toBe('invalid_receipt');
  });
  it('rejects invalid raw samples and incorrect summaries', () => {
    const invalid = fixture('baseline'); invalid.results[0]!.first.samples[0] = NaN;
    expect(verifyReceipt(invalid, 'baseline', current).kind).toBe('invalid_receipt');
    const altered = fixture('baseline'); altered.results[0]!.warm.summary.p99 = 0;
    expect(verifyReceipt(altered, 'baseline', current).kind).toBe('invalid_receipt');
  });
  it('rejects wrong classification or cached environment recovery', () => {
    const wrong = fixture('baseline'); wrong.results[0]!.actual = 'cursor';
    expect(verifyReceipt(wrong, 'baseline', current).kind).toBe('invalid_receipt');
    const cached = fixture('baseline'); cached.results[0]!.recovery.recovered = 'cursor';
    expect(verifyReceipt(cached, 'baseline', current).kind).toBe('invalid_receipt');
  });
  it('never treats process failure or missing control as negative timing evidence', () => {
    const failed = fixture('slow-control'); failed.execution = 'failed';
    expect(verifyPair(fixture('baseline'), failed, current).kind).toBe('invalid_receipt');
    expect(verifyPair(fixture('baseline'), undefined, current).kind).toBe('invalid_receipt');
    expect(verifyPair(fixture('baseline'), fixture('baseline'), current).kind).toBe('invalid_receipt');
  });
  it('reports a valid baseline threshold failure as semantic evidence', () => {
    const baseline = fixture('baseline'); baseline.results[0]!.first.samples.fill(2);
    baseline.results[0]!.first.summary = summarize(baseline.results[0]!.first.samples);
    baseline.outcome = 'threshold_exceeded';
    expect(verifyPair(baseline, fixture('slow-control'), current)).toEqual({ kind: 'verified_assay', outcome: 'threshold_exceeded', negativeControl: 'threshold_exceeded' });
  });
});
