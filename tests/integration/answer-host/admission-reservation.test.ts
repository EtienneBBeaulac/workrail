import { beforeAll, afterAll, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { composeAnswerEngine } from '../../../src/answer-v1/engine-composition.js';
import { prepareStartWorkflow } from '../../../src/v2/usecases/start-workflow.js';
import { createWorkflow } from '../../../src/types/workflow.js';
import { createUserDirectorySource } from '../../../src/types/workflow-source.js';
import { decodeAdmissionReservation, matchesAdmissionPrefix } from '../../../src/answer-v1/admission-reservation.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

let root: string;
let serialized: string;
let expected: { operationId: string; request: { workflowId: string; goal: string; workspacePath: string } };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'reservation-schema-'));
  const config = { storage: { journalRootDir: join(root, 'sessions'), hostIndexRootDir: join(root, 'index') },
    keyringPath: join(root, 'keys', 'keyring.json'), workflowStoragePath: join(root, 'workflows') };
  const engine = await composeAnswerEngine(config);
  if (engine.kind !== 'ready') throw new Error(engine.kind);
  const workflow = createWorkflow({ id: 'reserved', name: 'Reserved', description: 'Admission fixture', version: '1.0.0',
    steps: [{ id: 'first', title: 'First', prompt: 'Original' }] }, createUserDirectorySource(config.workflowStoragePath));
  expected = { operationId: randomUUID(), request: { workflowId: 'reserved', goal: 'original goal', workspacePath: root } };
  const result = await prepareStartWorkflow({ ...engine, fallbackWorkflowReader: { getWorkflowById: async () => workflow } },
    { ...expected.request, injectOnboarding: false }, { triggerSource: 'daemon' });
  if (result.isErr()) throw new Error(result.error.kind);
  const prepared = result.value;
  const events = prepared.appendPlan.events.map(event => event.kind === 'context_set'
    ? { ...event, data: { ...event.data, context: { goal: expected.request.goal, triggerSource: 'daemon' } } } : event);
  const recovery = engine.idFactory.mintEventId();
  events.push({ v: 1, eventId: engine.idFactory.mintEventId(), eventIndex: events.length, sessionId: prepared.sessionId,
    timestampMs: Date.now(), kind: 'answer_host_recorded', scope: { runId: prepared.runId },
    dedupeKey: `answer_host:${prepared.sessionId}:${events.length}`,
    data: { kind: 'enrolled', mode: 'host_bound', recovery, initialNode: prepared.nodeId, request: expected.request } });
  serialized = JSON.stringify({ formatVersion: 1, operationId: expected.operationId, request: expected.request,
    sessionId: prepared.sessionId, runId: prepared.runId, nodeId: prepared.nodeId, workflowHash: prepared.workflowHash,
    recovery, mode: 'host_bound', plan: { events, snapshotPins: prepared.appendPlan.snapshotPins } });
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it('validates real prepared identity, freezes nested data and matches only the exact initial prefix', () => {
  const result = decodeAdmissionReservation(Buffer.from(serialized), expected);
  expect(result.kind).toBe('validated');
  if (result.kind !== 'validated') throw new Error('fixture refused');
  expect(Object.isFrozen(result.reservation.plan.events[2]!.data)).toBe(true);
  const raw = JSON.parse(serialized);
  const initial = raw.plan.events as DomainEventV1[];
  expect(matchesAdmissionPrefix(result.reservation, initial)).toBe(true);
  const enrolled = initial.at(-1)!;
  const later: DomainEventV1 = { ...enrolled, kind: 'answer_host_recorded', scope: { runId: raw.runId },
    eventIndex: initial.length, eventId: 'evt_later', dedupeKey: `answer_host:${raw.sessionId}:${initial.length}`,
    data: { kind: 'owner_acquired', epoch: '1' } };
  expect(matchesAdmissionPrefix(result.reservation, [...initial, later])).toBe(true);
  expect(matchesAdmissionPrefix(result.reservation, initial.slice(1))).toBe(false);
  const changed = initial.map((event, index) => index === 0 ? { ...event, timestampMs: event.timestampMs + 1 } : event);
  expect(matchesAdmissionPrefix(result.reservation, changed)).toBe(false);
});

it('distinguishes operation, request and version refusals', () => {
  expect(decodeAdmissionReservation(Buffer.from(serialized), { ...expected, operationId: randomUUID() }))
    .toEqual({ kind: 'refused', reason: 'operation_conflict' });
  expect(decodeAdmissionReservation(Buffer.from(serialized), { ...expected, request: { ...expected.request, goal: 'changed' } }))
    .toEqual({ kind: 'refused', reason: 'request_conflict' });
  const future = JSON.parse(serialized); future.formatVersion = 2;
  expect(decodeAdmissionReservation(Buffer.from(JSON.stringify(future)), expected))
    .toEqual({ kind: 'refused', reason: 'unsupported_version' });
});

it.each(['unknown', 'eventUnknown', 'session', 'run', 'node', 'runIdentity', 'nodeIdentity', 'runScope', 'contextScope', 'enrollmentScope', 'hash', 'index', 'duplicate', 'pin', 'owner', 'goal', 'token', 'request', 'mode'])
('refuses inconsistent or extended reservation: %s', mutation => {
  const raw = JSON.parse(serialized);
  switch (mutation) {
    case 'unknown': raw.owner = 'forged'; break;
    case 'eventUnknown': raw.plan.events[0].surprise = true; break;
    case 'session': raw.plan.events[1].sessionId = 'sess_other'; break;
    case 'run': raw.plan.events[2].scope.runId = 'run_other'; break;
    case 'node': raw.plan.events[3].scope.nodeId = 'node_other'; break;
    case 'runIdentity': raw.plan.events[1].scope.runId = 'run_other'; break;
    case 'nodeIdentity': raw.plan.events[2].scope.nodeId = 'node_other'; break;
    case 'runScope': raw.plan.events[1].scope.nodeId = raw.nodeId; break;
    case 'contextScope': raw.plan.events[4].scope.nodeId = raw.nodeId; break;
    case 'enrollmentScope': raw.plan.events.at(-1).scope.nodeId = raw.nodeId; break;
    case 'hash': raw.plan.events[2].data.workflowHash = 'sha256:' + '0'.repeat(64); break;
    case 'index': raw.plan.events[1].eventIndex = 50; break;
    case 'duplicate': raw.plan.events[1].eventId = raw.plan.events[0].eventId; break;
    case 'pin': raw.plan.snapshotPins[0].createdByEventId = 'evt_other'; break;
    case 'owner': raw.plan.events.at(-1).data = { kind: 'owner_acquired', epoch: '1' }; break;
    case 'goal': raw.plan.events[4].data.context.goal = 'changed'; break;
    case 'token': raw.plan.events[4].data.context.eat_token = 'forged'; break;
    case 'request': raw.plan.events.at(-1).data.request.workspacePath = '/other'; break;
    case 'mode': raw.mode = 'unbound'; break;
  }
  expect(decodeAdmissionReservation(Buffer.from(JSON.stringify(raw)), expected))
    .toEqual({ kind: 'refused', reason: 'corrupt_reservation' });
});

it('refuses malformed JSON and invalid UTF-8 without throwing', () => {
  expect(decodeAdmissionReservation(Buffer.from('{'), expected).kind).toBe('refused');
  expect(decodeAdmissionReservation(Uint8Array.of(0xff), expected).kind).toBe('refused');
});

it('accepts schema-valid observations and rejects scoped or arbitrary observation payloads', () => {
  const raw = JSON.parse(serialized);
  const observation = { v: 1, eventId: 'evt_observation', eventIndex: 5, sessionId: raw.sessionId,
    timestampMs: 1, kind: 'observation_recorded',
    dedupeKey: `observation_recorded:${raw.sessionId}:git_branch`,
    data: { key: 'git_branch', value: { type: 'short_string', value: 'feature' }, confidence: 'high' } };
  raw.plan.events.splice(5, 0, observation);
  raw.plan.events.at(-1).eventIndex = 6;
  expect(decodeAdmissionReservation(Buffer.from(JSON.stringify(raw)), expected).kind).toBe('validated');
  const scoped = JSON.parse(JSON.stringify(raw)); scoped.plan.events[5].scope = { runId: raw.runId };
  expect(decodeAdmissionReservation(Buffer.from(JSON.stringify(scoped)), expected).kind).toBe('refused');
  const arbitrary = JSON.parse(JSON.stringify(raw)); arbitrary.plan.events[5].data.value = { type: 'token', value: 'forged' };
  expect(decodeAdmissionReservation(Buffer.from(JSON.stringify(arbitrary)), expected).kind).toBe('refused');
});
