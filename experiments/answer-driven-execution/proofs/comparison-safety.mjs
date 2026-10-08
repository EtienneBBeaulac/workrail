import { registerHooks } from 'node:module';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

async function observe(root, dependency) {
  const subject = pathToFileURL(`${realpathSync(root)}/experiments/answer-driven-execution/usability-scorer.mts`).href;
  const zodRoot = pathToFileURL(`${realpathSync(dependency)}/`).href;
  const builtins = new Set(['node:fs/promises', 'node:path', 'node:url']);
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL === subject && specifier === 'zod') return nextResolve(`${zodRoot}index.js`, context);
    if (context.parentURL === subject && builtins.has(specifier)) return nextResolve(specifier, context);
    if (specifier === subject || (context.parentURL?.startsWith(zodRoot)
        && (specifier.startsWith('./') || specifier.startsWith('../')))) {
      const resolved = nextResolve(specifier, context);
      if (specifier !== subject && !resolved.url.startsWith(zodRoot)) throw new Error('Dependency escaped');
      return resolved;
    }
    throw new Error('Undeclared scorer import');
  }});
  const { scoreInput } = await import(subject);
  function trial(scenario, repetition, arm) {
    const runId = `${scenario}-${repetition}-${arm}`;
    const expected = [{ id: 'first', value: `A-${scenario}-${repetition}` },
      { id: 'second', value: `B-${scenario}-${repetition}` }];
    const recoveryLength = arm === 'baseline' ? 5 : 3;
    const finished = scenario === 'finished_recovery';
    const injected = scenario === 'malformed' || scenario === 'lost_response';
    const count = finished ? recoveryLength : scenario === 'lost_response' ? recoveryLength + 1 : injected ? 3 : 2;
    const calls = Array.from({ length: count }, (_, i) => ({ id: `call-${i}`, atMs: i * 100,
      operation: finished ? 'read' : 'write', outcome: i === 0 && injected ? 'injected_fault' : 'success' }));
    const commits = finished ? [] : expected.map((observation, i) => ({ eventId: `${runId}-event-${i}`,
      callId: `call-${scenario === 'malformed' ? i + 1 : i}`, runId, observation }));
    return { scenario, repetition, arm, runId, expected, calls, commits, retained: expected,
      model: 'synthetic-control', effort: 'high', fixture: `${scenario}/${repetition}`,
      fault: injected ? { kind: scenario, callId: 'call-0', noticeAtMs: 0 } : { kind: 'none' },
      reads: finished ? expected.map((observation, i) => ({ callId: `call-${i}`, runId, observation })) : [],
      answer: finished ? expected : [], completed: true, unauthorizedEffects: [], termination: 'finished', elapsedMs: count * 100 };
  }
  const intact = { version: 1, stage: 'A', trials: ['ordinary', 'malformed', 'lost_response', 'finished_recovery']
    .flatMap(scenario => Array.from({ length: 5 }, (_, i) => ['baseline', 'candidate'].map(arm => trial(scenario, i + 1, arm))).flat()) };
  const rows = [];
  for (const name of ['intact', 'lost', 'duplicate', 'wrong_run', 'recovery_write']) {
    const input = structuredClone(intact);
    const target = input.trials.find(t => t.arm === 'candidate' && t.repetition === 1
      && t.scenario === (name === 'recovery_write' ? 'finished_recovery' : 'ordinary'));
    if (name === 'lost') target.retained = target.retained.slice(0, -1);
    if (name === 'duplicate') target.commits.push({ ...target.commits[0], eventId: `${target.runId}-duplicate` });
    if (name === 'wrong_run') target.commits[0].runId = 'unrelated-run';
    if (name === 'recovery_write') {
      target.calls.push({ id: 'extra-write', atMs: target.elapsedMs, operation: 'write', outcome: 'success' });
      target.elapsedMs += 100;
    }
    const actual = scoreInput(input);
    rows.push({ case: name, kind: actual.kind,
      status: actual.kind === 'scored' ? actual.report.status : null,
      scope: actual.kind === 'scored' ? actual.report.scope : null,
      releaseApproval: actual.kind === 'scored' ? actual.report.releaseApproval : null,
      trialIssues: actual.kind === 'scored' ? actual.report.measurements.flatMap(m => m.issues) : null,
      safety: actual.kind === 'scored' ? actual.report.measurements.filter(m => m.arm === 'candidate').flatMap(m => m.safety) : null,
      population: actual.kind === 'scored' ? actual.report.measurements.length : null });
  }
  return { version: 1, rows };
}

try {
  if (process.argv.length !== 4) throw new Error('Expected source and dependency roots');
  process.stdout.write(JSON.stringify(await observe(process.argv[2], process.argv[3])));
} catch {
  process.stderr.write('Comparison scorer observation unavailable\n');
  process.exitCode = 2;
}
