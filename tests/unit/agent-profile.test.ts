import { expect, it } from 'vitest';
import { selectAgentProfile } from '../../src/mcp/agent-profile.js';

it.each([undefined, 'legacy'] as const)('selects the legacy profile for %j', value => {
  expect(selectAgentProfile(value)).toEqual({ kind: 'selected', profile: 'legacy' });
});
it('selects the explicit answers profile', () => {
  expect(selectAgentProfile('answers')).toEqual({ kind: 'selected', profile: 'answers' });
});
it.each(['notes', 'unknown-profile', '', 'Answers', ' answers '])('refuses %j without implicit capability fallback', value => {
  expect(selectAgentProfile(value)).toEqual({ kind: 'refused', reason: 'unsupported_profile' });
});
