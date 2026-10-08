import { registerHooks } from 'node:module';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

async function observe(root, dependency) {
  const sourceRoot = realpathSync(root);
  const subject = pathToFileURL(`${sourceRoot}/experiments/answer-driven-execution/study-manifest.mts`).href;
  const fixtures = pathToFileURL(`${sourceRoot}/experiments/answer-driven-execution/proofs/manifest-byte-fixtures.mjs`).href;
  const zodRoot = pathToFileURL(`${realpathSync(dependency)}/`).href;
  const builtins = new Set(['node:crypto', 'node:fs/promises', 'node:path', 'node:url']);
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL === subject && specifier === 'zod') return nextResolve(`${zodRoot}index.js`, context);
    if (context.parentURL === subject && builtins.has(specifier)) return nextResolve(specifier, context);
    if (specifier === subject || specifier === fixtures || (context.parentURL?.startsWith(zodRoot)
        && (specifier.startsWith('./') || specifier.startsWith('../')))) {
      const resolved = nextResolve(specifier, context);
      if (specifier !== subject && specifier !== fixtures && !resolved.url.startsWith(zodRoot)) throw new Error('Dependency escaped');
      return resolved;
    }
    throw new Error('Undeclared manifest import');
  }});
  const { verifyStudyManifest } = await import(subject);
  const { buildStageAManifest, buildStageBManifest } = await import(fixtures);
  const directory = await mkdtemp(join(tmpdir(), 'manifest-byte-proof-'));
  const rows = [];
  try {
    for (const [stage, build] of [['A', buildStageAManifest], ['B', buildStageBManifest]]) {
      const work = join(directory, stage);
      const contents = new Map();
      const register = (path, content) => {
        contents.set(path.slice(1), Buffer.from(content));
        return createHash('sha256').update(content).digest('hex');
      };
      const input = build(register);
      // Fixture declarations and the real reader share a private filesystem root.
      const relocate = value => {
        if (Array.isArray(value)) return value.map(relocate);
        if (value !== null && typeof value === 'object') return Object.fromEntries(
          Object.entries(value).map(([key, child]) => [key,
            (key === 'path' || key === 'workspacePath') && typeof child === 'string'
              ? join(work, child.slice(1)) : relocate(child)]));
        return value;
      };
      const manifest = relocate(input);
      for (const [path, content] of contents) {
        await mkdir(dirname(join(work, path)), { recursive: true });
        await writeFile(join(work, path), content);
      }
      // Exercise both faults for every independently declared fixture artifact.
      const cases = [['intact', null], ...[...contents.keys()].sort().flatMap(path => [['changed', path], ['missing', path]])];
      for (const [fault, target] of cases) {
        if (fault === 'changed') await writeFile(join(work, target), 'changed bytes');
        if (fault === 'missing') await unlink(join(work, target));
        const reads = [];
        const reader = async path => {
          const name = relative(work, path);
          if (!contents.has(name)) throw new Error('Undeclared artifact read');
          reads.push(name);
          return readFile(path);
        };
        try {
          const result = await verifyStudyManifest(manifest, reader);
          rows.push({ stage, fault, target, kind: result.kind,
            scope: result.kind === 'manifest_verified' ? result.scope : null,
            trialAuthorization: result.kind === 'manifest_verified' ? result.trialAuthorization : null,
            totalPlannedTrials: result.kind === 'manifest_verified' ? result.totalPlannedTrials : null,
            verifiedArtifactCount: result.kind === 'manifest_verified' ? result.verifiedArtifactCount : null,
            phase: result.kind === 'rejected' ? result.phase : null,
            errors: result.kind === 'rejected' ? result.errors.map(error => ({
              kind: error.kind, path: typeof error.path === 'string' ? relative(work, error.path) : null,
            })) : [], reads });
        } finally {
          if (target !== null) await writeFile(join(work, target), contents.get(target));
        }
      }
    }
    return { version: 1, rows };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

try {
  if (process.argv.length !== 4) throw new Error('Expected source and dependency roots');
  process.stdout.write(JSON.stringify(await observe(process.argv[2], process.argv[3])));
} catch {
  process.stderr.write('Manifest bytes observation unavailable\n');
  process.exitCode = 2;
}
