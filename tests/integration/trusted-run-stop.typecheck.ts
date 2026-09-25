/** Compile-only capability and scope checks, not runtime authentication. */
import type { RunStopAuthorityRef, RunSubject, RunStopResult, TrustedRunStopperPort, InspectRunStopResult } from '../../src/v2/ports/trusted-run-stop.port.js';
import type { GateAuthorityRef, GateSubject } from '../../src/v2/ports/trusted-gate-resolver.port.js';
import type { GateCorrectionAuthorityRef } from '../../src/v2/ports/trusted-gate-correction.port.js';
declare const port: TrustedRunStopperPort;
declare const authority: RunStopAuthorityRef;
declare const evaluator: GateAuthorityRef;
declare const corrector: GateCorrectionAuthorityRef;
declare const gate: GateSubject;
declare const signal: AbortSignal;
const run: RunSubject = { sessionId: gate.sessionId, runId: gate.runId };
void port.stop(authority, run, 'Supervisor cancelled this run', signal);
// @ts-expect-error Evaluation authority does not grant stopping authority.
void port.stop(evaluator, run, 'Stop', signal);
// @ts-expect-error Correction authority does not grant stopping authority.
void port.stop(corrector, run, 'Stop', signal);
// @ts-expect-error Raw strings cannot manufacture stopping authority.
void port.stop('invented', run, 'Stop', signal);
// @ts-expect-error A revision-bound gate subject is not the run scope contract.
const revisionScoped: RunSubject = gate;
declare const stopped: Extract<RunStopResult, { kind: 'stopped' }>;
const wider = { ...stopped, continueToken: 'continue' };
// @ts-expect-error Stop confirmation cannot carry forward execution authority.
const wrong: RunStopResult = wider;
declare const inspection: InspectRunStopResult;
if (inspection.kind === 'eligible') {
  const issued: RunStopAuthorityRef = inspection.authority;
} else {
  // @ts-expect-error A terminal/refused inspection cannot issue authority.
  const denied: RunStopAuthorityRef = inspection.authority;
}
