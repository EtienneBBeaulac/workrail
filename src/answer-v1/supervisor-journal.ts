import {
  SupervisorCreateIntendedSchema, SupervisorCreatedSchema, SupervisorStartIntendedSchema,
  SupervisorStartedSchema, SupervisorStopIntendedSchema, SupervisorProcessStoppedSchema,
  SupervisorUnconfirmedSchema,
} from '../v2/durable-core/schemas/session/supervisor.js';
import type { OwnerFence } from './contracts/invocation-contract.js';
import type { SessionJournal } from './journal.js';
import { owns } from './host-state.js';
import { foldSupervisor } from './supervisor-state.js';

const CreateInput = SupervisorCreateIntendedSchema.omit({kind:true,supervisor:true,epoch:true}).required({daemon:true});
const TransitionInput = SupervisorCreatedSchema.omit({epoch:true})
  .or(SupervisorStartIntendedSchema.omit({epoch:true}))
  .or(SupervisorStartedSchema.omit({epoch:true}))
  .or(SupervisorStopIntendedSchema.omit({epoch:true}))
  .or(SupervisorProcessStoppedSchema.omit({epoch:true}))
  .or(SupervisorUnconfirmedSchema.omit({epoch:true}));
type Failure =
  | Readonly<{kind:'refused';reason:'invalid_input'|'not_started'|'stale_owner'|'invalid_transition'}>
  | Readonly<{kind:'unconfirmed';reason:'commit_uncertain'}>;
export type ReserveSupervisorResult = Readonly<{kind:'reserved';supervisor:string}> | Failure;
export type RetainSupervisorResult = Readonly<{kind:'retained'}> | Failure;
const uncertain = {kind:'unconfirmed',reason:'commit_uncertain'} as const;

/** Trusted retention primitive, not a backend execution capability. Only an acknowledged
 * fresh reservation may participate in later admission; reopening state grants no authority. */
export async function reserveSupervisor(
  journal:SessionJournal, owner:OwnerFence, raw:unknown, signal:AbortSignal,
):Promise<ReserveSupervisorResult> {
  const input=CreateInput.safeParse(raw);
  if(!input.success)return {kind:'refused',reason:'invalid_input'};
  try {
    if(!await journal.fault('before_supervisor_intent_append',signal))return {kind:'refused',reason:'not_started'};
  } catch {return {kind:'refused',reason:'not_started'};}
  try {
    const result=await journal.locked<ReserveSupervisorResult>(signal,uncertain,async(state,lock)=>{
      if(!owns(state,owner))return {kind:'refused',reason:'stale_owner'};
      const record=SupervisorCreateIntendedSchema.safeParse({...input.data,kind:'supervisor_create_intended',
        supervisor:journal.engine.idFactory.mintEventId(),epoch:owner.epoch.toString()});
      if(!record.success)return {kind:'refused',reason:'invalid_input'};
      if(foldSupervisor([...state.records,record.data]).kind!=='valid')return {kind:'refused',reason:'invalid_transition'};
      return await journal.append(state,lock,record.data,signal)
        ? {kind:'reserved',supervisor:record.data.supervisor} : uncertain;
    });
    return result.kind==='reserved'&&!await journal.fault('after_supervisor_intent_append',signal)?uncertain:result;
  } catch {return uncertain;}
}

/** Retains intent or observation with owner fencing. Even acknowledged process exit cannot
 * release a lease. Duplicate writes refuse, including after a lost acknowledgment and reopen.
 * The caller must obtain separate fresh admission/identity capabilities before any I/O. */
export async function retainSupervisorTransition(
  journal:SessionJournal, owner:OwnerFence, raw:unknown, signal:AbortSignal,
):Promise<RetainSupervisorResult> {
  const input=TransitionInput.safeParse(raw);
  if(!input.success)return {kind:'refused',reason:'invalid_input'};
  try {
    if(!await journal.fault('before_supervisor_transition_append',signal))return uncertain;
    const result=await journal.locked<RetainSupervisorResult>(signal,uncertain,async(state,lock)=>{
      if(!owns(state,owner))return {kind:'refused',reason:'stale_owner'};
      const record={...input.data,epoch:owner.epoch.toString()};
      if(foldSupervisor([...state.records,record]).kind!=='valid')return {kind:'refused',reason:'invalid_transition'};
      return await journal.append(state,lock,record,signal)?{kind:'retained'}:uncertain;
    });
    return result.kind==='retained'&&!await journal.fault('after_supervisor_transition_append',signal)?uncertain:result;
  } catch {return uncertain;}
}
