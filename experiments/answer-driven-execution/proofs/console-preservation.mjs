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


const { mkdtemp, mkdir, readdir, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, relative } = require('node:path');
const folder = await mkdtemp(join(tmpdir(),'workrail-console-prototype-'));
process.env.HOME=join(folder,'home');
await mkdir(process.env.HOME);
require('reflect-metadata');
const { composeAnswerEngine }=require(`${root}/src/answer-v1/engine-composition.ts`);
const { executeStartWorkflow }=require(`${root}/src/v2/usecases/start-workflow.ts`);
const { executeAdvanceCore }=require(`${root}/src/mcp/handlers/v2-advance-core/index.ts`);
const { createWorkflow }=require(`${root}/src/types/workflow.ts`);
const { asSortedEventLog }=require(`${root}/src/v2/durable-core/sorted-event-log.ts`);
const { buildSessionIndex }=require(`${root}/src/v2/durable-core/session-index.ts`);
const { ConsoleService }=require(`${root}/src/v2/usecases/console-service.ts`);
const { LocalDirectoryListingV2 }=require(`${root}/src/v2/infra/local/directory-listing/index.ts`);
const { NodeFileSystemV2 }=require(`${root}/src/v2/infra/local/fs/index.ts`);
const { createHash }=require('node:crypto');
const definition={id:'console-proof',name:'Console proof',description:'Metadata retention',version:'1.0.0',steps:[{id:'work',title:'Work',prompt:'Review',outputContract:{contractRef:'wr.contracts.review_verdict'}}]};
const workflow=createWorkflow(definition,{kind:'bundled'});
const artifact={kind:'wr.review_verdict',verdict:'minor',confidence:'high',summary:'One control finding.',findings:[{severity:'minor',summary:'A control finding.',findingCategory:'correctness',file:'control.ts',startLine:1,causalLink:{trigger:'input',effect:'output'},remediation:'Keep exact data.'}]};
const notes='# Review\n\nPreserved café observations.\n';
async function bytes(dir) {
 const files={};
 for(const entry of await readdir(dir,{withFileTypes:true})) {
  const file=join(dir,entry.name);
  if(entry.isDirectory())Object.assign(files,await bytes(file));
  else if(entry.isFile())files[relative(folder,file)]=createHash('sha256').update(await readFile(file)).digest('hex');
  else throw new Error('Unexpected storage entry');
 }
 return files;
}
try {
 const config={storage:{journalRootDir:join(folder,'sessions'),hostIndexRootDir:join(folder,'index')},keyringPath:join(folder,'keys/keyring.json'),workflowStoragePath:join(folder,'workflows')};
 const engine=await composeAnswerEngine(config);
 if(engine.kind!=='ready')throw new Error('Composition unavailable');
 const start=await executeStartWorkflow({...engine,fallbackWorkflowReader:{getWorkflowById:async()=>workflow}},{workflowId:definition.id,workspacePath:folder,goal:'Metadata proof',injectOnboarding:false});
 if(start.isErr())throw new Error('Start unavailable: '+JSON.stringify(start.error));
 const {sessionId,runId,nodeId}=start.value;
 const result=await engine.gate.withHealthySessionLock(sessionId,lock=>engine.sessionStore.load(sessionId).andThen(truth=>{
  const node=truth.events.find(event=>event.kind==='node_created'&&event.scope.nodeId===nodeId);
  const run=truth.events.find(event=>event.kind==='run_started');
  if(!node||!run)throw new Error('Started node unavailable');
  return engine.snapshotStore.getExecutionSnapshotV1(node.data.snapshotRef).andThen(snapshot=>{
   if(!snapshot)throw new Error('Snapshot unavailable');
   const sorted=asSortedEventLog(truth.events);if(sorted.isErr())throw new Error('Sorted truth unavailable');
   return executeAdvanceCore({mode:{kind:'fresh',sourceNodeId:nodeId,snapshot},truth,sessionId,runId,attemptId:engine.idFactory.mintAttemptId(),workflowHash:run.data.workflowHash,dedupeKey:'console-proof:advance',inputContext:undefined,inputOutput:{notesMarkdown:notes,artifacts:[artifact]},lock,pinnedWorkflow:workflow,ports:engine,lockedIndex:buildSessionIndex(sorted.value)});
  });
 }));
 if(result.isErr())throw new Error('Advance unavailable: '+JSON.stringify(result.error));
 const accepted=await engine.sessionStore.load(sessionId);if(accepted.isErr())throw new Error('Committed truth unavailable');
 const advanced=accepted.value.events.some(event=>event.kind==='advance_recorded'&&event.data.outcome.kind==='advanced');
 const complete=accepted.value.events.some(event=>event.kind==='run_completed'&&event.scope.runId===runId);
 if(!advanced||!complete)throw new Error('Valid fixture did not advance through completion');
 const note=accepted.value.events.find(event=>event.kind==='node_output_appended'&&event.data.payload.payloadKind==='notes');
 if(!note)throw new Error('Accepted note unavailable');
 const before=await bytes(folder);
 const service=new ConsoleService({directoryListing:new LocalDirectoryListingV2(new NodeFileSystemV2()),dataDir:engine.dataDir,sessionStore:{load:id=>engine.sessionStore.load(id)},snapshotStore:engine.snapshotStore,pinnedWorkflowStore:engine.pinnedStore});
 const detail=await service.getNodeDetail(String(sessionId),String(note.scope.nodeId));
 if(detail.isErr())throw new Error('Console detail unavailable: '+JSON.stringify(detail.error));
 const after=await bytes(folder);
 console.log(JSON.stringify({kind:'observed',notes:detail.value.recapMarkdown,artifacts:detail.value.artifacts.map(item=>item.content),unchangedBytes:JSON.stringify(before)===JSON.stringify(after),files:Object.keys(before).length,events:accepted.value.events.length}));
} finally {
 await rm(folder,{recursive:true,force:true});

}
