import { it, expect } from 'vitest';
import { ResultAsync, errAsync, okAsync } from 'neverthrow';
import { ExecutionSessionGateV2 } from '../../../src/v2/usecases/execution-session-gate.js';
import { asSessionId } from '../../../src/v2/durable-core/ids/index.js';
import type { SessionLockPortV2 } from '../../../src/v2/ports/session-lock.port.js';
import type { SessionEventLogReadonlyStorePortV2 } from '../../../src/v2/ports/session-event-log-store.port.js';
const latch = () => { let release!:()=>void; const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release:()=>release()}; };
const store: SessionEventLogReadonlyStorePortV2 = {
  loadValidatedPrefix: () => okAsync({ truth: { manifest: [], events: [] }, isComplete: true, tailReason: null }),
  load: () => okAsync({ manifest: [], events: [] }),
};
const lock = ():SessionLockPortV2 => ({ acquire: sessionId=>okAsync({kind:'v2_session_lock_handle',sessionId}),release:()=>okAsync(undefined) });
it('independent sessions run concurrently but nested opposite-order acquisition refuses instead of deadlocking', async()=>{
  const a=asSessionId('sess_a'), b=asSessionId('sess_b');
  const aEntered=latch(), bEntered=latch(), release=latch();
  const gate=new ExecutionSessionGateV2(lock(),store);
  const first=gate.withHealthySessionLock(a,()=>ResultAsync.fromSafePromise((async()=>{
    aEntered.release();await bEntered.promise;
    const nested=await gate.withHealthySessionLock(b,()=>okAsync('unexpected'));
    expect(nested.isErr()).toBe(true);
    if(nested.isErr())expect(nested.error.code).toBe('SESSION_LOCKED');
    release.release();return 'a';
  })()));
  await aEntered.promise;
  const second=gate.withHealthySessionLock(b,()=>ResultAsync.fromSafePromise((async()=>{
    bEntered.release();await release.promise;return 'b';
  })()));
  expect((await first)._unsafeUnwrap()).toBe('a');
  expect((await second)._unsafeUnwrap()).toBe('b');
});
it('detached asynchronous descendants can enter after the original witness is revoked',async()=>{
  const sid=asSessionId('sess_detached'), start=latch();
  const gate=new ExecutionSessionGateV2(lock(),store);
  let child!:Promise<unknown>;
  const first=await gate.withHealthySessionLock(sid,()=>{
    child=start.promise.then(async()=>gate.withHealthySessionLock(sid,()=>okAsync('new')));
    return okAsync('old');
  });
  expect(first.isOk()).toBe(true);start.release();
  expect(await child).toMatchObject({value:'new'});
});
it.each(['load','callback','release'] as const)('releases exactly once after %s failure and revokes witnesses',async failure=>{
  const sid=asSessionId('sess_failure');let releases=0;let witness:(()=>boolean)|undefined;
  const gate=new ExecutionSessionGateV2({
    acquire:sessionId=>okAsync({kind:'v2_session_lock_handle',sessionId}),
    release:()=>{releases++;return failure==='release'?errAsync({code:'SESSION_LOCK_IO_ERROR',message:'release failure',lockPath:'test'}):okAsync(undefined);},
  }, failure==='load'?{...store,load:()=>errAsync({code:'SESSION_STORE_CORRUPTION_DETECTED',location:'tail',reason:{code:'missing_attested_segment',message:'missing'},message:'missing'})}:store);
  const result=await gate.withHealthySessionLock(sid,held=>{
    witness=()=>held.assertHeld();
    if(failure==='callback')throw Error('callback failure');
    return okAsync('ok');
  });
  expect(result.isErr()).toBe(true);expect(releases).toBe(1);
  if(witness)expect(witness()).toBe(false);
});

it('revokes the callback witness before asynchronous physical release completes', async () => {
  const releasing = latch(), finishRelease = latch();
  let witness: (() => boolean) | undefined;
  const gate = new ExecutionSessionGateV2({
    acquire: sessionId => okAsync({ kind: 'v2_session_lock_handle', sessionId }),
    release: () => ResultAsync.fromSafePromise((async () => {
      releasing.release();
      await finishRelease.promise;
    })()),
  }, store);
  const operation = gate.withHealthySessionLock(asSessionId('sess_release_window'), held => {
    witness = () => held.assertHeld();
    expect(witness()).toBe(true);
    return okAsync('completed');
  });
  await releasing.promise;
  try { expect(witness?.()).toBe(false); }
  finally { finishRelease.release(); await operation; }
});
