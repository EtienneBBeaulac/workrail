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
  const { VALID_METRICS_OUTCOME } = await import(constants);
  const completed = { v: 1, eventId: 'completed', eventIndex: 0, sessionId: 'session',
    kind: 'run_completed', scope: { runId: 'run' }, data: { startGitSha: 'before',
      endGitSha: 'after', gitBranch: 'branch', agentCommitShas: [],
      captureConfidence: 'high', durationMs: 1 } };
  const missing = projectSessionMetricsV2([completed]);
  const outcomes = ['success', 'partial', 'abandoned', 'error'];
  const reported = outcomes.map(expected => {
    const context = { v: 1, eventId: 'context', eventIndex: 1, sessionId: 'session',
      kind: 'context_set', scope: { runId: 'run' }, data: { context: { metrics_outcome: expected } } };
    const result = projectSessionMetricsV2([completed, context]);
    return { expected, actual: result === null ? null : result.outcome, completed: result !== null };
  });
  return { version: 1, supported: [...VALID_METRICS_OUTCOME].sort(), completed: missing !== null,
    unknown: missing === null ? null : missing.outcome, reported };
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
