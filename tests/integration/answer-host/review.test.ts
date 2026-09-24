import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAnswerWorker } from '../../../src/answer-v1/worker.js';
import type { WorkView, AnswerSubmission } from '../../../src/answer-v1/contracts/answer-contract.js';
const signal = () => new AbortController().signal;
function question(view: WorkView) { if (view.kind !== 'question') throw new Error(view.kind); return view; }

it('durably retains review fragments, explicit corrections, replay receipts and final artifact through restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-host-'));
  const config = { storage: { journalRootDir: join(root, 'sessions'), hostIndexRootDir: join(root, 'index') },
    keyringPath: join(root, 'keys.json'), workflowStoragePath: join(root, 'workflows') };
  const boot = async () => { const created = await createAnswerWorker(config, signal()); if (created.kind !== 'created') throw new Error(created.kind); return created; };
  const input = (value: unknown): AnswerSubmission => ({ kind: 'unvalidated_json', value: value as never });
  try {
    await mkdir(config.workflowStoragePath);
    await writeFile(join(config.workflowStoragePath, 'review.json'), JSON.stringify({ id: 'review', name: 'Review', description: 'Review fixture', version: '1.0.0',
      steps: [{ id: 'review', title: 'Review', prompt: 'Review the code.', outputContract: { contractRef: 'wr.contracts.review_verdict', required: true } }] }));
    let worker = await boot();
    const opened = await worker.opener.open({ workflowId: 'review', workspacePath: root, goal: 'Review' }, signal());
    if (opened.kind !== 'opened') throw new Error(JSON.stringify(opened));
    const finding = { severity: 'minor', summary: 'Finding', remediation: 'Repair guard', details: { count: 1 } };
    const initial = { notes: 'Reviewed.', verdict: 'minor', confidence: 'high', findings: [finding] };
    const first = await worker.worker.answer(question(opened.view).reply, input(initial), signal());
    expect(first).toMatchObject({ kind: 'recorded', disposition: 'partial', view: { issues: [{ field: 'summary' }] } });
    if (first.kind !== 'recorded') throw new Error(first.kind);
    const same = await worker.worker.answer(question(opened.view).reply, input(initial), signal());
    expect(same).toMatchObject({ kind: 'replay', receipt: first.receipt });
    expect(JSON.stringify(same)).not.toContain('"reply"');
    const replacement = { ...finding, summary: 'Corrected finding' };
    expect(await worker.worker.answer(question(opened.view).reply, input({ findings: [replacement] }), signal())).toMatchObject({ kind: 'conflict', original: first.receipt });
    const proposed = await worker.worker.answer(question(first.view).reply, input({ findings: [replacement] }), signal());
    expect(proposed).toMatchObject({ kind: 'recorded', disposition: 'rejected' });
    if (proposed.kind !== 'recorded') throw new Error(proposed.kind);
    await worker.close(signal());
    worker = await boot();
    const recovered = await worker.recovery.recover(opened.recovery, signal());
    if (recovered.kind === 'unavailable') throw new Error(recovered.reason);
    const finished = await worker.worker.answer(question(recovered).reply, input({ findings: [replacement], summary: 'Done.' }), signal());
    expect(finished).toMatchObject({ kind: 'recorded', disposition: 'accepted', view: { kind: 'finished', execution: { kind: 'completed' } } });
    if (finished.kind !== 'recorded') throw new Error(finished.kind);
    const receipt = await worker.inspector.inspectReceipt(finished.view.read, finished.receipt, signal());
    expect(receipt).toMatchObject({ kind: 'complete', disposition: 'accepted' });
    if (receipt.kind !== 'complete') throw new Error(receipt.kind);
    expect(JSON.parse(receipt.chunk)).toEqual({ findings: [replacement], summary: 'Done.' });
    const partialEvidence = await worker.inspector.inspectReceipt(finished.view.read, first.receipt, signal());
    expect(partialEvidence).toMatchObject({ kind: 'complete', disposition: 'partial' });
    if (partialEvidence.kind === 'complete') expect(JSON.parse(partialEvidence.chunk)).toEqual(initial);
    await worker.close(signal());
    const files = await readdir(config.storage.journalRootDir, { recursive: true });
    const texts = await Promise.all(files.filter(f => f.endsWith('.jsonl')).map(f => readFile(join(config.storage.journalRootDir, f), 'utf8')));
    const events = texts.flatMap(t => t.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
    const outputs = events.filter(e => e.kind === 'node_output_appended');
    expect(outputs.filter(e => e.data.payload.payloadKind === 'artifact_ref').map(e => e.data.payload.content)).toEqual([
      { kind: 'wr.review_verdict', verdict: 'minor', confidence: 'high', findings: [replacement], summary: 'Done.' },
    ]);
    expect(outputs.filter(e => e.data.payload.payloadKind === 'notes').map(e => e.data.payload.notesMarkdown)).toEqual(['Reviewed.']);
    expect(events.filter(e => e.kind === 'answer_host_recorded' && e.data.kind === 'review_committed')).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(['notes', 'review'])('a completed review cannot leak contributions into its %s successor', async second => {
  const root = await mkdtemp(join(tmpdir(), 'review-nodes-'));
  const config = { storage: { journalRootDir: join(root, 'sessions'), hostIndexRootDir: join(root, 'index') }, keyringPath: join(root, 'keys.json'), workflowStoragePath: join(root, 'workflows') };
  const contract = { contractRef: 'wr.contracts.review_verdict', required: true };
  try {
    await mkdir(config.workflowStoragePath);
    await writeFile(join(config.workflowStoragePath, 'review.json'), JSON.stringify({ id: 'review', name: 'Review', description: 'Two nodes', version: '1.0.0', steps: [
      { id: 'one', title: 'One', prompt: 'First review', outputContract: contract },
      { id: 'two', title: 'Two', prompt: 'Second obligation', ...(second === 'review' ? { outputContract: contract } : {}) },
    ] }));
    const worker = await createAnswerWorker(config, signal());
    if (worker.kind !== 'created') throw new Error(worker.kind);
    try {
      const opened = await worker.opener.open({ workflowId: 'review', workspacePath: root, goal: 'Check isolation' }, signal());
      if (opened.kind !== 'opened') throw new Error(opened.kind);
      const first = await worker.worker.answer(question(opened.view).reply, { kind: 'unvalidated_json', value: { notes: 'First review notes', verdict: 'clean', confidence: 'low', findings: [] } }, signal());
      if (first.kind !== 'recorded') throw new Error(first.kind);
      const done = await worker.worker.answer(question(first.view).reply, { kind: 'unvalidated_json', value: { summary: 'First done' } }, signal());
      if (done.kind !== 'recorded') throw new Error(done.kind);
      const next = question(done.view);
      expect(next.instruction).toContain('Second obligation');
      expect(next.issues.map(i => i.kind === 'field' ? i.field : 'gate')).toEqual(second === 'review' ? ['notes', 'verdict', 'confidence', 'findings', 'summary'] : []);
      const replay = await worker.worker.answer(question(opened.view).reply, { kind: 'unvalidated_json', value: { notes: 'First review notes', verdict: 'clean', confidence: 'low', findings: [] } }, signal());
      expect(replay).toMatchObject({ kind: 'replay', receipt: first.receipt, original: { instruction: question(first.view).instruction, issues: [{ field: 'summary' }] } });
      expect(JSON.stringify(replay)).not.toContain('"reply"');
      const final = await worker.worker.answer(next.reply, { kind: 'unvalidated_json', value: second === 'notes' ? { notes: 'Second notes' }
        : { notes: 'Second review', verdict: 'minor', confidence: 'high', findings: [], summary: 'Second done' } }, signal());
      expect(final).toMatchObject({ kind: 'recorded', disposition: 'accepted', view: { kind: 'finished' } });
    } finally { await worker.close(signal()); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
