import { describe, expect, it } from 'vitest';
import { AnswerHostRecordSchema, type AnswerHostRecord } from '../../src/v2/durable-core/schemas/session/answer-host.js';
import { foldSupervisor } from '../../src/answer-v1/supervisor-state.js';
const binding = { daemon: 'd', environment: 'exact' };
const owner: AnswerHostRecord = { kind: 'owner_acquired', epoch: '1' };
const intent: AnswerHostRecord = { kind: 'supervisor_create_intended', supervisor: 's', epoch: '1', configurationDigest: 'a'.repeat(64) };
const phases = ['supervisor_created','supervisor_start_intended','supervisor_started','supervisor_stop_intended','supervisor_process_stopped'] as const;
const steps: AnswerHostRecord[] = phases.map(kind => ({ kind, supervisor: 's', epoch: '1', binding }));
const history: AnswerHostRecord[] = [owner, intent, ...steps];
const stop: AnswerHostRecord = {kind:'stopped',reason:'cancelled',detail:''};
const invalid = (records: readonly AnswerHostRecord[], reason: string) => expect(foldSupervisor(records)).toMatchObject({kind:'invalid',reason});
describe('canonical supervisor history', () => {
  it('replays each phase without inventing completion or execution authority', () => {
    const expected = ['absent','create_pending','created','start_pending','running','stop_pending','process_stopped'];
    expected.forEach((kind,i) => expect(foldSupervisor(history.slice(0,i+1))).toMatchObject({kind:'valid',state:{kind}}));
    expect(foldSupervisor([])).toEqual({kind:'valid',state:{kind:'absent'}});
  });
  it.each([2,3,4,5,6,7])('refuses a second create at prefix %i', end => {
    invalid([...history.slice(0,end),{...intent,supervisor:'replacement'}],'duplicate_intent');
  });
  it.each(phases)('requires the predecessor for %s', kind => {
    const step = steps.find(r=>r.kind===kind)!;
    invalid([owner,step],'invalid_transition');
    const index=history.indexOf(step);
    invalid([...history.slice(0,index+1),step],'invalid_transition');
  });
  it.each(['daemon','environment','supervisor'] as const)('rejects substituted %s', field => {
    const bad = AnswerHostRecordSchema.parse(field==='supervisor' ? {...steps[1],supervisor:'other'} : {...steps[1],binding:{...binding,[field]:'other'}});
    invalid([...history.slice(0,3),bad],'identity_mismatch');
  });
  it('requires the original active owner for every lifecycle event', () => {
    invalid([intent],'invalid_scope');
    for(let i=2;i<history.length;i++) {
      invalid([...history.slice(0,i),{kind:'owner_released',epoch:'1'},history[i]!],'invalid_scope');
      invalid([...history.slice(0,i),{kind:'owner_acquired',epoch:'2'},AnswerHostRecordSchema.parse({...history[i],epoch:'2'})],'invalid_scope');
      invalid([...history.slice(0,i),AnswerHostRecordSchema.parse({...history[i],epoch:'2'})],'invalid_scope');
    }
  });
  it.each(['ack_unknown','backend_refused'] as const)('retains %s without reopening a pending operation', reason => {
    for(const [operation,end] of [['create',2],['start',4],['stop',6]] as const) {
      const uncertain: AnswerHostRecord={kind:'supervisor_unconfirmed',supervisor:'s',epoch:'1',operation,reason};
      const records=[...history.slice(0,end),uncertain];
      expect(foldSupervisor(records)).toMatchObject({kind:'valid',state:{kind:'unconfirmed',outcome:uncertain}});
      invalid([...records,history[end]!],'invalid_transition');
      invalid([...records,intent],'duplicate_intent');
    }
  });
  it('rejects uncertainty for the wrong operation',()=>invalid([...history.slice(0,2),{kind:'supervisor_unconfirmed',supervisor:'s',epoch:'1',operation:'stop',reason:'ack_unknown'}],'invalid_transition'));
  it('blocks new work after host stop but retains issued acknowledgments and cleanup', () => {
    invalid([owner,stop,intent],'invalid_scope');
    invalid([...history.slice(0,3),stop,steps[1]!],'invalid_scope');
    expect(foldSupervisor([...history.slice(0,4),stop,...history.slice(4)])).toMatchObject({kind:'valid',state:{kind:'process_stopped'}});
    expect(foldSupervisor([...history.slice(0,3),stop,steps[3]!,steps[4]!])).toMatchObject({kind:'valid',state:{kind:'process_stopped'}});
  });
  it('validates closed, bounded wire fields and round-trips without mutating input', () => {
    for(const change of [{epoch:'0'},{supervisor:''},{configurationDigest:'x'},{extra:true}])
      expect(AnswerHostRecordSchema.safeParse({...intent,...change}).success).toBe(false);
    expect(AnswerHostRecordSchema.safeParse({...steps[0],binding:{...binding,environment:'x'.repeat(257)}}).success).toBe(false);
    expect(AnswerHostRecordSchema.safeParse({kind:'supervisor_unconfirmed',supervisor:'s',epoch:'1',operation:'start',reason:'ack_unknown',binding:{daemon:'other',environment:'other'}}).success).toBe(false);
    const wire=JSON.stringify(history);
    expect(foldSupervisor(JSON.parse(wire).map((x:unknown)=>AnswerHostRecordSchema.parse(x)))).toEqual(foldSupervisor(history));
    expect(JSON.stringify(history)).toBe(wire);
    expect(foldSupervisor(history)).not.toHaveProperty('lease');
  });
});
