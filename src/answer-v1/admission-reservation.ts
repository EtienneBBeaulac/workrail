import { z } from 'zod';
import { decodeDaemonExecutionPolicy } from './daemon-policy.js';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { DomainEventV1Schema, type DomainEventV1 } from '../v2/durable-core/schemas/session/index.js';
import { AnswerHostRequestSchema } from '../v2/durable-core/schemas/session/answer-host.js';
import { admissionFileName, MAX_ADMISSION_BYTES } from './immutable-admission-file.js';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const requestSchema = AnswerHostRequestSchema.refine(request => isAbsolute(request.workspacePath));
const envelope = z.object({
  formatVersion: z.union([z.literal(1), z.literal(2)]),
  operationId: z.string().refine(value => admissionFileName(value) !== undefined),
  request: requestSchema,
  sessionId: z.string().regex(/^sess_[a-z0-9]+$/),
  runId: z.string().regex(/^run_[a-z0-9]+$/),
  nodeId: z.string().regex(/^node_[a-z0-9]+$/),
  workflowHash: digest,
  recovery: z.string().regex(/^evt_[a-z0-9]+$/),
  mode: z.literal('host_bound'),
  plan: z.object({
    events: z.array(DomainEventV1Schema).min(6).max(64),
    snapshotPins: z.array(z.object({ snapshotRef: digest, eventIndex: z.literal(2), createdByEventId: z.string().min(1) }).strict()).length(1),
  }).strict(),
}).strict();

type ReadonlyTree<T> = T extends string | number | boolean | null | undefined ? T : T extends readonly (infer Item)[] ? readonly ReadonlyTree<Item>[]
  : T extends object ? { readonly [Key in keyof T]: ReadonlyTree<T[Key]> } : T;
const reservationBrand = Symbol('validated-admission-structure');
/** Validated structure and relationships only. Content-store verification is a separate
 * capability required before any append; this value alone cannot authorize execution. */
export type AdmissionReservation = ReadonlyTree<z.infer<typeof envelope>> & { readonly [reservationBrand]: true };
export type DecodeReservationResult =
  | Readonly<{ kind: 'validated'; reservation: AdmissionReservation }>
  | Readonly<{ kind: 'refused'; reason: 'corrupt_reservation' | 'unsupported_version' | 'operation_conflict' | 'request_conflict' }>;

function freezeTree(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
}

function coherent(value: z.infer<typeof envelope>): boolean {
  if (value.formatVersion !== (value.request.daemonPolicy ? 2 : 1)) return false;
  if (value.request.daemonPolicy && decodeDaemonExecutionPolicy(value.request.daemonPolicy).kind !== 'validated') return false;
  const { events, snapshotPins } = value.plan;
  const [session, run, node, preferences, context] = events;
  const enrollment = events.at(-1);
  if (session?.kind !== 'session_created' || run?.kind !== 'run_started' || node?.kind !== 'node_created'
      || preferences?.kind !== 'preferences_changed' || context?.kind !== 'context_set'
      || enrollment?.kind !== 'answer_host_recorded' || enrollment.data.kind !== 'enrolled') return false;
  if (session.scope !== undefined || Object.keys(session.data).length !== 0
      || run.scope.runId !== value.runId || run.data.workflowId !== value.request.workflowId
      || run.data.workflowHash !== value.workflowHash || run.data.triggerSource !== 'daemon'
      || node.scope.runId !== value.runId || node.scope.nodeId !== value.nodeId
      || node.data.workflowHash !== value.workflowHash || node.data.parentNodeId !== null || node.data.nodeKind !== 'step'
      || preferences.scope.runId !== value.runId || preferences.scope.nodeId !== value.nodeId
      || preferences.data.source !== 'system' || context.scope.runId !== value.runId || context.data.source !== 'initial'
      || enrollment.scope.runId !== value.runId || enrollment.data.mode !== value.mode
      || enrollment.data.recovery !== value.recovery || enrollment.data.initialNode !== value.nodeId
      || !isDeepStrictEqual(enrollment.data.request, value.request)) return false;
  // New host reservations carry only initial goal/provenance, never EAT or continuation tokens.
  const initialContext = z.object({ goal: z.string(), triggerSource: z.literal('daemon'),
    metrics_harness: z.string().optional(), metrics_active_model: z.string().optional() }).strict().safeParse(context.data.context);
  if (!initialContext.success || initialContext.data.goal !== value.request.goal) return false;
  const pin = snapshotPins[0]!;
  if (pin.snapshotRef !== node.data.snapshotRef || pin.createdByEventId !== node.eventId) return false;
  if (events.slice(5, -1).some(event => event.kind !== 'observation_recorded')) return false;
  if (new Set(events.map(event => event.eventId)).size !== events.length
      || new Set(events.map(event => event.dedupeKey)).size !== events.length) return false;
  return events.every((event, index) => event.sessionId === value.sessionId && event.eventIndex === index);
}

/** Bytes are bounded before parsing. Unknown event fields are refused, even though the
 * general journal schema strips them for backward compatibility. No silent rewriting. */
export function decodeAdmissionReservation(
  bytes: Uint8Array,
  expected: Readonly<{ operationId: string; request: z.infer<typeof AnswerHostRequestSchema> }>,
): DecodeReservationResult {
  try {
    if (bytes.length === 0 || bytes.length > MAX_ADMISSION_BYTES) return { kind: 'refused', reason: 'corrupt_reservation' };
    const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const version = z.object({ formatVersion: z.number().int() }).safeParse(raw);
    if (version.success && ![1, 2].includes(version.data.formatVersion)) return { kind: 'refused', reason: 'unsupported_version' };
    const parsed = envelope.safeParse(raw);
    if (!parsed.success || !isDeepStrictEqual(raw, parsed.data) || !coherent(parsed.data))
      return { kind: 'refused', reason: 'corrupt_reservation' };
    if (parsed.data.operationId !== expected.operationId) return { kind: 'refused', reason: 'operation_conflict' };
    if (!isDeepStrictEqual(parsed.data.request, expected.request)) return { kind: 'refused', reason: 'request_conflict' };
    const reservation = { ...parsed.data, [reservationBrand]: true as const };
    freezeTree(reservation);
    return { kind: 'validated', reservation };
  } catch { return { kind: 'refused', reason: 'corrupt_reservation' }; }
}

/** Caller supplies healthy canonical truth loaded under its session lock. Valid later
 * events are allowed; dedupe keys alone are never evidence of matching admission. */
export function matchesAdmissionPrefix(reservation: AdmissionReservation, events: readonly DomainEventV1[]): boolean {
  return events.length >= reservation.plan.events.length
    && reservation.plan.events.every((event, index) => isDeepStrictEqual(event, events[index]));
}
