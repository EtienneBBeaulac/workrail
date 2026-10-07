import { registerHooks } from 'node:module';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

async function observe(root) {
  const sourceRoot = realpathSync(root);
  const projection = pathToFileURL(`${sourceRoot}/src/v2/projections/session-metrics.ts`).href;
  const constants = pathToFileURL(`${sourceRoot}/src/v2/durable-core/constants.ts`).href;
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL === projection && specifier === '../durable-core/constants.js') {
      return nextResolve(constants, context);
    }
    return nextResolve(specifier, context);
  }});
  const { projectSessionMetricsV2 } = await import(projection);
  const completed = { v: 1, eventId: 'completed', eventIndex: 0, sessionId: 'session',
    kind: 'run_completed', scope: { runId: 'run' }, data: { startGitSha: 'before',
      endGitSha: 'after', gitBranch: 'branch', agentCommitShas: ['c'.repeat(40)],
      captureConfidence: 'none', durationMs: 1 } };
  const context = { v: 1, eventId: 'context', eventIndex: 1, sessionId: 'session',
    kind: 'context_set', scope: { runId: 'run' },
    data: { context: { metrics_commit_shas: ['b'.repeat(40)] } } };
  const delivery = (runId, shas, eventIndex = 2) => ({ v: 1,
    eventId: `delivery-${eventIndex}`, eventIndex, sessionId: 'session',
    kind: 'delivery_recorded', scope: { runId }, data: { shas } });
  const matching = delivery('run', ['a'.repeat(40)]);
  const other = delivery('other-run', ['d'.repeat(40)]);
  const cases = [
    ['matching', [completed, context, matching]],
    ['context', [completed, context]],
    ['completed', [completed]],
    ['other_context', [completed, context, other]],
    ['other_completed', [completed, other]],
    ['other_before_match', [completed, context, other, delivery('run', ['a'.repeat(40)], 3)]],
    ['empty_match', [completed, context, delivery('run', [])]],
  ];
  return { version: 1, rows: cases.map(([name, events]) => {
    const result = projectSessionMetricsV2(events);
    return { case: name, completed: result !== null, actual: result === null ? [] : result.agentCommitShas };
  }) };

}

try {
  if (process.argv.length !== 3) {
    process.stderr.write('Expected one source root\n');
    process.exitCode = 2;
  } else {
    process.stdout.write(JSON.stringify(await observe(process.argv[2])));
  }
} catch {
  process.stderr.write('Metrics observation unavailable\n');
  process.exitCode = 2;
}
