import type { SessionJournal } from '../../../answer-v1/journal.js';
import type { DeliveryRef, OwnerFence } from '../../../answer-v1/contracts/invocation-contract.js';
import type { AgentTool } from '../../agent-loop.js';
import { createDaemonAnswerModel, type AnswerModelOptions } from '../answer-model.js';
import { createWorkspaceEffectController } from '../workspace-effect-controller.js';
import type { LinuxScratchWorkspace } from './workspace.js';

const fields:Readonly<Record<'Read'|'Write'|'Edit'|'Bash'|'Glob'|'Grep',readonly string[]>>={
  Read:['path'],Write:['path','content'],Edit:['path','old_string','new_string'],Bash:['command'],Glob:['pattern'],Grep:['pattern'],
};
const descriptors:readonly AgentTool[]=Object.entries(fields).map(([name,keys])=>({
  name,label:name,description:name==='Grep'?'Search literal text in the scratch workspace.':`${name} in the isolated Linux scratch workspace; does not modify the host checkout.`,
  inputSchema:{type:'object',additionalProperties:false,required:keys,properties:Object.fromEntries(keys.map(k=>[k,{type:'string'}]))},
  async execute(){return {content:[{type:'text' as const,text:'Supervised host execution required.'}],details:{kind:'refused'}};},
}));
/** The effect controller owns invocation, so a typed uncertain backend result cannot become
 * ordinary tool text. There is no fallback to local tools or a replacement environment. */
export function createLinuxScratchAnswerModel(
  journal:SessionJournal,delivery:DeliveryRef,owner:OwnerFence,workspace:LinuxScratchWorkspace,
  options:Omit<Extract<AnswerModelOptions,{readonly provider:unknown}>,'workspaceTools'|'effects'>,
){
  const result = createDaemonAnswerModel({...options,
    workspaceTools:descriptors,effects:createWorkspaceEffectController(journal,delivery,owner,workspace),
  });
  if (result.kind !== 'created') return result;
  // The budgeted transport owns the retained system prompt. Bind workspace semantics
  // to the turn input so they reach both that transport and directly injected providers.
  return { kind: 'created' as const, model: { generate(input: Parameters<typeof result.model.generate>[0], signal: AbortSignal) {
    return result.model.generate({ ...input, instruction:
      'You are working in an isolated Linux scratch copy. Changes do not update the user checkout. '
      + 'Inspection artifacts may be retained by the host; do not claim export or merge.\n\n' + input.instruction }, signal);
  } } };
}
