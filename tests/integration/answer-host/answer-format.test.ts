import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAnswerWorker } from '../../../src/answer-v1/worker.js';
import { answerFormat } from '../../../src/answer-v1/answer-format.js';
import type { WorkView } from '../../../src/answer-v1/contracts/answer-contract.js';
const signal = () => AbortSignal.timeout(10000);
function question(view: WorkView) { if (view.kind !== 'question') throw new Error(view.kind); return view; }

it('publishes the pinned format across rejected answers, inspection, restart and contract changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'answer-format-'));
  const config = { storage: { journalRootDir: join(root, 'sessions'), hostIndexRootDir: join(root, 'index') },
    keyringPath: join(root, 'keys.json'), workflowStoragePath: join(root, 'workflows') };
  const boot = async () => { const worker = await createAnswerWorker(config, signal()); if (worker.kind !== 'created') throw new Error(worker.kind); return worker; };
  await mkdir(config.workflowStoragePath);
  const workflowFile = join(config.workflowStoragePath, 'format.json');
  await writeFile(workflowFile, JSON.stringify({ id: 'format', name: 'Format', description: 'Format proof', version: '1.0.0', steps: [
    { id: 'notes', title: 'Notes', prompt: 'Describe the evidence' },
    { id: 'review', title: 'Review', prompt: 'Review the evidence', outputContract: { contractRef: 'wr.contracts.review_verdict', required: true } },
    { id: 'last', title: 'Last', prompt: 'Summarize' },
  ] }));
  let worker = await boot();
  try {
    const open = await worker.opener.open({ workflowId: 'format', goal: 'Verify formats', workspacePath: root }, signal());
    if (open.kind !== 'opened') throw new Error(open.kind);
    expect(question(open.view).answerFormat).toEqual(answerFormat('notes'));
    const rejected = await worker.worker.answer(question(open.view).reply, { kind: 'unvalidated_json', value: { notes: ['wrong shape'] } }, signal());
    if (rejected.kind !== 'recorded') throw new Error(rejected.kind);
    expect(rejected.disposition).toBe('rejected');
    expect(question(rejected.view).answerFormat).toEqual(answerFormat('notes'));
    expect(question(rejected.view).issues).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining('Expected string, received array') })]));
    const receipt = await worker.inspector.inspectReceipt(open.view.read, rejected.receipt, signal());
    expect(receipt).toMatchObject({ kind: 'complete', disposition: 'rejected', chunk: JSON.stringify({ notes: ['wrong shape'] }) });
    const inspected = await worker.inspector.inspect(open.view.read, signal());
    expect(inspected).toMatchObject({ kind: 'question', answerFormat: answerFormat('notes') });
    expect(inspected).not.toHaveProperty('reply');
    await worker.close(signal());
    // The selected contract comes from the pinned definition, not the edited file.
    await writeFile(workflowFile, JSON.stringify({ id: 'format', name: 'Changed', description: 'Changed', version: '2.0.0', steps: [{ id: 'notes', title: 'Changed', prompt: 'Changed' }] }));
    worker = await boot();
    const recovered = await worker.recovery.recover(open.recovery, signal());
    if (recovered.kind === 'unavailable') throw new Error(recovered.reason);
    expect(question(recovered).answerFormat).toEqual(answerFormat('notes'));
    const next = await worker.worker.answer(question(recovered).reply, { kind: 'notes', notes: 'Evidence observed' }, signal());
    if (next.kind !== 'recorded') throw new Error(next.kind);
    expect(question(next.view).answerFormat).toEqual(answerFormat('review'));
    const partial = await worker.worker.answer(question(next.view).reply, { kind: 'unvalidated_json', value: { verdict: 'clean' } }, signal());
    if (partial.kind !== 'recorded') throw new Error(partial.kind);
    expect(partial.disposition).toBe('partial');
    expect(question(partial.view).answerFormat).toEqual(answerFormat('review'));
    const done = await worker.worker.answer(question(partial.view).reply, { kind: 'unvalidated_json', value: { notes: 'Reviewed', confidence: 'low', findings: [], summary: 'Complete' } }, signal());
    if (done.kind !== 'recorded') throw new Error(done.kind);
    expect(done.disposition).toBe('accepted');
    expect(question(done.view).answerFormat).toEqual(answerFormat('notes'));
  } finally { await worker.close(signal()); await rm(root, { recursive: true, force: true }); }
});
