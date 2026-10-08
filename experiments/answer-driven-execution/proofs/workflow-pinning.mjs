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
const compilerConfig = ts.convertCompilerOptionsFromJson(JSON.parse(configBytes).compilerOptions, root);
if (compilerConfig.errors.length) throw new Error('Compiler options unavailable');
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
        compilerOptions: compilerConfig.options, reportDiagnostics: true });
      if (result.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) {
        throw new Error('Source transpilation unavailable');
      }
      return { format: 'commonjs', source: result.outputText, shortCircuit: true };
    }
    return next(url, context);
  },
});


const { join } = require('node:path');
const { readFile, writeFile } = require('node:fs/promises');
require('reflect-metadata');
const { createAnswerWorker } = require(`${root}/src/answer-v1/worker.ts`);
const folder=process.argv[3], mode=process.argv[4];
const signal=()=>AbortSignal.timeout(15000);
const config={storage:{journalRootDir:join(folder,'sessions'),hostIndexRootDir:join(folder,'index')},keyringPath:join(folder,'keys/keyring.json'),workflowStoragePath:join(folder,'workflows')};
const runtime=await createAnswerWorker(config,signal());
if(runtime.kind!=='created') throw new Error('Composition unavailable: '+JSON.stringify(runtime));
try {
 if(mode==='original'||mode==='replacement') {
  const opened=await runtime.opener.open({workflowId:'continuity',goal:mode,workspacePath:config.workflowStoragePath},signal());
  if(opened.kind!=='opened'||opened.view.kind!=='question')throw new Error('Open unavailable: '+JSON.stringify(opened));
  const first=await runtime.worker.answer(opened.view.reply,{kind:'notes',notes:mode+' first'},signal());
  if(first.kind!=='recorded'||first.view.kind!=='question')throw new Error('Answer unavailable: '+JSON.stringify(first));
  await writeFile(join(folder,mode+'.json'),JSON.stringify({recovery:opened.recovery,view:first.view}));
  console.log(JSON.stringify({kind:'prepared',mode,instruction:first.view.instruction}));
 } else if(mode==='recover') {
  const original=JSON.parse(await readFile(join(folder,'original.json'),'utf8'));
  const replacement=JSON.parse(await readFile(join(folder,'replacement.json'),'utf8'));
  const oldView=await runtime.recovery.recover(original.recovery,signal());
  const newView=await runtime.recovery.recover(replacement.recovery,signal());
  const finish=async view=>view.kind==='question'?await runtime.worker.answer(view.reply,{kind:'notes',notes:'finished'},signal()):null;
  const oldResult=await finish(oldView), newResult=await finish(newView);
  console.log(JSON.stringify({kind:'observed',originalKind:oldView.kind,originalInstruction:oldView.kind==='question'?oldView.instruction:null,replacementKind:newView.kind,replacementInstruction:newView.kind==='question'?newView.instruction:null,exactOriginalView:JSON.stringify(original.view)===JSON.stringify(oldView),exactReplacementView:JSON.stringify(replacement.view)===JSON.stringify(newView),originalFinish:oldResult?.view?.kind,originalDisposition:oldResult?.disposition, replacementFinish:newResult?.view?.kind,replacementDisposition:newResult?.disposition}));
 } else throw new Error('Invalid mode');
} finally {
 const closed = await runtime.close(signal());
 if (closed.kind !== 'closed') throw new Error('Worker close unavailable');

}
