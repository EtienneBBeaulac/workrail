import { registerHooks } from 'node:module';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

async function observe(root, dependency) {
  const sourceRoot = realpathSync(root);
  const dispatcher = pathToFileURL(`${sourceRoot}/src/coordinators/gate-evaluator-dispatcher.ts`).href;
  const schema = pathToFileURL(`${sourceRoot}/src/v2/durable-core/schemas/artifacts/gate-verdict.ts`).href;
  const zodRoot = pathToFileURL(`${realpathSync(dependency)}/`).href;
  const zodEntry = `${zodRoot}index.js`;
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL === dispatcher && specifier === '../v2/durable-core/schemas/artifacts/gate-verdict.js') {
      return nextResolve(schema, context);
    }
    if (context.parentURL === schema && specifier === 'zod') {
      return nextResolve(zodEntry, context);
    }
    if (specifier === dispatcher || (context.parentURL?.startsWith(zodRoot) && (specifier.startsWith('./') || specifier.startsWith('../')))) {
      const resolved = nextResolve(specifier, context);
      if (specifier !== dispatcher && !resolved.url.startsWith(zodRoot)) throw new Error('Dependency escaped');
      return resolved;
    }
    throw new Error('Undeclared import');
  }});
  const { evaluateGate } = await import(dispatcher);
  const valid = verdict => ({ kind: 'wr.gate_verdict', version: 1, verdict, confidence: 'high',
    rationale: 'Output satisfies the declared acceptance criteria.' });
  const cases = [
    ['missing', []], ['approved', [valid('approved')]],
    ['invalid', [{ ...valid('approved'), rationale: 'short' }]],
    ['rejected', [valid('rejected')]], ['uncertain', [valid('uncertain')]],
  ];
  const rows = [];
  for (const [name, artifacts] of cases) {
    const deps = {
      spawnSession: async () => ({ kind: 'ok', value: 'evaluator' }),
      awaitSessions: async () => ({ results: [{ handle: 'evaluator', outcome: 'success', status: 'complete', durationMs: 1 }], allSucceeded: true }),
      getAgentResult: async () => ({ recapMarkdown: 'Completed successfully.', artifacts }),
      stderr: () => {},
    };
    const result = await evaluateGate(deps, {}, 'wr.gate-eval-generic', sourceRoot, 'checked-step');
    rows.push({ case: name, verdict: result.verdict, confidence: result.confidence, stepId: result.stepId });
  }
  return { version: 1, rows };
}

try {
  if (process.argv.length !== 4) throw new Error('Expected source and dependency roots');
  process.stdout.write(JSON.stringify(await observe(process.argv[2], process.argv[3])));
} catch {
  process.stderr.write('Verdict observation unavailable\n');
  process.exitCode = 2;
}
