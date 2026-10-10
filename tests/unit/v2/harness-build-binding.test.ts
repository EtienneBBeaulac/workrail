import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
// @ts-expect-error Standalone acceptance tools do not require a TS loader.
import { verifyCompilation } from '../../../scripts/harness-sniff-build-binding.mjs';

describe('harness source/build lineage', () => {
  it('accepts matching emission and rejects stale emission after a valid source change', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'workrail-build-binding-test-'));
    try {
      await mkdir(path.join(root, 'src'));
      await symlink(path.resolve('node_modules'), path.join(root, 'node_modules'));
      await writeFile(path.join(root, 'tsconfig.build.json'), JSON.stringify({ compilerOptions: {
        target: 'ES2020', module: 'ESNext', rootDir: 'src', skipLibCheck: true, types: [],
      }, include: ['src/**/*.ts'] }));
      const source = path.join(root, 'src/observation.ts');
      await writeFile(source, "export const observation = 'mcp';\n");
      const build = { 'dist/observation.js': createHash('sha256').update("export const observation = 'mcp';\n").digest('hex') };
      expect(await verifyCompilation(root, build)).toEqual({ kind: 'verified_compilation' });
      await writeFile(source, "export const observation = 'cursor';\n");
      expect(await verifyCompilation(root, build)).toEqual({ kind: 'stale_build', file: 'dist/observation.js' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps setup failure separate from a stale build', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'workrail-build-unavailable-'));
    try {
      expect((await verifyCompilation(root, { 'dist/observation.js': 'unknown' })).kind).toBe('compilation_unavailable');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
