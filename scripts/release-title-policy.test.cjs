const { test } = require('node:test');
const assert = require('node:assert/strict');
const { titleViolation } = require('./release-title-policy.cjs');

test('accepts product-scoped feature and scope-free maintenance titles', () => {
  assert.equal(titleViolation('feat(mcp): release modern protocol support', 1293), null);
  assert.equal(titleViolation('chore: update package version to 3.126.0', 1294), null);
  assert.equal(titleViolation('feat(mcp)!: change protocol contract', 1295), null);
});

test('rejects the actual lost-release title and invalid scopes', () => {
  for (const title of ['Serve modern MCP alongside legacy clients', 'chore(release): 3.126.0', 'fix(ci): repair checks', 'random: title']) {
    assert.notEqual(titleViolation(title, 1292), null);
  }
});

test('rejects CI skip markers, multiline injection and trailing punctuation', () => {
  for (const title of ['chore: bump [skip ci]', 'chore: bump [CI SKIP]', 'feat(mcp): title\nbody', 'feat(mcp): title.', 'feat(mcp): title ']) {
    assert.notEqual(titleViolation(title, 1293), null);
  }
});

test('checks the full default squash subject at its exact length boundary', () => {
  const title = 'feat(mcp): ' + 'x'.repeat(72 - 'feat(mcp): '.length - ' (#1293)'.length);
  assert.equal(titleViolation(title, 1293), null);
  assert.notEqual(titleViolation(title + 'x', 1293), null);
  assert.notEqual(titleViolation(undefined, 1293), null);
  assert.notEqual(titleViolation(title, undefined), null);
});
