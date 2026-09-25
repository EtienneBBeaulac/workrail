/** Compile-only boundaries; these do not authenticate runtime callers. */
import type { GateCorrectionAuthorityRef, GateCorrectionOutput, GateCorrectionResult, TrustedGateCorrectorPort, InspectCorrectionResult, KnownGateArtifact } from '../../src/v2/ports/trusted-gate-correction.port.js';
import type { GateAuthorityRef, GateSubject } from '../../src/v2/ports/trusted-gate-resolver.port.js';
declare const port: TrustedGateCorrectorPort;
declare const correctionAuthority: GateCorrectionAuthorityRef;
declare const evaluationAuthority: GateAuthorityRef;
declare const subject: GateSubject;
declare const signal: AbortSignal;
declare const artifact: KnownGateArtifact;
const notes: GateCorrectionOutput = { kind: 'notes', notesMarkdown: 'Corrected work' };
const structured: GateCorrectionOutput = { kind: 'artifacts', artifacts: [artifact] };
void port.submitCorrection(correctionAuthority, subject, notes, signal);
void port.submitCorrection(correctionAuthority, subject, structured, signal);
// @ts-expect-error Evaluation permission does not grant correction permission.
void port.submitCorrection(evaluationAuthority, subject, notes, signal);
// @ts-expect-error Raw strings cannot construct correction authority.
void port.submitCorrection('invented', subject, notes, signal);
// @ts-expect-error Structured corrections cannot contain zero artifacts.
const empty: GateCorrectionOutput = { kind: 'artifacts', artifacts: [] };
const wider = { kind: 'notes' as const, notesMarkdown: 'Work', context: { is_autonomous: false } };
// @ts-expect-error Even wider objects cannot inject gate-bypassing context.
const injected: GateCorrectionOutput = wider;
// @ts-expect-error Caller-controlled revision is not an output field.
const revision: GateCorrectionOutput = { kind: 'notes', notesMarkdown: 'Work', revision: 'chosen' };
declare const accepted: Extract<GateCorrectionResult, { kind: 'accepted' }>;
const withAdvance = { ...accepted, continueToken: 'advance' };
// @ts-expect-error Correction cannot yield continuation authority through a wider value.
const premature: GateCorrectionResult = withAdvance;
declare const inspection: InspectCorrectionResult;
if (inspection.kind === 'eligible') {
  const issued: GateCorrectionAuthorityRef = inspection.authority;
} else {
  // @ts-expect-error Ineligible or cancelled inspection never issues authority.
  const denied: GateCorrectionAuthorityRef = inspection.authority;
}
