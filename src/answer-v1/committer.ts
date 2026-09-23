import { errAsync } from 'neverthrow';
import type { FencedAnswerCommitter, FencedCommitResult, OwnerFence, PreparedAnswer } from './contracts/invocation-contract.js';
import type { ReceiptRef } from './contracts/answer-contract.js';
import { SessionJournal, preparedAnswer } from './journal.js';
import { hostEvent, owns, readHostState, workView, inspection } from './host-state.js';
import { executeAdvanceCore } from '../mcp/handlers/v2-advance-core/index.js';
import { asSessionId, asRunId, asNodeId } from '../v2/durable-core/ids/index.js';
import { asSortedEventLog } from '../v2/durable-core/sorted-event-log.js';
import { buildSessionIndex } from '../v2/durable-core/session-index.js';
import { getCachedWorkflow } from '../v2/usecases/workflow-object-cache.js';
import { hasWorkflowDefinitionShape } from '../types/workflow-definition.js';

export class AnswerCommitter implements FencedAnswerCommitter {
  constructor(private readonly journal: SessionJournal) {}
  async commit(answer: PreparedAnswer, owner: OwnerFence, signal: AbortSignal): Promise<FencedCommitResult> {
    const j=this.journal;
    // This seam is deliberately before the lock: a replacement may win while dispatch is paused.
    if(!await j.fault('before_engine_transaction',signal))return {kind:'commit_uncertain',invocation:answer.invocation};
    const result=await j.locked<FencedCommitResult>(signal,{kind:'not_retained',reason:'unavailable_storage'},async(state,lock)=>{
      if(!owns(state,owner))return {kind:'stale_owner'};
      if(state.records.some(r=>r.kind==='stopped'))return {kind:'not_retained',reason:'session_terminated'};
      const prepared=state.records.find(r=>r.kind==='prepared'&&r.invocation===answer.invocation);
      if(prepared?.kind!=='prepared')return {kind:'not_retained',reason:'invalid_reference'};
      const original=preparedAnswer(state,prepared);
      if(answer.execution!==original.execution||answer.delivery!==original.delivery||answer.response!==original.response||answer.toolCallId!==original.toolCallId||answer.reply!==original.reply||answer.answer.kind!=='notes'||answer.answer.notes!==prepared.notes)return {kind:'not_retained',reason:'invalid_reference'};
      const prior=state.records.find(r=>r.kind==='committed'&&r.invocation===answer.invocation);
      if(prior?.kind==='committed'){
        const eventIndex=state.truth.events.findIndex(e=>e.kind==='answer_host_recorded'&&e.data.kind==='committed'&&e.data.invocation===answer.invocation);
        const prefix=state.truth.events.slice(0,eventIndex+1);
        const view=await workView(j.engine,{...state,node:prior.successorNode,
          records:state.records.slice(0,state.records.indexOf(prior)+1),truth:{...state.truth,events:prefix}});
        return view.kind==='unavailable'?{kind:'not_retained',reason:'unavailable_storage'}:{kind:'replay',receipt:prior.receipt as ReceiptRef,original:inspection(view)};
      }
      const view=await workView(j.engine,state);
      if(view.kind!=='question'||view.reply!==answer.reply)return {kind:'not_retained',reason:'stale_reference'};
      const node=state.truth.events.find(e=>e.kind==='node_created'&&e.scope.nodeId===state.node&&e.scope.runId===state.run.scope.runId);
      if(node?.kind!=='node_created')return {kind:'not_retained',reason:'unavailable_storage'};
      const snapshot=await j.engine.snapshotStore.getExecutionSnapshotV1(node.data.snapshotRef);
      const pinned=await j.engine.pinnedStore.get(state.run.data.workflowHash);
      if(snapshot.isErr()||!snapshot.value||pinned.isErr()||pinned.value?.sourceKind!=='v1_pinned'||!hasWorkflowDefinitionShape(pinned.value.definition))return {kind:'not_retained',reason:'unavailable_storage'};
      const sorted=asSortedEventLog(state.truth.events);
      if(sorted.isErr())return {kind:'not_retained',reason:'unavailable_storage'};
      const receipt=j.engine.idFactory.mintEventId() as ReceiptRef;
      let attempted=false;
      const advanced=await executeAdvanceCore({mode:{kind:'fresh',sourceNodeId:asNodeId(state.node),snapshot:snapshot.value},
        truth:state.truth,sessionId:asSessionId(state.enrollment.execution),runId:asRunId(state.run.scope.runId),
        attemptId:j.engine.idFactory.mintAttemptId(),workflowHash:state.run.data.workflowHash,dedupeKey:`answer:${answer.invocation}`,inputContext:undefined,
        inputOutput:{notesMarkdown:prepared.notes},lock,pinnedWorkflow:getCachedWorkflow(state.run.data.workflowHash,pinned.value.definition),
        lockedIndex:buildSessionIndex(sorted.value),ports:{...j.engine,sessionStore:{append:(_lock,plan)=>{
          const next=plan.events.find(e=>e.kind==='advance_recorded');
          if(next?.kind!=='advance_recorded'||next.data.outcome.kind!=='advanced')return errAsync({code:'SESSION_STORE_INVARIANT_VIOLATION' as const,message:'Unsupported engine outcome'});
          if(!j.available(signal))return errAsync({code:'SESSION_STORE_IO_ERROR' as const,message:'Cancelled before commit'});
          attempted=true;
          return j.engine.sessionStore.append(lock,{...plan,events:[...plan.events,hostEvent(j.engine,state,{kind:'committed',invocation:answer.invocation,receipt,successorNode:next.data.outcome.toNodeId,notes:prepared.notes},state.truth.events.length+plan.events.length)]},state.truth);
        }}}});
      if(advanced.isErr())return attempted?{kind:'commit_uncertain',invocation:answer.invocation}:{kind:'not_retained',reason:'unavailable_storage'};
      const refreshed=await readHostState(j.engine,state.enrollment);
      const next=refreshed.kind==='loaded'?await workView(j.engine,refreshed.state):undefined;
      return next&&next.kind!=='unavailable'?{kind:'recorded',receipt,disposition:'accepted',view:next}:{kind:'commit_uncertain',invocation:answer.invocation};
    });
    return (result.kind==='recorded'||result.kind==='replay')&&!await j.fault('after_engine_commit',signal)?{kind:'commit_uncertain',invocation:answer.invocation}:result;
  }
}
