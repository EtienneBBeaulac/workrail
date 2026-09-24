import type { JsonValue } from '../../v2/durable-core/canonical/json-types.js';
import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { ControlledToolExecution } from '../agent-loop.js';
import type { SessionJournal } from '../../answer-v1/journal.js';
import type { DeliveryRef, OwnerFence } from '../../answer-v1/contracts/invocation-contract.js';
import { reserveWorkspaceEffect, retainWorkspaceEffect } from '../../answer-v1/workspace-effect-journal.js';
import { WorkspaceEffectIntentSchema } from '../../v2/durable-core/schemas/session/workspace-effect.js';
import { JsonValueSchema } from '../../v2/durable-core/canonical/json-zod.js';
import { toCanonicalBytes } from '../../v2/durable-core/canonical/jcs.js';

import type { WorkspaceFailure } from '../../answer-v1/contracts/workspace-effect-contract.js';
type PreparedCall = Readonly<{ id: string; name: string; digest: string; position: number }>;
type State =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'batch'; modelCall: string; calls: readonly PreparedCall[] }>
  | Readonly<{ kind: 'executing' }>
  | Readonly<{ kind: 'halted'; failure: WorkspaceFailure }>;
function digest(input: unknown): string | undefined {
  try {
  const parsed = JsonValueSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const bytes = toCanonicalBytes(parsed.data as JsonValue);
  return bytes.isErr() || bytes.value.length > 1024 * 1024 ? undefined : createHash('sha256').update(bytes.value).digest('hex');
  } catch { return undefined; }
}

/** Tool accounting, not a supervisor or lease. Trusted composition must supply those
 * before public execution is enabled. Failure latches for this entire delivery. */
export function createWorkspaceEffectController(journal: SessionJournal, delivery: DeliveryRef, owner: OwnerFence) {
  let state: State = {kind:'idle'};
  const halt = (failure: WorkspaceFailure) => { state = {kind:'halted',failure}; return {kind:'halted'} as const; };
  const boundary: ControlledToolExecution = { async execute(call, invoke, signal) {
    if (state.kind === 'halted') return {kind:'halted'};
    if (state.kind !== 'batch') return halt({reason:'invalid_batch'});
    const batch = state;
    const next = batch.calls[0];
    if (!next || next.id !== call.callId || next.name !== call.name || next.digest !== digest(call.input))
      return halt({reason:'invalid_batch'});
    state = {kind:'executing'};
    const reservation = await reserveWorkspaceEffect(journal,owner,{
      delivery,modelCall:batch.modelCall,toolCallId:next.id,position:next.position,
      operation:next.name,inputDigest:next.digest,
    },signal);
    if (reservation.kind !== 'reserved') return halt({reason:'intent_unacknowledged'});
    const effect = reservation.effect;
    if ((state as State).kind === 'halted') return {kind:'halted'};
    if (signal.aborted) return halt({reason:'execution_unknown',effect});
    try {
      const result = await invoke();
      if (signal.aborted) return halt({reason:'execution_unknown',effect});
      const content = result.content.map(block=>block.text).join('\n');
      if (content.length > 65536) return halt({reason:'execution_unknown',effect});
      const retained = await retainWorkspaceEffect(journal,owner,{
        kind:'workspace_effect_completed',effect,result:{content,isError:false},
      },signal);
      if (retained.kind !== 'retained') return halt({reason:'outcome_unacknowledged',effect});
      // A concurrent misuse must not clear the failure latch after an awaited operation.
      if ((state as State).kind === 'halted') return {kind:'halted'};
      state = batch.calls.length === 1 ? {kind:'idle'} : {...batch,calls:batch.calls.slice(1)};
      return {kind:'completed',result};
    } catch {
      await retainWorkspaceEffect(journal,owner,{kind:'workspace_effect_unconfirmed',effect,reason:'execution_failed'},signal);
      return halt({reason:'execution_unknown',effect});
    }
  } };
  return {
    boundary,
    failure(): WorkspaceFailure | undefined { return state.kind === 'halted' ? state.failure : undefined; },
    prepare(modelCall: string, response: Anthropic.Message): 'ready' | 'halted' {
      if (state.kind === 'halted') return 'halted';
      if (state.kind !== 'idle') { halt({reason:'invalid_batch'}); return 'halted'; }
      const calls = response.content.filter(block=>block.type === 'tool_use');
      // The host captures the entire answer response; none of these tools will run.
      if (calls.some(call=>call.name === 'answer_work')) return 'ready';
      const ids = new Set<string>();
      const prepared: PreparedCall[] = [];
      for (const [position,call] of calls.entries()) {
        const inputDigest = digest(call.input);
        const valid = WorkspaceEffectIntentSchema.safeParse({kind:'workspace_effect_intended',effect:'validation',
          delivery,epoch:owner.epoch.toString(),modelCall,toolCallId:call.id,position,operation:call.name,inputDigest});
        if (!valid.success || ids.has(call.id) || !inputDigest) { halt({reason:'invalid_batch'}); return 'halted'; }
        ids.add(call.id); prepared.push({id:call.id,name:call.name,digest:inputDigest,position});
      }
      state = prepared.length ? {kind:'batch',modelCall,calls:prepared} : {kind:'idle'};
      return 'ready';
    },
  };
}
