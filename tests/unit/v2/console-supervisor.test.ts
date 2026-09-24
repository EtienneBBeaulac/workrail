import {expect,it} from 'vitest';
import {projectConsoleSupervisor} from '../../../src/v2/usecases/console-supervisor.js';
import type {DomainEventV1} from '../../../src/v2/durable-core/schemas/session/index.js';
import type {AnswerHostRecord} from '../../../src/v2/durable-core/schemas/session/answer-host.js';
const records:AnswerHostRecord[]=[{kind:'owner_acquired',epoch:'1'},
  {kind:'supervisor_create_intended',epoch:'1',supervisor:'private-id',configurationDigest:'a'.repeat(64)},
  {kind:'supervisor_created',epoch:'1',supervisor:'private-id',binding:{daemon:'private-daemon',environment:'private-environment'}}];
function events(data:readonly AnswerHostRecord[],runId='run1',offset=0):DomainEventV1[] {
  return data.map((record,i)=>({v:1,kind:'answer_host_recorded',sessionId:'sess_test',scope:{runId},eventId:`evt_${runId}_${i}`,
    eventIndex:i+offset,timestampMs:0,dedupeKey:`${runId}_${i}`,data:record}));
}
it('does not invent observations for legacy runs or mix concurrent runs',()=>{
  expect(projectConsoleSupervisor(events(records),'other')).toBeUndefined();
  expect(projectConsoleSupervisor(events([records[0]!]),'run1')).toBeUndefined();
  expect(projectConsoleSupervisor([...events(records),...events(records,'other',records.length)],'run1')).toEqual({kind:'recorded',phase:'created'});
});
it('projects pending and uncertain state without leaking binding or implying completion',()=>{
  expect(projectConsoleSupervisor(events(records.slice(0,2)),'run1')).toEqual({kind:'recorded',phase:'create_pending'});
  const status=projectConsoleSupervisor(events([...records.slice(0,2),{kind:'supervisor_unconfirmed',supervisor:'private-id',epoch:'1',operation:'create',reason:'ack_unknown'}]),'run1');
  expect(status).toEqual({kind:'unconfirmed',operation:'create',reason:'ack_unknown'});
  expect(JSON.stringify(status)).not.toContain('private');
});
it('distinguishes process exit history from execution completion or lease release',()=>{
  const binding={daemon:'private-daemon',environment:'private-environment'};
  expect(projectConsoleSupervisor(events([...records,{kind:'supervisor_stop_intended',supervisor:'private-id',epoch:'1',binding},
    {kind:'supervisor_process_stopped',supervisor:'private-id',epoch:'1',binding}]),'run1')).toEqual({kind:'recorded',phase:'process_stopped'});
});
it('surfaces contradictory history without hiding it as absent or healthy',()=>{
  expect(projectConsoleSupervisor(events([...records,records[1]!]),'run1')).toEqual({kind:'invalid_history'});
});

it('derives canonical order without mutating caller event order',()=>{
  const reversed=events(records).reverse(),before=JSON.stringify(reversed);
  expect(projectConsoleSupervisor(reversed,'run1')).toEqual({kind:'recorded',phase:'created'});
  expect(JSON.stringify(reversed)).toBe(before);
});

it('shows cleanup fencing separately from resource history and never exposes authority', () => {
  const retained = records.map(record => record.kind === 'supervisor_create_intended'
    ? { ...record, daemon: 'private-daemon' } : record);
  const status = projectConsoleSupervisor(events([...retained,
    { kind: 'cleanup_claimed', epoch: '2', previousEpoch: '1', supervisor: 'private-id' }]), 'run1');
  expect(status).toEqual({ kind: 'cleanup_fenced', resource: { kind: 'recorded', phase: 'created' } });
  expect(JSON.stringify(status)).not.toMatch(/private|epoch|lease|receipt/);
  expect(projectConsoleSupervisor(events([...retained,
    { kind: 'cleanup_claimed', epoch: '1', previousEpoch: '1', supervisor: 'private-id' }]), 'run1'))
    .toEqual({ kind: 'invalid_history' });
});
