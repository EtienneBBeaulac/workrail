const TYPES = new Set(['feat', 'fix', 'chore', 'refactor', 'docs', 'test', 'perf', 'revert']);
const SCOPES = new Set(['console', 'mcp', 'workflows', 'engine', 'schema', 'docs']);

// GitHub's default squash subject appends the PR number to its title.
function titleViolation(title, number) {
  if (typeof title !== 'string' || !Number.isSafeInteger(number) || number < 1) {
    return 'Missing pull request title or number';
  }
  if (/\[(?:skip ci|ci skip)\]/i.test(title)) return 'CI skip markers are forbidden';
  const match = /^([a-z]+)(?:\(([a-z]+)\))?(!)?: (\S[^\r\n]*)$/.exec(title);
  if (!match || !TYPES.has(match[1])) return 'Use a conventional commit title';
  if (match[2] && !SCOPES.has(match[2])) return 'Use a product scope';
  if (title !== title.trim() || title.endsWith('.')) return 'Remove trailing whitespace or period';
  if (`${title} (#${number})`.length > 72) return 'Default squash subject exceeds 72 characters';
  return null;
}

module.exports = { titleViolation };
