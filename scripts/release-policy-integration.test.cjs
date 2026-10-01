const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function check(event, mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workrail-release-policy-'));
  try {
    fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
    for (const name of ['ci.yml', 'release.yml']) {
      const source = fs.readFileSync(`.github/workflows/${name}`, 'utf8');
      fs.writeFileSync(path.join(root, `.github/workflows/${name}`), mutate ? mutate(name, source) : source);
    }
    const eventPath = path.join(root, 'event.json');
    fs.writeFileSync(eventPath, JSON.stringify(event));
    return spawnSync(process.execPath, [path.resolve('scripts/ci-policy-check.js')], {
      cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const event = (title) => ({ number: 1293, pull_request: { title } });

test('CI entry rejects historical prose title and accepts compensating feature title', () => {
  assert.equal(check(event('Serve modern MCP alongside legacy clients')).status, 1);
  assert.equal(check(event('feat(mcp): release modern protocol through protected CI')).status, 0);
});

test('CI policy refuses automation protection bypass and skipped checks', () => {
  for (const forbidden of ['gh pr merge branch --admin', 'chore: bump [skip ci]']) {
    assert.equal(check(event('chore: update version'), (name, source) => name === 'release.yml' ? source + '\n# ' + forbidden : source).status, 1);
  }
});

test('CI Success cannot drop the policy dependency', () => {
  assert.equal(check(event('chore: update version'), (name, source) => name === 'ci.yml' ? source.replace('changes, ci-policy,', 'changes,') : source).status, 1);
});

test('the compensating feature is a minor release and version bumps cannot loop', async () => {
  const { analyzeCommits } = await import('@semantic-release/commit-analyzer');
  const config = require('../.releaserc.cjs');
  const [, options] = config.plugins.find((entry) => Array.isArray(entry) && entry[0] === '@semantic-release/commit-analyzer');
  const analyze = (message) => analyzeCommits(options, { commits: [{ message }], logger: { log() {} } });
  assert.equal(await analyze('Serve modern MCP alongside legacy clients (#1292)'), null);
  assert.equal(await analyze('feat(mcp): release modern protocol through protected CI (#1293)'), 'minor');
  assert.equal(await analyze('chore: update package version to 3.126.0 (#1294)'), null);
});

test('release source and downloaded CI artifacts belong to the same checked revision', () => {
  const yaml = require('js-yaml');
  const workflow = yaml.load(fs.readFileSync('.github/workflows/release.yml', 'utf8'));
  const steps = workflow.jobs.release.steps;
  const checkout = steps.find((step) => step.name === 'Checkout');
  assert.equal(checkout.with.ref, '${{ github.event.workflow_run.head_sha }}');
  const download = steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with['run-id'], '${{ github.event.workflow_run.id }}');
});

test('the required CI Success shell fails closed on policy and change-detection outcomes', () => {
  const yaml = require('js-yaml');
  const workflow = yaml.load(fs.readFileSync('.github/workflows/ci.yml', 'utf8'));
  const aggregate = workflow.jobs['ci-success'];
  const script = aggregate.steps.find((step) => step.name === 'Check required jobs').run;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workrail-ci-result-'));
  try {
    const run = (policy, changes = 'success') => {
      const rendered = script.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expression) => {
        if (expression === 'github.event_name') return 'pull_request';
        if (expression === 'needs.ci-policy.result') return policy;
        if (expression === 'needs.changes.result') return changes;
        if (/^needs\.[a-z-]+\.result$/.test(expression)) return 'success';
        throw new Error('Unexpected workflow expression: ' + expression);
      });
      return spawnSync('bash', ['-e', '-c', rendered], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: path.join(root, 'summary') } }).status;
    };
    assert.equal(run('success'), 0);
    for (const outcome of ['failure', 'cancelled', 'skipped', '']) {
      assert.equal(run(outcome), 1);
      assert.equal(run('success', outcome), 1);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
