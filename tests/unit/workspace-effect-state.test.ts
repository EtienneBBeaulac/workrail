import { describe, it, expect } from 'vitest';
import { AnswerHostRecordSchema, type AnswerHostRecord } from '../../src/v2/durable-core/schemas/session/answer-host.js';
import { WorkspaceEffectIntentSchema } from '../../src/v2/durable-core/schemas/session/workspace-effect.js';
import { foldWorkspaceEffects } from '../../src/answer-v1/workspace-effect-state.js';

const scope: AnswerHostRecord[] = [
  { kind: 'owner_acquired', epoch: '1' },
  { kind: 'delivered', delivery: 'd1', node: 'n1', reply: 'r1', epoch: '1' },
  { kind: 'model_call_reserved', call: 'm1', delivery: 'd1', epoch: '1', ordinal: 1 },
];
const intent = WorkspaceEffectIntentSchema.parse({ kind: 'workspace_effect_intended', effect: 'e1', delivery: 'd1',
  epoch: '1', modelCall: 'm1', toolCallId: 't1', position: 0, operation: 'Bash', inputDigest: 'a'.repeat(64) });
const completion: AnswerHostRecord = { kind: 'workspace_effect_completed', effect: 'e1', epoch: '1', result: { content: 'done', isError: false } };
const unknown: AnswerHostRecord = { kind: 'workspace_effect_unconfirmed', effect: 'e1', epoch: '1', reason: 'execution_failed' };
const next = AnswerHostRecordSchema.parse({ ...intent, effect: 'e2', toolCallId: 't2', position: 1 });

function invalid(records: AnswerHostRecord[], reason: string) {
  expect(foldWorkspaceEffects(records)).toMatchObject({ kind: 'invalid', reason });
}
describe('workspace effect canonical projection', () => {
  it('retains a pending intent on restart and never infers a result', () => {
    expect(foldWorkspaceEffects([...scope, intent])).toEqual({kind:'valid', effects:[{kind:'pending', intent}]});
    invalid([...scope, intent, next], 'unresolved_effect');
  });
  it('retains completed results, including error feedback without claiming rollback', () => {
    for (const isError of [true, false]) {
      const result = { ...completion, result: {content:'bounded result', isError} } as AnswerHostRecord;
      expect(foldWorkspaceEffects([...scope, intent, result, next])).toMatchObject({kind:'valid', effects:[{kind:'completed'}, {kind:'pending'}]});
    }
  });
  it('does not permit later work or completion after an explicitly unknown outcome', () => {
    expect(foldWorkspaceEffects([...scope, intent, unknown])).toMatchObject({kind:'valid', effects:[{kind:'unconfirmed'}]});
    invalid([...scope, intent, unknown, next], 'unresolved_effect');
    invalid([...scope, intent, unknown, completion], 'invalid_completion');
  });
  it.each(['effect', 'toolCallId', 'position'] as const)('rejects repeated %s even after completion', field => {
    invalid([...scope, intent, completion, AnswerHostRecordSchema.parse({...next, [field]: intent[field]})], 'duplicate_identity');
  });
  it.each([
    {epoch:'2'}, {delivery:'other'}, {modelCall:'other'},
  ])('rejects mismatched owner/delivery/provider reservation %j', change => {
    invalid([...scope, AnswerHostRecordSchema.parse({...intent, ...change})], 'invalid_scope');
  });
  it('requires preceding authority and refuses effects after capture or stop', () => {
    invalid([intent], 'invalid_scope');
    invalid([...scope, {kind:'captured', delivery:'d1',response:'r',payload:{responseText:'',calls:[]}},intent], 'invalid_scope');
    invalid([...scope, {kind:'stopped',reason:'cancelled',detail:''},intent], 'invalid_scope');
  });
  it('rejects missing, duplicate and stale completion', () => {
    invalid([...scope, completion], 'invalid_completion');
    invalid([...scope, intent, completion, completion], 'invalid_completion');
    invalid([...scope, intent, {kind:'owner_released',epoch:'1'}, completion], 'invalid_completion');
    invalid([...scope, intent, {kind:'model_call_reserved',call:'m2',delivery:'d1',epoch:'1',ordinal:2}, completion], 'invalid_completion');
  });
  it('preserves uncertainty across owner changes and never grants a fresh attempt', () => {
    const newScope: AnswerHostRecord[] = [ {kind:'owner_acquired',epoch:'2'},
      {kind:'delivered',delivery:'d2',epoch:'2',reply:'r2',node:'n1'},
      {kind:'model_call_reserved',call:'m2',delivery:'d2',epoch:'2',ordinal:2} ];
    expect(foldWorkspaceEffects([...scope,intent,...newScope])).toMatchObject({kind:'valid',effects:[{kind:'pending'}]});
    invalid([...scope,intent,...newScope,AnswerHostRecordSchema.parse({...next,epoch:'2',delivery:'d2',modelCall:'m2'})], 'unresolved_effect');
  });
  it('rejects unbounded or ambiguous boundary records', () => {
    for (const change of [{inputDigest:'bad'}, {operation:'safe-shell'}, {position:-1}, {toolCallId:''}, {extra:1}])
      expect(AnswerHostRecordSchema.safeParse({...intent,...change}).success).toBe(false);
    expect(AnswerHostRecordSchema.safeParse({...completion,result:{content:'x'.repeat(65537),isError:false}}).success).toBe(false);
  });
  it('folds round-tripped canonical records without mutating input', () => {
    const records = [ ...scope, intent, completion ];
    const before = JSON.stringify(records);
    expect(foldWorkspaceEffects(JSON.parse(before).map((r:unknown)=>AnswerHostRecordSchema.parse(r))))
      .toEqual(foldWorkspaceEffects(records));
    expect(JSON.stringify(records)).toBe(before);
  });
});
