#!/usr/bin/env node
/**
 * CI policy guardrails.
 *
 * This prevents accidental weakening of the CI contract that the GitHub ruleset relies on:
 * - "CI Success" must remain the stable required check name
 * - It must depend on the full required job set
 * - CI must run on push to main so release workflow_run triggers reliably
 */
const fs = require('fs');
const path = require('path');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function loadYaml(filePath) {
  // js-yaml is already in the dependency tree (used elsewhere). Prefer it over a brittle parser.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const yaml = require('js-yaml');
  return yaml.load(fs.readFileSync(filePath, 'utf8'));
}

function asStringArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  return [String(value)];
}

function main() {
  const ciPath = path.resolve('.github/workflows/ci.yml');
  if (!fs.existsSync(ciPath)) fail(`missing CI workflow: ${ciPath}`);

  const ci = loadYaml(ciPath);

  // 1) Ensure CI triggers on push to main (required for release workflow_run)
  const on = ci.on;
  if (!on || !on.push || !Array.isArray(on.push.branches) || !on.push.branches.includes('main')) {
    fail('CI policy violation: ci.yml must trigger on push to main (on.push.branches includes "main")');
  }

  // 2) Ensure default permissions are read-only
  const permissions = ci.permissions;
  if (!permissions || permissions.contents !== 'read') {
    fail('CI policy violation: ci.yml must set permissions.contents: read');
  }

  // 3) Ensure CI Success job exists and stays stable
  const jobs = ci.jobs || {};
  const ciSuccess = jobs['ci-success'];
  if (!ciSuccess) fail('CI policy violation: missing jobs.ci-success');
  if (ciSuccess.name !== 'CI Success') {
    fail(`CI policy violation: jobs.ci-success.name must be exactly "CI Success" (got: ${String(ciSuccess.name)})`);
  }

  // 4) Ensure CI Success depends on the full required set
  const requiredNeeds = [
    'lockfile',
    'build-artifact',
    'semantic-release-dry-run',
    'typecheck',
    'validate-workflows',
    'build-and-test',
    'contract-tests',
    'e2e-tests',
  ];
  const actualNeeds = asStringArray(ciSuccess.needs);
  const missingNeeds = requiredNeeds.filter((n) => !actualNeeds.includes(n));
  if (missingNeeds.length) {
    fail(`CI policy violation: CI Success is missing needs: ${missingNeeds.join(', ')}`);
  }

  // 5) Ensure these jobs exist (so needs aren't dangling)
  const missingJobs = requiredNeeds.filter((n) => !jobs[n]);
  if (missingJobs.length) {
    fail(`CI policy violation: missing required jobs: ${missingJobs.join(', ')}`);
  }

  // 6) Ensure semantic-release-dry-run depends on lockfile + build-artifact
  const sr = jobs['semantic-release-dry-run'];
  const srNeeds = asStringArray(sr.needs);
  for (const dep of ['lockfile', 'build-artifact']) {
    if (!srNeeds.includes(dep)) {
      fail(`CI policy violation: semantic-release-dry-run must need ${dep}`);
    }
  }

  console.log('CI policy check passed');
}

main();