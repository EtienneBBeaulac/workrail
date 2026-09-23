import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constructWorkspaceTools, type WorkspaceToolSchemas } from '../../src/daemon/runner/workspace-tools.js';
import { getSchemas } from '../../src/daemon/runner/tool-schemas.js';
import { asRunId } from '../../src/daemon/daemon-events.js';

it('shares read-before-write state with workspace tools and exposes no workflow-control tools', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'workrail-tools-'));
  const all = getSchemas();
  const schemas: WorkspaceToolSchemas = {
    BashParams: all['BashParams'], ReadParams: all['ReadParams'], WriteParams: all['WriteParams'],
    GlobParams: all['GlobParams'], GrepParams: all['GrepParams'], EditParams: all['EditParams'],
  };
  const tools = constructWorkspaceTools({ workspacePath, readFileState: new Map(),
    runId: asRunId('workspace-proof'), sessionId: null, emitter: undefined }, schemas);
  const signal = new AbortController().signal;
  try {
    expect(tools.map(t => t.name)).toEqual(['Bash', 'Read', 'Write', 'Glob', 'Grep', 'Edit']);
    const filePath = join(workspacePath, 'example.txt');
    await writeFile(filePath, 'before');
    const read = tools.find(t => t.name === 'Read')!;
    const write = tools.find(t => t.name === 'Write')!;
    const edit = tools.find(t => t.name === 'Edit')!;
    await expect(edit.execute('unread-edit', { file_path: filePath, old_string: 'before', new_string: 'edited' }, signal)).rejects.toThrow();
    await expect(write.execute('unread', { filePath, content: 'after' }, signal)).rejects.toThrow();
    await read.execute('read', { filePath }, signal);
    await write.execute('write', { filePath, content: 'after' }, signal);
    expect(await readFile(filePath, 'utf8')).toBe('after');
    await edit.execute('edit', { file_path: filePath, old_string: 'after', new_string: 'edited' }, signal);
    expect(await readFile(filePath, 'utf8')).toBe('edited');
  } finally { await rm(workspacePath, { recursive: true, force: true }); }
});
