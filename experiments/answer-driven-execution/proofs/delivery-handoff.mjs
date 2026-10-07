import { registerHooks } from 'node:module';
import { realpathSync } from 'node:fs';
import { readFile, access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

async function observe(root) {
  const sourceRoot = realpathSync(root);
  const url = path => pathToFileURL(`${sourceRoot}/${path}`).href;
  const coordinator = url('src/coordinators/coordinator-delivery.ts');
  const delivery = url('src/trigger/delivery-action.ts');
  const result = url('src/runtime/result.ts');
  const builtins = new Set(['node:crypto', 'node:fs/promises', 'node:os', 'node:path']);
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL === coordinator && specifier === '../trigger/delivery-action.js') {
      return nextResolve(delivery, context);
    }
    if ((context.parentURL === coordinator || context.parentURL === delivery)
        && specifier === '../runtime/result.js') return nextResolve(result, context);
    if (context.parentURL === delivery && builtins.has(specifier)) return nextResolve(specifier, context);
    if (context.parentURL === coordinator || context.parentURL === delivery || context.parentURL === result) {
      throw new Error('Undeclared proof import');
    }
    return nextResolve(specifier, context);
  }});
  const { runCoordinatorDelivery } = await import(coordinator);
  const handoff = {
    commitType: 'feat', commitScope: 'mcp', commitSubject: 'retain exact handoff',
    prTitle: 'retain exact handoff', prBody: '## Summary\nLiteral `text`, $(example), and quotation "marks".',
    filesChanged: ['src/first.ts', 'docs/path with spaces.md'], followUpTickets: [],
  };
  const notes = value => '```json\n' + JSON.stringify(value) + '\n```';
  const rows = [];
  for (const name of ['complete', 'commitType', 'commitScope', 'commitSubject', 'prTitle', 'prBody', 'filesChanged']) {
    const calls = [];
    let body = null;
    let bodyPath = null;
    const deps = { stderr() {}, async execDelivery(file, args, options) {
      calls.push({ file, args: [...args], cwd: options.cwd, timeout: options.timeout });
      if (file === 'gitleaks') {
        const error = new Error('Controlled absent optional scanner');
        error.code = 'ENOENT';
        throw error;
      }
      if (file === 'git') return { stdout: args[0] === 'commit' ? '[proof abc1234] commit' : '', stderr: '' };
      if (file === 'gh') {
        const index = args.indexOf('--body-file');
        if (index >= 0 && args[index + 1]) {
          bodyPath = args[index + 1];
          body = await readFile(bodyPath, 'utf8');
        }
        return { stdout: 'https://github.com/example/proof/pull/42', stderr: '' };
      }
      throw new Error('Undeclared execution boundary');
    } };
    let refusal = null;
    let refusalCalls = [];
    if (name !== 'complete') {
      const invalid = { ...handoff };
      delete invalid[name];
      refusal = (await runCoordinatorDelivery(deps, notes(invalid), 'proof', '/proof-workspace')).kind;
      refusalCalls = calls.splice(0);
    }
    const actual = await runCoordinatorDelivery(deps, notes(handoff), 'proof', '/proof-workspace');
    let bodyExists = false;
    if (bodyPath !== null) {
      try { await access(bodyPath); bodyExists = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    rows.push({ case: name, refusal, refusalCalls, kind: actual.kind,
      value: actual.kind === 'ok' ? actual.value : null, calls, body, bodyExists });
  }
  return { version: 1, rows };
}

try {
  if (process.argv.length !== 3) throw new Error('Expected one source root');
  process.stdout.write(JSON.stringify(await observe(process.argv[2])));
} catch {
  process.stderr.write('Delivery handoff observation unavailable\n');
  process.exitCode = 2;
}
