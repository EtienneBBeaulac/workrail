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



const {join}=require('node:path');
const {readdirSync,lstatSync}=require('node:fs');
const {createHash}=require('node:crypto');
const capture=base=>{const rows={};const walk=path=>{for(const name of readdirSync(path).sort()){const file=join(path,name),info=lstatSync(file);if(info.isSymbolicLink())throw new Error('Unexpected fixture link');if(info.isDirectory())walk(file);else if(info.isFile()){if(info.size>1048576||Object.keys(rows).length>=128)throw new Error('Fixture bound exceeded');rows[file.slice(base.length+1)]=createHash('sha256').update(readFileSync(file)).digest('hex');}else throw new Error('Unexpected fixture object');}};walk(base);if(Object.keys(rows).length===0)throw new Error('Empty native fixture');return rows;};
const folder=process.argv[3];process.env.HOME=folder;process.env.WORKRAIL_DATA_DIR=folder;process.chdir(root);
require('reflect-metadata');
const {composeAnswerEngine}=require(`${root}/src/answer-v1/engine-composition.ts`);
const {InMemoryWorkflowStorage}=require(`${root}/src/infrastructure/storage/in-memory-storage.ts`);
const {StaticFeatureFlagProvider}=require(`${root}/src/config/feature-flags.ts`);
const {executeStartWorkflow}=require(`${root}/src/v2/usecases/start-workflow.ts`);
const {executeCheckpoint}=require(`${root}/src/mcp/handlers/v2-checkpoint.ts`);
const config={storage:{journalRootDir:join(folder,'sessions'),hostIndexRootDir:join(folder,'index')},keyringPath:join(folder,'keys/keyring.json'),workflowStoragePath:join(folder,'workflows')};
const engine=await composeAnswerEngine(config);if(engine.kind!=='ready')throw new Error('Native composition unavailable');
const storage=new InMemoryWorkflowStorage([{id:'legacy-proof',name:'Legacy proof',description:'Fixture',version:'1.0.0',steps:[{id:'one',title:'One',prompt:'Original task'},{id:'two',title:'Two',prompt:'Later task'}]}]);
const flags=new StaticFeatureFlagProvider({sessionTools:false,v2Tools:true});
const deps={...engine,workflowReader:storage,fallbackWorkflowReader:storage,featureFlags:flags};
const opened=await executeStartWorkflow(deps,{workflowId:'legacy-proof',workspacePath:folder,goal:'checkpoint proof',injectOnboarding:false});
if(opened.isErr())throw new Error('Core start unavailable: '+JSON.stringify(opened.error));
const ctx={v2:engine,workflowService:storage,featureFlags:flags,sessionManager:null,httpServer:null};
const first=await executeCheckpoint({checkpointToken:opened.value.checkpointToken},ctx);if(first.isErr())throw new Error('Checkpoint unavailable: '+JSON.stringify(first.error));
const truth1=await engine.sessionStore.load(opened.value.sessionId);if(truth1.isErr())throw new Error('Truth unavailable');
const second=await executeCheckpoint({checkpointToken:opened.value.checkpointToken},ctx);if(second.isErr())throw new Error('Replay unavailable: '+JSON.stringify(second.error));
const truth2=await engine.sessionStore.load(opened.value.sessionId);if(truth2.isErr())throw new Error('Replay truth unavailable');
const beforeWrong=capture(folder);
const wrong=await executeCheckpoint({checkpointToken:opened.value.continueToken},ctx);
const afterWrong=capture(folder);
const truth3=await engine.sessionStore.load(opened.value.sessionId);if(truth3.isErr())throw new Error('Refusal truth unavailable');

const {handleV2ContinueWorkflow}=require(`${root}/src/mcp/handlers/v2-execution.ts`);
const {getV2ExecutionRenderEnvelope}=require(`${root}/src/mcp/render-envelope.ts`);
const {projectRunDagV2}=require(`${root}/src/v2/projections/run-dag.ts`);
const body=result=>{if(result.type!=='success')throw new Error('Continue unavailable: '+JSON.stringify(result));return getV2ExecutionRenderEnvelope(result.data)?.response??result.data;};
const advance=body(await handleV2ContinueWorkflow({continueToken:opened.value.continueToken,output:{notesMarkdown:'First original advance'}},ctx));
const rehydrated=body(await handleV2ContinueWorkflow({continueToken:first.value.nextCall.params.continueToken,intent:'rehydrate',workspacePath:folder},ctx));
const checkpointAfter=await engine.sessionStore.load(opened.value.sessionId);if(checkpointAfter.isErr())throw new Error('Checkpoint final truth unavailable');
const originalNode=truth1.value.events.find(e=>e.kind==='node_created'&&e.scope?.nodeId===String(opened.value.nodeId));const checkpointNode=truth1.value.events.find(e=>e.kind==='node_created'&&e.scope?.nodeId===String(first.value.checkpointNodeId));if(!originalNode?.data.snapshotRef||!checkpointNode?.data.snapshotRef)throw new Error('Original snapshot identity unavailable');
const fork=await executeStartWorkflow(deps,{workflowId:'legacy-proof',workspacePath:folder,goal:'fork proof',injectOnboarding:false});if(fork.isErr())throw new Error('Fork start unavailable');
const child1=body(await handleV2ContinueWorkflow({continueToken:fork.value.continueToken,output:{notesMarkdown:'First child'}},ctx));
const firstForkTruth=await engine.sessionStore.load(fork.value.sessionId);if(firstForkTruth.isErr())throw new Error('First branch truth unavailable');
const parent=body(await handleV2ContinueWorkflow({continueToken:fork.value.continueToken,intent:'rehydrate',workspacePath:folder},ctx));
const child2=body(await handleV2ContinueWorkflow({continueToken:parent.continueToken,output:{notesMarkdown:'Second child'}},ctx));
const beforeReplay=await engine.sessionStore.load(fork.value.sessionId);if(beforeReplay.isErr())throw new Error('Fork truth unavailable');
const replay=body(await handleV2ContinueWorkflow({continueToken:parent.continueToken,output:{notesMarkdown:'Ignored replay'}},ctx));
const afterReplay=await engine.sessionStore.load(fork.value.sessionId);if(afterReplay.isErr())throw new Error('Fork replay truth unavailable');
const dag=projectRunDagV2(afterReplay.value.events);if(dag.isErr())throw new Error('Fork projection unavailable');
const run=dag.value.runsById[fork.value.runId];const children=run.edges.filter(edge=>edge.fromNodeId===fork.value.nodeId);
console.log(JSON.stringify({kind:'prototype',checkpointIdentityPreserved:first.value.checkpointNodeId===second.value.checkpointNodeId,replayHistoryIdentical:JSON.stringify(truth1.value.events)===JSON.stringify(truth2.value.events),wrongOperation:wrong.isErr()?wrong.error.kind:'accepted',wrongHistoryIdentical:JSON.stringify(truth2.value.events)===JSON.stringify(truth3.value.events),wrongFixtureBytesIdentical:JSON.stringify(beforeWrong)===JSON.stringify(afterWrong),nativeFixtureFiles:Object.keys(beforeWrong).length,originalSnapshotPreserved:JSON.stringify(originalNode.data.snapshotRef)===JSON.stringify(checkpointNode.data.snapshotRef),priorCheckpointEventsPreserved:JSON.stringify(checkpointAfter.value.events.slice(0,truth1.value.events.length))===JSON.stringify(truth1.value.events),checkpointPending:rehydrated.pending?.stepId??null,advancedPending:advance.pending?.stepId??null,distinctChildren:new Set(children.map(edge=>edge.toNodeId)).size,tips:run.tipNodeIds.length,child1Pending:child1.pending?.stepId??null,child2Pending:child2.pending?.stepId??null,forkResponseIdentical:JSON.stringify(replay)===JSON.stringify(child2),forkReplayHistoryIdentical:JSON.stringify(beforeReplay.value.events)===JSON.stringify(afterReplay.value.events),forkChildrenAreTips:JSON.stringify([...new Set(children.map(edge=>edge.toNodeId))].sort())===JSON.stringify([...run.tipNodeIds].sort()),priorForkEventsPreserved:JSON.stringify(beforeReplay.value.events.slice(0,firstForkTruth.value.events.length))===JSON.stringify(firstForkTruth.value.events)&&JSON.stringify(afterReplay.value.events.slice(0,firstForkTruth.value.events.length))===JSON.stringify(firstForkTruth.value.events)}));
