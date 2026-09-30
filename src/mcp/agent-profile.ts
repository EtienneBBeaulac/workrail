export type AgentProfile = 'legacy' | 'answers';

export type AgentProfileSelection =
  | { readonly kind: 'selected'; readonly profile: AgentProfile }
  | { readonly kind: 'refused'; readonly reason: 'unsupported_profile' };

// An explicit unsupported profile must not silently acquire legacy capabilities.
export function selectAgentProfile(value: string | undefined): AgentProfileSelection {
  if (value === undefined || value === 'legacy') return { kind: 'selected', profile: 'legacy' };
  if (value === 'answers') return { kind: 'selected', profile: 'answers' };
  return { kind: 'refused', reason: 'unsupported_profile' };
}
