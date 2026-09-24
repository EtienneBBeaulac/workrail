import 'reflect-metadata';
import { ResultAsync } from 'neverthrow';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { composeAnswerEngine } from '../../../../src/answer-v1/engine-composition.js';
import { prepareStartWorkflow } from '../../../../src/v2/usecases/start-workflow.js';
import { createWorkflow } from '../../../../src/types/workflow.js';
import { createUserDirectorySource } from '../../../../src/types/workflow-source.js';
import { buildHostAdmissionCandidate, publishAndReconcileHostAdmission } from '../../../../src/answer-v1/host-admission.js';

process.on('disconnect', () => process.exit(1));

async function main() {
const [root, boundary] = process.argv.slice(-2);
if (!root || (boundary !== 'published' && boundary !== 'locked' && boundary !== 'appended')) throw new Error('Invalid crash fixture arguments');
const config = { storage: { journalRootDir: join(root, 'sessions'), hostIndexRootDir: join(root, 'index') },
  keyringPath: join(root, 'keys', 'keyring.json'), workflowStoragePath: join(root, 'source') };
const engine = await composeAnswerEngine(config);
if (engine.kind !== 'ready') throw new Error(engine.kind);
const request = { workflowId: 'crash-admission', goal: 'recover the same admission', workspacePath: root };
const workflow = createWorkflow({ id: request.workflowId, name: 'Crash admission', description: 'Process death fixture',
  version: '1.0.0', steps: [{ id: 'first', title: 'First', prompt: 'Original pinned prompt' }] },
createUserDirectorySource(config.workflowStoragePath));
const prepared = await prepareStartWorkflow({ ...engine, fallbackWorkflowReader: { getWorkflowById: async () => workflow } },
  { ...request, injectOnboarding: false }, { triggerSource: 'daemon' });
if (prepared.isErr()) throw new Error(prepared.error.kind);
const initial = prepared.value;
const expected = { operationId: randomUUID(), request };
const candidate = buildHostAdmissionCandidate(prepared.value, request, expected.operationId, engine, () => 1);
if (candidate.kind !== 'candidate') throw new Error(candidate.kind);

// Stop only after the real persistence boundary has returned. The parent kills this
// process, so no finally block releases an append-held session lock or finishes admission.
function stopAtBoundary(): Promise<never> {
  return new Promise(() => {
    setInterval(() => undefined, 1000);
    process.send?.({ boundary, expected, sessionId: initial.sessionId });
  });
}
const admissionEngine = {
  ...engine,
  gate: boundary === 'published' ? {
    withHealthySessionLock: () => ResultAsync.fromPromise(stopAtBoundary(), () => ({ code: 'GATE_CALLBACK_FAILED' as const, sessionId: initial.sessionId, message: 'fixture stop' })),
  } : engine.gate,
  sessionStore: boundary !== 'published' ? {
    load: engine.sessionStore.load.bind(engine.sessionStore),
    append: (...args: Parameters<typeof engine.sessionStore.append>) => boundary === 'locked'
      ? ResultAsync.fromPromise(stopAtBoundary(), () => ({ code: 'SESSION_STORE_IO_ERROR' as const, message: 'fixture stop' }))
      : engine.sessionStore.append(...args).andThen(() => ResultAsync.fromPromise(stopAtBoundary(), () => ({ code: 'SESSION_STORE_IO_ERROR' as const, message: 'fixture stop' }))),
  } : engine.sessionStore,
};
await publishAndReconcileHostAdmission(admissionEngine, root, expected, candidate.bytes, new AbortController().signal);
throw new Error('Crash boundary was not reached');

}
void main().catch(error => { console.error(error); process.exitCode = 1; });
