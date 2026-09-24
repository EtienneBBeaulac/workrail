import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { publishAdmissionFile, readAdmissionFile, MAX_ADMISSION_BYTES } from '../../../src/answer-v1/immutable-admission-file.js';

const signal = () => new AbortController().signal;
const bytes = (value: string) => Buffer.from(value);

it('refuses invalid correlation before touching storage', async () => {
  expect(await publishAdmissionFile('/missing', '../escape', bytes('a'), signal()))
    .toEqual({ kind: 'refused', reason: 'invalid_input' });
  expect(await publishAdmissionFile('relative', randomUUID(), bytes('a'), signal()))
    .toEqual({ kind: 'refused', reason: 'invalid_input' });
  expect(await publishAdmissionFile('/missing', randomUUID(), bytes(''), signal()))
    .toEqual({ kind: 'refused', reason: 'invalid_input' });
  expect(await publishAdmissionFile('/missing', randomUUID(), new Uint8Array(MAX_ADMISSION_BYTES + 1), signal()))
    .toEqual({ kind: 'refused', reason: 'invalid_input' });
});

describe.skipIf(process.platform === 'win32')('immutable admission publication', () => {
  it('concurrent candidates adopt one complete winner and never overwrite it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'admission-file-'));
    try {
      const id = randomUUID();
      const values = Array.from({ length: 8 }, (_, i) => JSON.stringify({ candidate: i }));
      const results = await Promise.all(values.map(value => publishAdmissionFile(root, id, bytes(value), signal())));
      expect(results.filter(result => result.kind === 'durable' && result.publication === 'published_by_this_call')).toHaveLength(1);
      expect(results.filter(result => result.kind === 'durable' && result.publication === 'existing_winner')).toHaveLength(7);
      const winner = await readFile(join(root, `${id}.json`), 'utf8');
      expect(values).toContain(winner);
      for (const result of results) {
        expect(result.kind).toBe('durable');
        if (result.kind === 'durable') expect(Buffer.from(result.bytes).toString()).toBe(winner);
      }
      const replay = await publishAdmissionFile(root, id, bytes('changed request'), signal());
      expect(replay).toMatchObject({ kind: 'durable', publication: 'existing_winner' });
      if (replay.kind === 'durable') expect(Buffer.from(replay.bytes).toString()).toBe(winner);
      expect(await readdir(root)).toEqual([`${id}.json`]);
      const other = randomUUID();
      expect((await publishAdmissionFile(root, other, bytes(winner), signal())).kind).toBe('durable');
      expect((await readdir(root)).sort()).toEqual([`${id}.json`, `${other}.json`].sort());
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('retains an invalid existing winner and refuses to replace it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'admission-file-invalid-'));
    try {
      const id = randomUUID(), path = join(root, `${id}.json`);
      await writeFile(path, '');
      expect(await publishAdmissionFile(root, id, bytes('replacement'), signal()))
        .toEqual({ kind: 'refused', reason: 'invalid_file' });
      expect(await readFile(path, 'utf8')).toBe('');
      const cancelled = new AbortController(); cancelled.abort();
      expect(await publishAdmissionFile(root, randomUUID(), bytes('a'), cancelled.signal))
        .toEqual({ kind: 'unconfirmed', reason: 'cancelled' });
      expect(await readdir(root)).toEqual([`${id}.json`]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('bounds existing files and accepts the maximum payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'admission-file-size-'));
    try {
      const id = randomUUID();
      await writeFile(join(root, `${id}.json`), new Uint8Array(MAX_ADMISSION_BYTES + 1));
      expect(await publishAdmissionFile(root, id, bytes('replacement'), signal()))
        .toEqual({ kind: 'refused', reason: 'invalid_file' });
      const other = randomUUID();
      const result = await publishAdmissionFile(root, other, new Uint8Array(MAX_ADMISSION_BYTES), signal());
      expect(result.kind).toBe('durable');
      if (result.kind === 'durable') expect(result.bytes.length).toBe(MAX_ADMISSION_BYTES);
      expect((await readdir(root)).sort()).toEqual([`${id}.json`, `${other}.json`].sort());
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses a FIFO without blocking on a writer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'admission-file-fifo-'));
    try {
      const id = randomUUID();
      await new Promise<void>((resolve, reject) => {
        execFile('mkfifo', [join(root, `${id}.json`)], error => error ? reject(error) : resolve());
      });
      expect(await publishAdmissionFile(root, id, bytes('replacement'), signal()))
        .toEqual({ kind: 'refused', reason: 'invalid_file' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('does not follow an existing winner symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'admission-file-link-'));
    try {
      const id = randomUUID(), original = join(root, 'original');
      await writeFile(original, 'private');
      await symlink(original, join(root, `${id}.json`));
      expect(await publishAdmissionFile(root, id, bytes('replacement'), signal()))
        .toEqual({ kind: 'refused', reason: 'invalid_file' });
      expect(await readFile(original, 'utf8')).toBe('private');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

it.skipIf(process.platform !== 'win32')('refuses unsupported directory durability on Windows', async () => {
  expect(await publishAdmissionFile(process.cwd(), randomUUID(), bytes('a'), signal()))
    .toEqual({ kind: 'refused', reason: 'unsupported_platform' });
});

it.skipIf(process.platform === 'win32')('cold reads distinguish absence, invalid files and cancellation without publishing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'admission-read-'));
  try {
    const id = randomUUID(), target = join(root, `${id}.json`);
    expect(await readAdmissionFile(root, id, signal())).toEqual({ kind: 'missing' });
    expect(await readdir(root)).toEqual([]);
    expect(await readAdmissionFile(root, '../escape', signal())).toEqual({ kind: 'refused', reason: 'invalid_input' });
    const controller = new AbortController(); controller.abort();
    expect(await readAdmissionFile(root, id, controller.signal)).toEqual({ kind: 'unconfirmed', reason: 'cancelled' });
    await writeFile(target, '');
    expect(await readAdmissionFile(root, id, signal())).toEqual({ kind: 'refused', reason: 'invalid_file' });
    await rm(target);
    await symlink(join(root, 'absent'), target);
    expect(await readAdmissionFile(root, id, signal())).toEqual({ kind: 'refused', reason: 'invalid_file' });
    expect(await readdir(root)).toEqual([`${id}.json`]);
  } finally { await rm(root, { recursive: true, force: true }); }
});


it.skipIf(process.platform === 'win32')('identical bytes and cold reads cannot claim fresh publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'admission-provenance-'));
  try {
    const id = randomUUID(), candidate = bytes('same candidate');
    const results = await Promise.all(Array.from({ length: 8 }, () => publishAdmissionFile(root, id, candidate, signal())));
    expect(results.filter(r => r.kind === 'durable' && r.publication === 'published_by_this_call')).toHaveLength(1);
    expect(results.filter(r => r.kind === 'durable' && r.publication === 'existing_winner')).toHaveLength(7);
    expect(await publishAdmissionFile(root, id, candidate, signal())).toMatchObject({ kind: 'durable', publication: 'existing_winner' });
    const read = await readAdmissionFile(root, id, signal());
    expect(read).toEqual({ kind: 'durable', bytes: candidate });
    expect(read).not.toHaveProperty('publication');
  } finally { await rm(root, { recursive: true, force: true }); }
});
