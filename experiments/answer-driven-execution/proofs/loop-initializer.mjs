// Observe the real compiler and interpreter with caller-materialized sealed inputs.
import { registerHooks, createRequire } from 'node:module';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = realpathSync(process.argv[2]);
const sourcePath = resolve(root, 'src') + sep;
const dependencyPath = resolve(root, 'node_modules') + sep;
const sourceUrl = pathToFileURL(sourcePath).href;
const require = createRequire(`${root}/package.json`);
const ts = require(`${root}/node_modules/typescript/lib/typescript.js`);
const configBytes = readFileSync(`${root}/tsconfig.base.json`);
const config = ts.convertCompilerOptionsFromJson(JSON.parse(configBytes).compilerOptions, root);
if (config.errors.length) throw new Error('Compiler options unavailable');
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(sourceUrl) && specifier.startsWith('.')) {
      const path = resolve(dirname(fileURLToPath(context.parentURL)), specifier);
      const candidates = path.endsWith('.js') ? [path.slice(0, -3) + '.ts', path] : [path + '.ts', path];
      const target = candidates.find(existsSync);
      if (!target || !target.startsWith(sourcePath)) throw new Error('Source import unavailable');
      return next(target, context);
    }
    const result = next(specifier, context);
    if (result.url.startsWith('file:')) {
      const path = realpathSync(fileURLToPath(result.url));
      if (!path.startsWith(sourcePath) && !path.startsWith(dependencyPath)) {
        throw new Error('Undeclared prototype import');
      }
    }
    return result;
  },
  load(url, context, next) {
    if (url.startsWith(sourceUrl) && url.endsWith('.ts')) {
      const path = fileURLToPath(url);
      const source = readFileSync(path);
      const result = ts.transpileModule(source.toString('utf8'), { fileName: path,
        compilerOptions: config.options, reportDiagnostics: true });
      if (result.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) {
        throw new Error('Source transpilation unavailable');
      }
      return { format: 'commonjs', source: result.outputText, shortCircuit: true };
    }
    return next(url, context);
  },
});

try {
  require('reflect-metadata');
  const { WorkflowCompiler } = require(`${root}/src/application/services/workflow-compiler.ts`);
  const { WorkflowInterpreter } = require(`${root}/src/application/services/workflow-interpreter.ts`);
  const { createWorkflow } = require(`${root}/src/types/workflow.ts`);
  const { loadRoutineDefinitions } = require(`${root}/src/application/services/compiler/routine-loader.ts`);
  const routines = loadRoutineDefinitions();
  if (routines.isErr()) throw new Error('Routine loading unavailable');
  const compiler = new WorkflowCompiler();
  function observeCase(type, decision) {
    const caseName = `${type}_${decision}`;
    const refused = phase => ({ case: caseName, kind: 'refused', phase });
    const definition = { id: 'seeded-loop', name: 'Seeded loop', version: '1.0.0', description: 'Initializer semantics',
      steps: [
        { id: 'initialize', title: 'Initialize', prompt: 'Decide whether work is needed.', outputContract: { contractRef: 'wr.contracts.loop_control' } },
        { id: 'loop', type: 'loop', title: 'Loop', loop: { type, maxIterations: 3,
          conditionSource: { kind: 'artifact_contract', contractRef: 'wr.contracts.loop_control', loopId: 'loop' } },
          body: [{ id: 'body', title: 'Work', prompt: 'Work and decide.', outputContract: { contractRef: 'wr.contracts.loop_control' } }] },
        { id: 'finish', title: 'Finish', prompt: 'Record completion.' },
      ] };
    const compilation = compiler.compile(createWorkflow(definition, { kind: 'bundled' }));
    if (compilation.isErr()) return refused('compile');
    const compiled = compilation.value;
    const interpreter = new WorkflowInterpreter();
    const initial = interpreter.next(compiled, { kind: 'init' });
    if (initial.isErr() || !initial.value.next) return refused('initialize');
    function advance(view, phase, artifacts = []) {
      if (!view.next) return refused(phase);
      const accepted = interpreter.applyEvent(view.state,
        { kind: 'step_completed', stepInstanceId: view.next.stepInstanceId });
      if (accepted.isErr()) return refused(phase);
      const selected = interpreter.next(compiled, accepted.value, {}, artifacts);
      return selected.isErr() ? refused(phase) : { kind: 'step', view: selected.value };
    }
    const visited = [initial.value.next.stepInstanceId.stepId];
    const seeded = advance(initial.value, 'seed', [{ kind: 'wr.loop_control', decision }]);
    if (seeded.kind === 'refused') return seeded;
    if (!seeded.view.next) return refused('seed');
    const selected = seeded.view.next.stepInstanceId.stepId;
    visited.push(selected);
    let current = seeded.view;
    if (selected === 'body') {
      const stopped = advance(current, 'body', [{ kind: 'wr.loop_control', decision: 'stop' }]);
      if (stopped.kind === 'refused') return stopped;
      if (!stopped.view.next) return refused('body');
      current = stopped.view;
      visited.push(current.next.stepInstanceId.stepId);
    }
    const finished = advance(current, 'finish');
    if (finished.kind === 'refused') return finished;
    return { case: caseName, kind: 'observed', selected, visited,
      isComplete: finished.view.isComplete, state: finished.view.state.kind,
      pending: finished.view.next?.stepInstanceId.stepId ?? null };
  }
  const rows = ['while', 'until'].flatMap(type => ['continue', 'stop'].map(decision => observeCase(type, decision)));
  process.stdout.write(JSON.stringify({ version: 1, rows,
    routines: [...routines.value.routines.keys()].sort(), routineWarnings: routines.value.warnings.length }));
} catch (error) {
  process.stderr.write(String(error.stack || error) + '\n');
  process.exitCode = 2;
}
