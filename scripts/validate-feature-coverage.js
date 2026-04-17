#!/usr/bin/env node
/**
 * Validates that every `wr.features.*` ID in the feature registry is documented
 * in spec/authoring-spec.json.
 *
 * Run: node scripts/validate-feature-coverage.js
 * CI:  npm run validate:feature-coverage
 *
 * Hard-fails with a named list of uncovered IDs. Zero false positives by design:
 * the check only fires when a feature exists in the registry but is absent from
 * the spec entirely. It does not check rule quality -- only presence.
 *
 * When a new feature is added to feature-registry.ts, this script will fail until
 * a rule referencing that feature ID is added to authoring-spec.json.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(repoRoot, 'src/application/services/compiler/feature-registry.ts');
const SPEC_PATH = path.join(repoRoot, 'spec/authoring-spec.json');

function extractFeatureIds(source) {
  // Match id: 'wr.features.*' or id: "wr.features.*"
  const matches = [...source.matchAll(/id:\s*['"]([^'"]+)['"]/g)];
  const ids = matches.map((m) => m[1]).filter((id) => id.startsWith('wr.features.'));
  if (ids.length === 0) {
    throw new Error(
      'Extracted 0 feature IDs from feature-registry.ts -- regex may be broken or the file moved.\n' +
      `Looked in: ${REGISTRY_PATH}`
    );
  }
  return ids;
}

function collectSpecText(spec) {
  const texts = [];
  const visitRule = (rule) => {
    texts.push(
      rule.id ?? '',
      rule.rule ?? '',
      ...(rule.checks ?? []),
      ...(rule.antiPatterns ?? []),
      ...(rule.sourceRefs ?? []).map((r) => `${r.path ?? ''} ${r.note ?? ''}`)
    );
  };
  for (const topic of [...(spec.topics ?? []), ...(spec.plannedTopics ?? [])]) {
    for (const rule of topic.rules ?? []) visitRule(rule);
  }
  for (const rule of spec.plannedRules ?? []) visitRule(rule);
  return texts.join('\n');
}

function main() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    console.error(`[feature-coverage] SKIP: feature registry not found at ${REGISTRY_PATH}`);
    console.error('  This check requires the TypeScript source tree. Skipping in package-only environments.');
    process.exit(0);
  }

  const registrySource = fs.readFileSync(REGISTRY_PATH, 'utf8');
  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));

  const featureIds = extractFeatureIds(registrySource);
  const specText = collectSpecText(spec);

  const uncovered = featureIds.filter((id) => !specText.includes(id));

  if (uncovered.length > 0) {
    console.error('[feature-coverage] FAIL: feature IDs with no authoring-spec.json coverage:');
    for (const id of uncovered) {
      console.error(`  - ${id}`);
    }
    console.error('');
    console.error('Fix: add a rule to spec/authoring-spec.json (topics or plannedTopics) whose');
    console.error('  checks, rule text, or sourceRefs mentions the full feature ID string.');
    console.error('  See the "features" topic in authoring-spec.json for the existing pattern.');
    process.exit(1);
  }

  console.log(`[feature-coverage] OK: all ${featureIds.length} feature(s) covered in authoring-spec.json`);
  console.log(`  Features: ${featureIds.join(', ')}`);
}

main();
