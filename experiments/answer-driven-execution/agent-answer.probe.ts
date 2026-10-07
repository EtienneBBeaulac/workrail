/// <reference types="node" />
/** Candidate acceptance over the real MCP server and filesystem.
 * Historical notes controls require an explicit compiled prototype baseline root.
 * They are not assertions about a currently installed or released notes profile.
 */
import { expect, it } from 'vitest';
import { z } from 'zod';
import { readVerdictArtifact } from '../../src/coordinators/pr-review.js';
import { parseReviewVerdictArtifact } from '../../src/v2/durable-core/schemas/artifacts/review-verdict.js';
import { viewSchema, recordedSchema, openedSchema, evidenceReadSchema, drainReceipt, question, assertNoReply, unsupportedContracts, contractWorkflowId, unsupportedWorkflows, findingWithCategory, findingWithoutCategory, completeReview, fixture } from './agent-answer-fixture.js';
import { retainsRejectedNotes, replaysCommittedNotes, refusesInvalidNotesCapabilities } from './notes-acceptance-cases.js';

it('control: the actual notes profile completes both steps of the notes workflow over MCP', () => fixture(async f => {
  await f.boot('notes');
  const started = z.object({ kind: z.literal('work'), assignment: z.string() }).passthrough().parse(
    await f.call('start_work', { workflowId: 'answer-notes', workspacePath: f.root, goal: 'Record two observations.' }));
  const first = z.object({ kind: z.literal('work'), assignment: z.string() }).passthrough().parse(
    await f.call('submit_work', { assignment: started.assignment, result: { notes: 'First observation.' } }));
  const finished = await f.call('submit_work', { assignment: first.assignment, result: { notes: 'Second observation.' } });
  expect(finished).toMatchObject({ kind: 'finished', outcome: { kind: 'completed' } });
  expect(Object.keys(await f.journal()).length).toBeGreaterThan(0);
  expect(await f.notes()).toEqual(['First observation.', 'Second observation.']);
}));

it('notes acceptance preserves consumed-reference conflicts and the original receipt through restart', () => fixture(async f => {
  await f.boot('answers');
  const opened = openedSchema.parse(await f.call('open_work', { workflowId: 'answer-notes', workspacePath: f.root, goal: 'Preserve exact notes.' }));
  const originalReply = question(opened.view).reply;
  const answer = { notes: 'Exact original notes.\nSecond line.' };
  const first = recordedSchema.parse(await f.call('answer_work', { reply: originalReply, answer }));
  expect(first.disposition).toBe('accepted');
  await f.boot('answers');
  const before = await f.sessionFiles();
  const conflict = await f.call('answer_work', { reply: originalReply, answer: { notes: 'Different payload.' } });
  expect(conflict).toMatchObject({ kind: 'conflict', original: first.receipt });
  assertNoReply(conflict);
  expect(await f.sessionFiles()).toEqual(before);
  expect(JSON.parse((await drainReceipt(f.call, first.view.read, first.receipt)).reassembled)).toEqual(answer);
  expect(await f.call('answer_work', { reply: originalReply, answer })).toMatchObject({ kind: 'replay', receipt: first.receipt });
  expect(await f.sessionFiles()).toEqual(before);
  const finished = recordedSchema.parse(await f.call('answer_work', { reply: question(first.view).reply, answer: { notes: 'Second observation.' } }));
  expect(finished.view).toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  expect(await f.notes()).toEqual([answer.notes, 'Second observation.']);
}));

it('notes acceptance retains rejected payload and correction authority across MCP restart', retainsRejectedNotes);

it('notes acceptance resolves simultaneous divergent answers to one commit and its original receipt', () => fixture(async f => {
  await f.boot('answers');
  const opened = openedSchema.parse(await f.call('open_work', { workflowId: 'answer-notes', workspacePath: f.root, goal: 'Resolve racing answers.' }));
  const answers = [{ notes: 'Race A.' }, { notes: 'Race B.' }];
  const results = await Promise.all(answers.map(answer => f.call('answer_work', { reply: question(opened.view).reply, answer })));
  const committed = results.filter(result => recordedSchema.safeParse(result).success).map(result => recordedSchema.parse(result));
  expect(committed).toHaveLength(1);
  const winner = committed[0]!;
  expect(winner.disposition).toBe('accepted');
  const loserIndex = results.findIndex(result => !recordedSchema.safeParse(result).success);
  expect(loserIndex).toBeGreaterThanOrEqual(0);
  const loser = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('conflict'), original: z.literal(winner.receipt), current: viewSchema }).strict(),
    z.object({ kind: z.literal('unconfirmed'), reason: z.literal('commit_uncertain') }).strict(),
  ]).parse(results[loserIndex]);
  assertNoReply(loser);
  const beforeRetry = await f.sessionFiles();
  const settled = await f.call('answer_work', { reply: question(opened.view).reply, answer: answers[loserIndex] });
  expect(settled).toMatchObject({ kind: 'conflict', original: winner.receipt });
  assertNoReply(settled);
  expect(await f.sessionFiles()).toEqual(beforeRetry);
  const winnerPayload = JSON.parse((await drainReceipt(f.call, winner.view.read, winner.receipt)).reassembled);
  expect(answers).toContainEqual(winnerPayload);
  expect(await f.notes()).toEqual([winnerPayload.notes]);
  expect(recordedSchema.parse(await f.call('answer_work', { reply: question(winner.view).reply, answer: { notes: 'Final.' } })).view)
    .toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  expect(await f.notes()).toEqual([winnerPayload.notes, 'Final.']);
}));

it('retains a partial review across MCP recomposition and materializes the exact full artifact', () => fixture(async f => {
  await f.boot('answers');
  const opened = openedSchema.parse(await f.call('open_work', { workflowId: 'answer-review', workspacePath: f.root, goal: 'Review.' }));
  const initial = question(opened.view);
  const partial = recordedSchema.parse(await f.call('answer_work', { reply: initial.reply,
    answer: { notes: 'Checked sample.ts.', verdict: 'minor', confidence: 'high',
      findings: [findingWithCategory, findingWithoutCategory] } }));
  expect(partial.disposition).toBe('partial');
  expect(await f.artifacts()).toEqual([]);
  question(partial.view);
  expect(partial.view).toMatchObject({ issues: [{ kind: 'field', field: 'summary' }] });
  const before = await f.journal();
  await f.boot('answers');
  const recovered = question(await f.call('recover_work', { recovery: opened.recovery }));
  expect(await f.journal()).toEqual(before);
  expect(recovered).toMatchObject({ retained: expect.arrayContaining([expect.objectContaining({ receipt: partial.receipt })]), issues: [{ kind: 'field', field: 'summary' }] });
  const final = recordedSchema.parse(await f.call('answer_work', {
    reply: recovered.reply,
    answer: { summary: completeReview.summary },
  }));
  expect(final.view).toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  assertNoReply(final.view);
  expect(await f.artifacts()).toEqual([completeReview]);
  const materialized = (await f.artifacts())[0] as typeof completeReview;
  expect(materialized.findings[0]).toEqual(findingWithCategory);
  expect(materialized.findings[1]).toEqual(findingWithoutCategory);
  expect(Object.hasOwn(materialized.findings[1], 'findingCategory')).toBe(false);
  expect(await f.notes()).toEqual(['Checked sample.ts.']);

  // Downstream consumer acceptance: pass exact materialized artifact through actual exported readVerdictArtifact
  const handle = 'session-recomposed-review-1234';
  const consumerFindings = readVerdictArtifact(await f.artifacts(), handle);
  expect(consumerFindings).toEqual({
    severity: 'minor',
    findingSummaries: [
      'A retained finding with category',
      'A secondary finding with optional category absent',
    ],
    raw: JSON.stringify(materialized),
    source: 'artifact',
  });
}));

it('control: legacy readVerdictArtifact parses valid review fixture and isolates category-specific consumer behavior', () => {
  // Bounded legacy positive control: exercises actual exported readVerdictArtifact
  // with valid full review fixture without requiring mock dependencies.
  const handle = 'legacy-review-session-control-1234';
  const consumerVerdict = readVerdictArtifact([completeReview], handle);
  expect(consumerVerdict).not.toBeNull();
  expect(consumerVerdict).toEqual({
    severity: 'minor',
    findingSummaries: [
      'A retained finding with category',
      'A secondary finding with optional category absent',
    ],
    raw: JSON.stringify(completeReview),
    source: 'artifact',
  });

  // Verify parser intentionally reduces findings to summaries without preserving category on ReviewFindings
  expect(Object.hasOwn(consumerVerdict!, 'findingCategory')).toBe(false);
  expect(Object.hasOwn(consumerVerdict!, 'findings')).toBe(false);

  // Category routing in downstream coordinators (src/coordinators/modes/implement-shared.ts:128-131):
  // Consumers independently call parseReviewVerdictArtifact(raw) to inspect findingCategory
  const rawParsed = parseReviewVerdictArtifact(completeReview);
  expect(rawParsed).not.toBeNull();
  expect(rawParsed?.findings[0]?.findingCategory).toBe('correctness');
  expect(rawParsed?.findings[1]?.findingCategory).toBeUndefined();

  // Malformed or invalid artifacts return null to fall back to keyword scanning or unknown severity
  expect(readVerdictArtifact([{ ...completeReview, verdict: 'invalid' }], handle)).toBeNull();
  expect(readVerdictArtifact([{ kind: 'wr.other_artifact' }], handle)).toBeNull();
  expect(readVerdictArtifact([], handle)).toBeNull();
});

it('replays a committed answer without consuming the next assignment or granting read-side write authority', replaysCommittedNotes);

it('distinguishes a consumed-reference conflict from explicit findings replacement', () => fixture(async f => {
  await f.boot('answers');
  const opened = openedSchema.parse(await f.call('open_work', { workflowId: 'answer-review', workspacePath: f.root, goal: 'Review.' }));
  const reply = question(opened.view).reply;
  const first = recordedSchema.parse(await f.call('answer_work', { reply,
    answer: { notes: 'Reviewed.', verdict: 'minor', confidence: 'high', findings: [findingWithCategory] } }));
  const replacement = { ...findingWithCategory, summary: 'Corrected finding', remediation: 'Updated remedy.' };
  const before = await f.journal();
  const conflict = await f.call('answer_work', { reply, answer: { findings: [replacement] } });
  expect(conflict).toMatchObject({ kind: 'conflict', original: first.receipt });
  assertNoReply(conflict);
  expect(await f.journal()).toEqual(before);
  const proposed = recordedSchema.parse(await f.call('answer_work', {
    reply: question(first.view).reply, answer: { findings: [replacement] } }));
  expect(proposed.disposition).toBe('rejected');
  expect(proposed.view).toMatchObject({ retained: expect.arrayContaining([
    expect.objectContaining({ receipt: first.receipt }),
    expect.objectContaining({ receipt: proposed.receipt }),
  ]) });
  const captured = await f.journal();
  expect(captured).not.toEqual(before);
  await f.boot('answers');
  const correction = question(await f.call('recover_work', { recovery: opened.recovery }));
  expect(await f.journal()).toEqual(captured);
  expect(correction).toMatchObject({ retained: expect.arrayContaining([
    expect.objectContaining({ receipt: proposed.receipt }),
  ]) });
  const corrected = recordedSchema.parse(await f.call('answer_work', {
    reply: correction.reply,
    answer: { findings: [replacement], summary: completeReview.summary } }));
  expect(corrected.view).toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  assertNoReply(corrected.view);
  expect(await f.artifacts()).toEqual([{ ...completeReview, findings: [replacement] }]);
  expect(await f.notes()).toEqual(['Reviewed.']);
}));

it('refuses raw worker answers attempting privileged operations or run identity selection and completes with ordinary notes', () => fixture(async f => {
  await f.boot('answers');
  const opened = openedSchema.parse(await f.call('open_work', {
    workflowId: 'answer-notes', workspacePath: f.root, goal: 'Verify privilege and identity boundaries.' }));
  let pending = question(opened.view);
  expect(pending.instruction).toContain('Record the first observation.');

  // Raw worker attempts carrying unauthorized privileged fields, cancellation, or run identity selection
  // must be rejected as captured invalid answers without advancing the workflow.
  const unauthorizedAttempts = [
    { label: 'approval', answer: { notes: 'Attempting gate approval.', approval: true, verdict: 'approved', gateId: 'gate-1' } },
    { label: 'checkpoint', answer: { notes: 'Attempting checkpoint creation.', checkpoint: true, checkpointId: 'cp-priv' } },
    { label: 'fork', answer: { notes: 'Attempting branch fork.', fork: true, forkFromNodeId: 'first' } },
    { label: 'dispatch', answer: { notes: 'Attempting operator dispatch.', dispatch: true, workflowId: 'answer-review' } },
    { label: 'cancellation', answer: { notes: 'Attempting cancellation.', cancel: true, cancelled: true } },
    { label: 'run_identity', answer: { notes: 'Attempting run identity switch.', sessionId: 'forged-session-999', runId: 'forged-run-999' } },
  ] as const;

  for (const attempt of unauthorizedAttempts) {
    const refusal = recordedSchema.parse(await f.call('answer_work', {
      reply: pending.reply,
      answer: attempt.answer,
    }));
    expect(refusal.disposition, `Unauthorized ${attempt.label} should be rejected`).toBe('rejected');
    // Workflow must not advance; view returns actual current first-step bearer reply and prompt instruction
    pending = question(refusal.view);
    expect(pending.instruction).toContain('Record the first observation.');
    expect(Object.hasOwn(refusal.view, 'recovery')).toBe(false);
  }

  // Verify no workflow task advancement, notes, or artifacts materialized before valid submission
  expect(await f.artifacts()).toEqual([]);
  expect(await f.notes()).toEqual([]);

  // Paired valid ordinary notes control: valid notes must advance through each step to completion
  const first = recordedSchema.parse(await f.call('answer_work', {
    reply: pending.reply,
    answer: { notes: 'First observation.' },
  }));
  expect(first.disposition).toBe('accepted');
  const secondQuestion = question(first.view);
  expect(secondQuestion.instruction).toContain('Record the second observation.');

  const second = recordedSchema.parse(await f.call('answer_work', {
    reply: secondQuestion.reply,
    answer: { notes: 'Second observation.' },
  }));
  expect(second.disposition).toBe('accepted');
  expect(second.view).toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  assertNoReply(second.view);

  // Explicit stage progress, exact notes, artifacts, and terminal state assertions
  expect(await f.notes()).toEqual(['First observation.', 'Second observation.']);
  expect(await f.artifacts()).toEqual([]);
}));


// Admission must inspect the complete pinned definition before creating a run.
it.each(unsupportedWorkflows)('control: notes refuses valid unsupported workflow %s without enrollment', workflowId => fixture(async f => {
  await f.boot('notes');
  const metadata = await f.call('inspect_workflow', { workflowId, workspacePath: f.root, mode: 'metadata' });
  expect(metadata).toBeDefined(); // call() rejects MCP errors; validation is through the real registry.
  const before = await f.sessionFiles();
  expect(await f.call('start_work', { workflowId, workspacePath: f.root, goal: 'Check admission.' }))
    .toMatchObject({ kind: 'unsupported_workflow' });
  expect(await f.sessionFiles()).toEqual(before);
}));

it.each(unsupportedWorkflows)('refuses unsupported candidate workflow %s before enrollment and still admits notes', workflowId => fixture(async f => {
  await f.boot('answers');
  const before = await f.sessionFiles();
  const refusal = await f.call('open_work', { workflowId, workspacePath: f.root, goal: 'Check admission.' });
  expect(refusal).toMatchObject({ kind: 'unsupported_workflow' });
  assertNoReply(refusal);
  expect(await f.sessionFiles()).toEqual(before);
  const opened = openedSchema.parse(await f.call('open_work', {
    workflowId: 'answer-notes', workspacePath: f.root, goal: 'Supported control.' }));
  const first = recordedSchema.parse(await f.call('answer_work', {
    reply: question(opened.view).reply, answer: { notes: 'First supported observation.' } }));
  const final = recordedSchema.parse(await f.call('answer_work', {
    reply: question(first.view).reply, answer: { notes: 'Second supported observation.' } }));
  expect(final.view).toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  assertNoReply(final.view);
  expect(await f.notes()).toEqual(['First supported observation.', 'Second supported observation.']);
}));

it('refuses wrong-operation and corrupted capabilities without consuming a valid reply', refusesInvalidNotesCapabilities);

it('reads exact bounded receipt pages for domain-invalid JSON payload and retains rejection through recovery completion', () => fixture(async f => {
  await f.boot('answers');
  const opened = openedSchema.parse(await f.call('open_work', {
    workflowId: 'answer-notes', workspacePath: f.root, goal: 'Verify exact bounded receipt reads.',
  }));
  let pending = question(opened.view);

  // Multibyte string > 8192 UTF-8 bytes with numeric notes (domain-invalid JSON, not malformed JSON)
  const multibyteChunk = '日本語テスト文字とアクセントéàçüö';
  const largeMultibyteText = multibyteChunk.repeat(200); // 9,800 UTF-8 bytes
  const invalidPayload = {
    notes: 12345,
    unknownPayloadData: largeMultibyteText,
  };
  const payloadBytes = Buffer.byteLength(JSON.stringify(invalidPayload), 'utf8');
  expect(payloadBytes).toBeGreaterThan(8192);

  const rejected = recordedSchema.parse(await f.call('answer_work', {
    reply: pending.reply,
    answer: invalidPayload,
  }));
  expect(rejected.disposition).toBe('rejected');
  expect(rejected.receipt).toBeDefined();

  // Correction question emitted; workflow does not advance to step 2
  pending = question(rejected.view);
  expect(pending.instruction).toContain('Record the first observation.');

  // Snapshot session files before reads; reads must not cause file mutation
  const beforeReads = await f.sessionFiles();

  // Drain all pages with server recomposition between first and next page
  const drained = await drainReceipt(f.call, pending.read, rejected.receipt, {
    onFirstNextPage: async () => { await f.boot('answers'); },
  });
  expect(drained.pages.length).toBeGreaterThanOrEqual(3);
  expect(drained.pages[0]!.encoding).toBe('canonical_json');
  expect(drained.pages[0]!.disposition).toBe('rejected');

  // Reassemble exact payload and JSON.parse compare all original fields; no fabricated summary
  const reassembled = JSON.parse(drained.reassembled);
  expect(reassembled).toEqual(invalidPayload);

  // Disk sessions snapshot before/after reads unchanged
  expect(await f.sessionFiles()).toEqual(beforeReads);

  // Valid recovery notes completes both original steps
  const recovered = question(await f.call('recover_work', { recovery: opened.recovery }));
  const firstValid = recordedSchema.parse(await f.call('answer_work', {
    reply: recovered.reply,
    answer: { notes: 'First valid observation.' },
  }));
  expect(firstValid.disposition).toBe('accepted');
  const secondQuestion = question(firstValid.view);
  expect(secondQuestion.instruction).toContain('Record the second observation.');

  const secondValid = recordedSchema.parse(await f.call('answer_work', {
    reply: secondQuestion.reply,
    answer: { notes: 'Second valid observation.' },
  }));
  expect(secondValid.disposition).toBe('accepted');
  expect(secondValid.view).toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  assertNoReply(secondValid.view);
  expect(await f.notes()).toEqual(['First valid observation.', 'Second valid observation.']);

  // Re-read retained rejection after completed recovery: drain all pages and compare all fields exactly again
  const finishedSnapshot = await f.sessionFiles();
  const finishedReadRef = secondValid.view.read;
  const reread = await drainReceipt(f.call, finishedReadRef, rejected.receipt);
  expect(reread.pages.length).toBeGreaterThanOrEqual(3);
  expect(reread.pages[0]!.encoding).toBe('canonical_json');
  expect(reread.pages[0]!.disposition).toBe('rejected');
  expect(JSON.parse(reread.reassembled)).toEqual(invalidPayload);
  expect(await f.sessionFiles()).toEqual(finishedSnapshot);
}));

// Cross-scope reference validation over unbound InspectWork API.
// Does NOT assert host-bound employee/task-auth isolation; bound host acceptance remains unimplemented.
it('refuses cross-scope receipt and cursor reads across unbound runs while preserving replies and disk state', () => fixture(async f => {
  await f.boot('answers');

  // Unbound Run A
  const openedA = openedSchema.parse(await f.call('open_work', {
    workflowId: 'answer-notes', workspacePath: f.root, goal: 'Unbound Run A.',
  }));
  const qA = question(openedA.view);

  // Run A generates two distinct receipts within one run:
  // 1. A rejected domain-invalid submission under initial reply
  const rejectedPayloadA = { notes: 8888, unknownField: '日本語テスト文字とアクセントéàçüö'.repeat(120) };
  const rejectedA = recordedSchema.parse(await f.call('answer_work', {
    reply: qA.reply,
    answer: rejectedPayloadA,
  }));
  expect(rejectedA.disposition).toBe('rejected');
  const remedyQuestionA = question(rejectedA.view);

  // 2. A valid large notes submission under remedy reply
  const largeNotesA = 'Observation A payload with large content. '.repeat(120); // ~5000 bytes > 4096
  const firstA = recordedSchema.parse(await f.call('answer_work', {
    reply: remedyQuestionA.reply,
    answer: { notes: largeNotesA },
  }));
  expect(firstA.disposition).toBe('accepted');
  const pendingA = question(firstA.view);

  // Unbound Run B
  const openedB = openedSchema.parse(await f.call('open_work', {
    workflowId: 'answer-notes', workspacePath: f.root, goal: 'Unbound Run B.',
  }));
  const qB = question(openedB.view);
  const largeNotesB = 'Observation B payload with large content. '.repeat(120); // ~5000 bytes > 4096
  const firstB = recordedSchema.parse(await f.call('answer_work', {
    reply: qB.reply,
    answer: { notes: largeNotesB },
  }));
  expect(firstB.disposition).toBe('accepted');
  const pendingB = question(firstB.view);

  const filesBeforeReads = await f.sessionFiles();
  // Same-scope first page reads for cursor extraction
  const readRawA_rej = await f.call('inspect_work', { read: pendingA.read, receipt: rejectedA.receipt });
  assertNoReply(readRawA_rej);
  const pageA_rej = evidenceReadSchema.parse(readRawA_rej);
  expect(pageA_rej.kind).toBe('more');
  if (pageA_rej.kind !== 'more') throw new Error('Expected more pages for rejected A');
  const cursorA_rej = pageA_rej.next;

  const readRawA = await f.call('inspect_work', { read: pendingA.read, receipt: firstA.receipt });
  assertNoReply(readRawA);
  const pageA1 = evidenceReadSchema.parse(readRawA);
  expect(pageA1.kind).toBe('more');
  if (pageA1.kind !== 'more') throw new Error('Expected more pages for run A');
  expect(pageA1.receipt).toBe(firstA.receipt);
  expect(pageA1.disposition).toBe('accepted');
  expect(pageA1.encoding).toBe('canonical_json');
  const cursorA = pageA1.next;

  const readRawB = await f.call('inspect_work', { read: pendingB.read, receipt: firstB.receipt });
  assertNoReply(readRawB);
  const pageB1 = evidenceReadSchema.parse(readRawB);
  expect(pageB1.kind).toBe('more');
  if (pageB1.kind !== 'more') throw new Error('Expected more pages for run B');
  expect(pageB1.receipt).toBe(firstB.receipt);
  expect(pageB1.disposition).toBe('accepted');
  expect(pageB1.encoding).toBe('canonical_json');
  const cursorB = pageB1.next;

  expect(await f.sessionFiles()).toEqual(filesBeforeReads);
  const filesBeforeRefusals = await f.sessionFiles();

  // Cross read/receipt pair refuse without file change (strict refusal parsing)
  const crossReadAB = evidenceReadSchema.parse(await f.call('inspect_work', { read: pendingA.read, receipt: firstB.receipt }));
  assertNoReply(crossReadAB);
  expect(crossReadAB).toEqual({ kind: 'refused', reason: 'invalid_scope' });
  expect(JSON.stringify(crossReadAB)).not.toContain('Observation B payload');
  expect(await f.sessionFiles()).toEqual(filesBeforeRefusals);

  const crossReadBA = evidenceReadSchema.parse(await f.call('inspect_work', { read: pendingB.read, receipt: firstA.receipt }));
  assertNoReply(crossReadBA);
  expect(crossReadBA).toEqual({ kind: 'refused', reason: 'invalid_scope' });
  expect(JSON.stringify(crossReadBA)).not.toContain('Observation A payload');
  expect(await f.sessionFiles()).toEqual(filesBeforeRefusals);

  // Cursor is receipt-bound within the same run: crossing cursors between two receipts in Run A refuses
  const crossReceiptCursorWithinRun = evidenceReadSchema.parse(await f.call('inspect_work', {
    read: pendingA.read,
    receipt: firstA.receipt,
    cursor: cursorA_rej,
  }));
  assertNoReply(crossReceiptCursorWithinRun);
  expect(crossReceiptCursorWithinRun.kind).toBe('refused');
  expect(await f.sessionFiles()).toEqual(filesBeforeRefusals);

  const crossReceiptCursorWithinRunRev = evidenceReadSchema.parse(await f.call('inspect_work', {
    read: pendingA.read,
    receipt: rejectedA.receipt,
    cursor: cursorA,
  }));
  assertNoReply(crossReceiptCursorWithinRunRev);
  expect(crossReceiptCursorWithinRunRev.kind).toBe('refused');
  expect(await f.sessionFiles()).toEqual(filesBeforeRefusals);

  // Cross-run receipt cursor refuses without file change
  const crossCursorAB = evidenceReadSchema.parse(await f.call('inspect_work', {
    read: pendingA.read,
    receipt: firstA.receipt,
    cursor: cursorB,
  }));
  assertNoReply(crossCursorAB);
  expect(crossCursorAB.kind).toBe('refused');
  expect(await f.sessionFiles()).toEqual(filesBeforeRefusals);

  const crossCursorBA = evidenceReadSchema.parse(await f.call('inspect_work', {
    read: pendingB.read,
    receipt: firstB.receipt,
    cursor: cursorA,
  }));
  assertNoReply(crossCursorBA);
  expect(crossCursorBA.kind).toBe('refused');
  expect(await f.sessionFiles()).toEqual(filesBeforeRefusals);

  // Corrupted cursor refuses without file change
  const corruptedCursor = evidenceReadSchema.parse(await f.call('inspect_work', {
    read: pendingA.read,
    receipt: firstA.receipt,
    cursor: 'corrupted-cursor-token-9999',
  }));
  assertNoReply(corruptedCursor);
  expect(corruptedCursor.kind).toBe('refused');
  expect(await f.sessionFiles()).toEqual(filesBeforeRefusals);

  // Rightful original cursor recovers exact remaining content after failed calls, for BOTH runs
  const drainRemainingA = await drainReceipt(f.call, pendingA.read, firstA.receipt, { initialCursor: cursorA });
  const fullReassembledA = pageA1.chunk + drainRemainingA.reassembled;
  expect(JSON.parse(fullReassembledA)).toEqual({ notes: largeNotesA });

  const drainRemainingB = await drainReceipt(f.call, pendingB.read, firstB.receipt, { initialCursor: cursorB });
  const fullReassembledB = pageB1.chunk + drainRemainingB.reassembled;
  expect(JSON.parse(fullReassembledB)).toEqual({ notes: largeNotesB });

  // Full-page drain positive control for both runs from start
  const drainFullA = await drainReceipt(f.call, pendingA.read, firstA.receipt);
  expect(JSON.parse(drainFullA.reassembled)).toEqual({ notes: largeNotesA });
  const drainFullB = await drainReceipt(f.call, pendingB.read, firstB.receipt);
  expect(JSON.parse(drainFullB.reassembled)).toEqual({ notes: largeNotesB });
  expect(await f.sessionFiles()).toEqual(filesBeforeRefusals);

  // Original replies still work; refusals did not consume replies
  const finishA = recordedSchema.parse(await f.call('answer_work', {
    reply: pendingA.reply,
    answer: { notes: 'Second observation for run A.' },
  }));
  expect(finishA.disposition).toBe('accepted');
  expect(finishA.view).toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  assertNoReply(finishA.view);

  const finishB = recordedSchema.parse(await f.call('answer_work', {
    reply: pendingB.reply,
    answer: { notes: 'Second observation for run B.' },
  }));
  expect(finishB.disposition).toBe('accepted');
  expect(finishB.view).toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  assertNoReply(finishB.view);

  // Full receipts above are lossless; engine notes are bounded markdown summaries.
  const recordedNotes = await f.notes();
  expect(recordedNotes).toHaveLength(4);
  expect(recordedNotes).toContain('Second observation for run A.');
  expect(recordedNotes).toContain('Second observation for run B.');
  const summaries = recordedNotes.filter(note => note.endsWith('\n\n[TRUNCATED]'));
  expect(summaries).toHaveLength(2);
  expect(new Set(summaries).size).toBe(2);
  for (const summary of summaries) {
    expect(Buffer.byteLength(summary, 'utf8')).toBe(4096);
    const prefix = summary.slice(0, -'\n\n[TRUNCATED]'.length);
    expect(prefix.length).toBeGreaterThan(0);
    expect([largeNotesA, largeNotesB].some(original => original.startsWith(prefix))).toBe(true);
  }
}));

it.each([
  ['missing verdict only', { confidence: 'low' }, ['verdict'], { verdict: 'clean' }],
  ['missing confidence only', { verdict: 'clean' }, ['confidence'], { confidence: 'low' }],
  ['both', {}, ['confidence', 'verdict'], { verdict: 'clean', confidence: 'low' }],
] as const)('requires explicit review judgments: %s', (_name, initialJudgments, missingFields, finalJudgments) => fixture(async f => {
  await f.boot('answers');
  const opened = openedSchema.parse(await f.call('open_work', { workflowId: 'answer-review', workspacePath: f.root, goal: 'Review.' }));
  const initial = question(opened.view);
  const summary = 'Clean review summary';
  const notes = 'Checked notes once';

  const expectedPartial = { summary, notes, findings: [], ...initialJudgments };
  const partial = recordedSchema.parse(await f.call('answer_work', {
    reply: initial.reply,
    answer: expectedPartial,
  }));
  expect(partial.disposition).toBe('partial');
  question(partial.view);
  expect(await f.artifacts()).toEqual([]);

  const issuesViewSchema = z.object({
    issues: z.array(z.object({ kind: z.literal('field'), field: z.string().min(1), reason: z.string().min(1) }).passthrough()),
  }).passthrough();
  const checkIssues = (view: unknown) => {
    const parsed = issuesViewSchema.parse(view);
    expect(parsed.issues.map(i => i.field).sort()).toEqual(missingFields);
    for (const issue of parsed.issues) {
      expect(issue.reason.trim().length).toBeGreaterThan(0);
    }
  };
  checkIssues(partial.view);

  const payloadBefore = JSON.parse((await drainReceipt(f.call, partial.view.read, partial.receipt)).reassembled);
  expect(payloadBefore).toEqual(expectedPartial);
  const journalBeforeRecomposition = await f.journal();
  await f.boot('answers');
  const recovered = question(await f.call('recover_work', { recovery: opened.recovery }));
  checkIssues(recovered);
  const payloadAfter = JSON.parse((await drainReceipt(f.call, recovered.read, partial.receipt)).reassembled);
  expect(payloadAfter).toEqual(expectedPartial);
  expect(await f.journal()).toEqual(journalBeforeRecomposition);
  expect(await f.artifacts()).toEqual([]);

  const final = recordedSchema.parse(await f.call('answer_work', {
    reply: recovered.reply,
    answer: finalJudgments,
  }));
  expect(final.disposition).toBe('accepted');
  expect(final.view).toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  assertNoReply(final.view);

  const expectedArtifact = {
    kind: 'wr.review_verdict',
    verdict: 'clean',
    confidence: 'low',
    findings: [],
    summary,
  };
  const artifacts = await f.artifacts();
  expect(artifacts).toEqual([expectedArtifact]);
  expect(await f.notes()).toEqual([notes]);

  const consumerVerdict = readVerdictArtifact(artifacts, 'session-review-judgments');
  // The store canonicalizes key order. Raw means the actual retained artifact, not fixture insertion order.
  expect(JSON.parse(consumerVerdict!.raw)).toEqual(expectedArtifact);
  expect(consumerVerdict).toEqual({
    severity: 'clean',
    findingSummaries: [],
    raw: JSON.stringify(artifacts[0]),
    source: 'artifact',
  });
}));
