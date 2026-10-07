import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAnswerWorker } from '../../../src/answer-v1/worker.js';
import type { AnswerSubmission, WorkView } from '../../../src/answer-v1/contracts/answer-contract.js';
import type { JsonValue } from '../../../src/v2/durable-core/canonical/json-types.js';

type Completion = 'missing_summary' | 'full_replacement';
type Scenario = 'partial' | 'recreated' | 'declined_correction';
const signal = () => new AbortController().signal;
function question(view: WorkView) {
  if (view.kind !== 'question') throw new Error(`Expected question, got ${view.kind}`);
  return view;
}
const submission = (value: JsonValue): AnswerSubmission => ({ kind: 'unvalidated_json', value });
const finding = { severity: 'minor', summary: 'Retained finding', remediation: 'Repair guard', details: { count: 1 } };
const initial = { notes: 'Original notes.', verdict: 'minor', confidence: 'high', findings: [finding] };

async function completeReview(scenario: Scenario, completion: Completion) {
  const root = await mkdtemp(join(tmpdir(), 'review-requirement-'));
  const config = { storage: { journalRootDir: join(root, 'sessions'), hostIndexRootDir: join(root, 'index') },
    keyringPath: join(root, 'keys.json'), workflowStoragePath: join(root, 'workflows') };
  const boot = async () => {
    const created = await createAnswerWorker(config, signal());
    if (created.kind !== 'created') throw new Error(created.kind);
    return created;
  };
  let worker: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    await mkdir(config.workflowStoragePath);
    await writeFile(join(config.workflowStoragePath, 'review.json'), JSON.stringify({ id: 'review', name: 'Review',
      description: 'Independent review acceptance', version: '1.0.0', steps: [{ id: 'review', title: 'Review',
        prompt: 'Review the code.', outputContract: { contractRef: 'wr.contracts.review_verdict', required: true } }] }));
    worker = await boot();
    const opened = await worker.opener.open({ workflowId: 'review', workspacePath: root, goal: 'Retain judgments' }, signal());
    if (opened.kind !== 'opened') throw new Error(opened.kind);
    const first = await worker.worker.answer(question(opened.view).reply, submission(initial), signal());
    expect(first).toMatchObject({ kind: 'recorded', disposition: 'partial', view: { kind: 'question', issues: [{ field: 'summary' }] } });
    if (first.kind !== 'recorded') throw new Error(first.kind);
    let view = first.view;
    if (scenario === 'recreated') {
      await worker.close(signal());
      worker = await boot();
      const recovered = await worker.recovery.recover(opened.recovery, signal());
      expect(recovered).toMatchObject({ kind: 'question', issues: [{ field: 'summary' }] });
      if (recovered.kind === 'unavailable') throw new Error(recovered.reason);
      view = recovered;
      expect(question(view).issues).toEqual([{ kind: 'field', field: 'summary', reason: 'Provide summary.' }]);
    }
    if (scenario === 'declined_correction') {
      const conflict = await worker.worker.answer(question(view).reply, submission({ verdict: 'clean' }), signal());
      expect(conflict).toMatchObject({ kind: 'recorded', disposition: 'rejected', view: { kind: 'question' } });
      if (conflict.kind !== 'recorded') throw new Error(conflict.kind);
      view = conflict.view;
    }
    const value = completion === 'missing_summary' ? { summary: 'Review complete.' }
      : { ...initial, summary: 'Review complete.' };
    const done = await worker.worker.answer(question(view).reply, submission(value), signal());
    expect(done).toMatchObject({ kind: 'recorded', disposition: 'accepted', view: { kind: 'finished', execution: { kind: 'completed' } } });
    if (done.kind !== 'recorded') throw new Error(done.kind);
    const retained = await worker.inspector.inspectReceipt(done.view.read, first.receipt, signal());
    expect(retained).toMatchObject({ kind: 'complete', disposition: 'partial' });
    if (retained.kind !== 'complete') throw new Error(retained.kind);
    expect(JSON.parse(retained.chunk)).toEqual(initial);
    const submitted = await worker.inspector.inspectReceipt(done.view.read, done.receipt, signal());
    expect(submitted).toMatchObject({ kind: 'complete', disposition: 'accepted' });
    if (submitted.kind !== 'complete') throw new Error(submitted.kind);
    expect(JSON.parse(submitted.chunk)).toEqual(value);
    await worker.close(signal()); worker = undefined;
    const files = await readdir(config.storage.journalRootDir, { recursive: true });
    const texts = await Promise.all(files.filter(f => f.endsWith('.jsonl')).map(f => readFile(join(config.storage.journalRootDir, f), 'utf8')));
    const events = texts.flatMap(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
    const outputs = events.filter(event => event.kind === 'node_output_appended');
    expect(outputs.filter(event => event.data.payload.payloadKind === 'artifact_ref').map(event => event.data.payload.content)).toEqual([
      { kind: 'wr.review_verdict', verdict: 'minor', confidence: 'high', findings: [finding], summary: 'Review complete.' },
    ]);
    expect(outputs.filter(event => event.data.payload.payloadKind === 'notes').map(event => event.data.payload.notesMarkdown)).toEqual(['Original notes.']);
    expect(events.filter(event => event.kind === 'answer_host_recorded' && event.data.kind === 'review_committed')).toHaveLength(1);
  } finally {
    if (worker) await worker.close(signal());
    await rm(root, { recursive: true, force: true });
  }
}

it.each(['missing_summary', 'full_replacement'] as const)('R5 completes an ordinary partial review with %s', completion => completeReview('partial', completion));
it.each(['missing_summary', 'full_replacement'] as const)('R6 completes a recreated-engine review with %s', completion => completeReview('recreated', completion));
it.each(['missing_summary', 'full_replacement'] as const)('R7 preserves judgments after a declined correction with %s', completion => completeReview('declined_correction', completion));
