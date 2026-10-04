import { expect } from 'vitest';
import { fixture, openedSchema, recordedSchema, viewSchema, question, assertNoReply, drainReceipt } from './agent-answer-fixture.js';

export const retainsRejectedNotes = () => fixture(async f => {
  await f.boot('answers');
  const opened = openedSchema.parse(await f.call('open_work', { workflowId: 'answer-notes', workspacePath: f.root, goal: 'Correct retained notes.' }));
  const originalReply = question(opened.view).reply;
  const invalid = { notes: 42 };
  const rejected = recordedSchema.parse(await f.call('answer_work', { reply: originalReply, answer: invalid }));
  expect(rejected.disposition).toBe('rejected');
  expect(question(rejected.view).instruction).toBe(question(opened.view).instruction);
  const correctionReply = question(rejected.view).reply;
  await f.boot('answers');
  const before = await f.sessionFiles();
  expect(await f.call('answer_work', { reply: originalReply, answer: invalid })).toMatchObject({ kind: 'replay', receipt: rejected.receipt });
  expect(JSON.parse((await drainReceipt(f.call, rejected.view.read, rejected.receipt)).reassembled)).toEqual(invalid);
  expect(await f.sessionFiles()).toEqual(before);
  const recovered = question(viewSchema.parse(await f.call('recover_work', { recovery: opened.recovery })));
  expect(recovered.instruction).toBe(question(rejected.view).instruction);
  expect(recovered.reply).toBe(correctionReply);
  const corrected = recordedSchema.parse(await f.call('answer_work', { reply: correctionReply, answer: { notes: 'Corrected first.' } }));
  expect(corrected.disposition).toBe('accepted');
  expect(question(corrected.view).instruction).toContain('Record the second observation.');
  const finished = recordedSchema.parse(await f.call('answer_work', { reply: question(corrected.view).reply, answer: { notes: 'Second.' } }));
  expect(finished.view).toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  expect(JSON.parse((await drainReceipt(f.call, rejected.view.read, rejected.receipt)).reassembled)).toEqual(invalid);
  expect(await f.notes()).toEqual(['Corrected first.', 'Second.']);
});

export const replaysCommittedNotes = () => fixture(async f => {
  await f.boot('answers');
  const opened = openedSchema.parse(await f.call('open_work', { workflowId: 'answer-notes', workspacePath: f.root, goal: 'Record two observations.' }));
  const request = { reply: question(opened.view).reply, answer: { notes: 'First observation.' } };
  const first = recordedSchema.parse(await f.call('answer_work', request));
  const pending = question(first.view);
  const committed = await f.sessionFiles();

  // Replay of committed answer cannot mint reply or recovery refs; causes no session mutation
  const replay = await f.call('answer_work', request);
  expect(replay).toMatchObject({ kind: 'replay', receipt: first.receipt });
  expect(replay).toMatchObject({ original: { kind: 'question', read: expect.any(String) } });
  assertNoReply(replay);
  expect(await f.sessionFiles()).toEqual(committed);

  // Inspecting active question: read view cannot mint reply or recovery refs; causes no session mutation
  const inspected = await f.call('inspect_work', { read: pending.read });
  expect(inspected).toMatchObject({ kind: 'question', read: pending.read });
  assertNoReply(inspected);
  expect(await f.sessionFiles()).toEqual(committed);

  // Recovery with read capability is refused without mutating session
  expect(await f.call('recover_work', { recovery: pending.read })).toMatchObject({ kind: 'unavailable' });
  expect(await f.sessionFiles()).toEqual(committed);

  // Valid recovery returns active question view with reply authority; read operation causes no session mutation
  const recovered = question(await f.call('recover_work', { recovery: opened.recovery }));
  expect(recovered).toMatchObject({ kind: 'question' });
  expect(recovered.read).toBeDefined();
  expect(recovered.reply).toBeDefined();
  expect(await f.sessionFiles()).toEqual(committed);

  // Answering with the original pending.reply after valid recovery proves recovery didn't invalidate it
  const final = recordedSchema.parse(await f.call('answer_work', { reply: pending.reply, answer: { notes: 'Second observation.' } }));
  expect(final.view).toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  assertNoReply(final.view);

  // Inspecting finished view: cannot mint reply or recovery refs; causes no session mutation
  const committedFinished = await f.sessionFiles();
  const inspectedFinished = await f.call('inspect_work', { read: (final.view as { read: string }).read });
  expect(inspectedFinished).toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  assertNoReply(inspectedFinished);
  expect(await f.sessionFiles()).toEqual(committedFinished);

  // Replaying final answer: cannot mint reply or recovery refs; causes no session mutation
  const finalReplay = await f.call('answer_work', { reply: pending.reply, answer: { notes: 'Second observation.' } });
  expect(finalReplay).toMatchObject({ kind: 'replay', receipt: final.receipt });
  assertNoReply(finalReplay);
  expect(await f.sessionFiles()).toEqual(committedFinished);

  // Completed recover must explicitly be finished with completed execution rather than arbitrary unavailable; no session mutation
  const completedRecovery = await f.call('recover_work', { recovery: opened.recovery });
  expect(completedRecovery).toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  assertNoReply(completedRecovery);
  expect(await f.sessionFiles()).toEqual(committedFinished);

  // Explicit stage progress, notes, and artifact assertions
  expect(await f.notes()).toEqual(['First observation.', 'Second observation.']);
  expect(await f.artifacts()).toEqual([]);
});

export const refusesInvalidNotesCapabilities = () => fixture(async f => {
  await f.boot('answers');
  const opened = openedSchema.parse(await f.call('open_work', {
    workflowId: 'answer-notes', workspacePath: f.root, goal: 'Separate authority.' }));
  const initial = question(opened.view);
  const before = await f.sessionFiles();
  const refusedCalls = [
    ['answer_work', { reply: initial.read, answer: { notes: 'Must not be retained.' } }, 'not_retained'],
    ['answer_work', { reply: opened.recovery, answer: { notes: 'Must not be retained.' } }, 'not_retained'],
    ['recover_work', { recovery: initial.read }, 'unavailable'],
    ['recover_work', { recovery: initial.reply }, 'unavailable'],
    ['inspect_work', { read: initial.reply }, 'unavailable'],
    ['inspect_work', { read: opened.recovery }, 'unavailable'],
    ['answer_work', { reply: initial.reply + '.tampered', answer: { notes: 'Must not be retained.' } }, 'not_retained'],
    ['inspect_work', { read: initial.read + '.tampered' }, 'unavailable'],
    ['recover_work', { recovery: opened.recovery + '.tampered' }, 'unavailable'],
  ] as const;
  for (const [name, args, kind] of refusedCalls) {
    const refusal = await f.call(name, args);
    expect(refusal).toMatchObject({ kind });
    assertNoReply(refusal);
    expect(JSON.stringify(refusal)).not.toContain('Must not be retained.');
    expect(await f.sessionFiles()).toEqual(before);
  }
  const inspected = await f.call('inspect_work', { read: initial.read });
  expect(inspected).toMatchObject({ kind: 'question' });
  assertNoReply(inspected);
  expect(await f.sessionFiles()).toEqual(before);
  const first = recordedSchema.parse(await f.call('answer_work', {
    reply: initial.reply, answer: { notes: 'First authorized observation.' } }));
  question(first.view);
  const committed = await f.sessionFiles();
  const recovered = question(await f.call('recover_work', { recovery: opened.recovery }));
  expect(await f.sessionFiles()).toEqual(committed);
  const final = recordedSchema.parse(await f.call('answer_work', {
    reply: recovered.reply, answer: { notes: 'Second authorized observation.' } }));
  expect(final.view).toMatchObject({ kind: 'finished', execution: { kind: 'completed' } });
  assertNoReply(final.view);
  expect(await f.notes()).toEqual(['First authorized observation.', 'Second authorized observation.']);
});
