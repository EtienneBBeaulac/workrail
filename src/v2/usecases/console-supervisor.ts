import type { DomainEventV1 } from '../durable-core/schemas/session/index.js';
import { foldSupervisor } from '../durable-core/projections/supervisor-state.js';
import type { ConsoleSupervisorStatus } from './console-types.js';

/** Read-only and per run. Never leak environment identity or turn historical state into
 * a claim of liveness. Missing history stays absent instead of looking successfully stopped. */
export function projectConsoleSupervisor(events:readonly DomainEventV1[], runId:string):ConsoleSupervisorStatus|undefined {
  const records=events.filter((event):event is Extract<DomainEventV1,{kind:'answer_host_recorded'}>=>
    event.kind==='answer_host_recorded'&&event.scope.runId===runId)
    .sort((a,b)=>a.eventIndex-b.eventIndex).map(event=>event.data);
  const projection=foldSupervisor(records);
  if(projection.kind==='invalid')return {kind:'invalid_history'};
  const state=projection.state;
  switch(state.kind) {
    case 'absent':return undefined;
    case 'unconfirmed':return {kind:'unconfirmed',operation:state.outcome.operation,reason:state.outcome.reason};
    case 'create_pending':case 'created':case 'start_pending':case 'running':case 'stop_pending':case 'process_stopped':
      return {kind:'recorded',phase:state.kind};
  }
  const unreachable:never=state;
  return unreachable;
}
