import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/** Establish source/build lineage without replacing the build being measured. */
export async function verifyCompilation(root, expectedBuild) {
  let temporary;
  try {
    temporary = await mkdtemp(path.join(os.tmpdir(), 'workrail-sniff-build-'));
    await promisify(execFile)(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'),
      '--project', path.join(root, 'tsconfig.build.json'), '--outDir', temporary,
      '--incremental', 'false', '--declaration', 'false'], { cwd: root, timeout: 60000, maxBuffer: 1024 * 1024 });
    for (const [file, expected] of Object.entries(expectedBuild)) {
      const built = await readFile(path.join(temporary, path.relative('dist', file)));
      if (createHash('sha256').update(built).digest('hex') !== expected) {
        return { kind: 'stale_build', file };
      }
    }
    return { kind: 'verified_compilation' };
  } catch (error) {
    return { kind: 'compilation_unavailable', reason: error.message };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
