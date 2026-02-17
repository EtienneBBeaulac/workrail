#!/usr/bin/env node
/**
 * Deterministic dist manifest generator/verifier.
 *
 * Usage:
 *   node scripts/dist-manifest.js --dist dist --write dist/manifest.json
 *   node scripts/dist-manifest.js --dist dist --verify dist/manifest.json
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const args = new Map();
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      args.set(key, true);
    } else {
      args.set(key, value);
      i += 1;
    }
  }
  return {
    distDir: args.get('--dist'),
    writePath: args.get('--write'),
    verifyPath: args.get('--verify'),
  };
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function listFilesRecursive(dir) {
  /** @type {string[]} */
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function buildManifest(distDir, manifestPath) {
  const absDist = path.resolve(distDir);
  const absManifest = path.resolve(manifestPath);
  if (!fs.existsSync(absDist)) fail(`dist dir does not exist: ${absDist}`);

  const files = listFilesRecursive(absDist)
    .filter((p) => path.resolve(p) !== absManifest)
    .map((p) => path.relative(absDist, p))
    .map((p) => p.replace(/\\/g, '/')) // Normalize to forward slashes (cross-platform)
    .sort();

  /** @type {Record<string, {sha256: string, bytes: number}>} */
  const entries = {};
  for (const rel of files) {
    const full = path.join(absDist, rel);
    const stat = fs.statSync(full);
    entries[rel] = { sha256: sha256File(full), bytes: stat.size };
  }

  return {
    distDir: path.basename(absDist),
    files: entries,
  };
}

function verifyManifest(distDir, manifestPath) {
  const absDist = path.resolve(distDir);
  const absManifest = path.resolve(manifestPath);
  if (!fs.existsSync(absDist)) fail(`dist dir does not exist: ${absDist}`);
  if (!fs.existsSync(absManifest)) fail(`manifest does not exist: ${absManifest}`);

  const expected = JSON.parse(fs.readFileSync(absManifest, 'utf8'));
  const actual = buildManifest(absDist, absManifest);

  const expectedKeys = Object.keys(expected.files ?? {}).sort();
  const actualKeys = Object.keys(actual.files).sort();

  const missing = expectedKeys.filter((k) => !actual.files[k]);
  const extra = actualKeys.filter((k) => !(expected.files ?? {})[k]);

  /** @type {string[]} */
  const mismatches = [];
  for (const k of expectedKeys) {
    if (!actual.files[k]) continue;
    const exp = expected.files[k];
    const act = actual.files[k];
    if (exp.sha256 !== act.sha256 || exp.bytes !== act.bytes) {
      mismatches.push(`${k} (expected ${exp.bytes}/${exp.sha256}, got ${act.bytes}/${act.sha256})`);
    }
  }

  if (missing.length || extra.length || mismatches.length) {
    console.error('dist manifest verification failed');
    if (missing.length) console.error(`missing: ${missing.join(', ')}`);
    if (extra.length) console.error(`extra: ${extra.join(', ')}`);
    if (mismatches.length) console.error(`mismatched: ${mismatches.join(', ')}`);
    process.exit(1);
  }
}

function main() {
  const { distDir, writePath, verifyPath } = parseArgs(process.argv);
  if (!distDir) fail('missing --dist <dir>');
  const modeCount = Number(Boolean(writePath)) + Number(Boolean(verifyPath));
  if (modeCount !== 1) fail('must specify exactly one of --write or --verify');

  if (writePath) {
    const manifest = buildManifest(distDir, writePath);
    fs.mkdirSync(path.dirname(writePath), { recursive: true });
    fs.writeFileSync(writePath, JSON.stringify(manifest, null, 2));
    const digest = sha256File(writePath);
    console.log(`wrote manifest: ${writePath}`);
    console.log(`manifest sha256: ${digest}`);
    return;
  }

  verifyManifest(distDir, verifyPath);
  console.log(`verified manifest: ${verifyPath}`);
}

main();