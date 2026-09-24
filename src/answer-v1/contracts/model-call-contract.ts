export type ReserveModelCallResult =
  | Readonly<{ kind: 'reserved'; call: string; ordinal: number }>
  | Readonly<{ kind: 'refused'; reason: 'storage_unavailable' | 'stale_owner' | 'stopped' | 'invalid_delivery' | 'missing_policy' | 'budget_exhausted' }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'commit_uncertain' }>;

export type BudgetedProviderResult<T> =
  | Readonly<{ kind: 'completed'; value: T }>
  | Exclude<ReserveModelCallResult, { kind: 'reserved' }>
  | Readonly<{ kind: 'refused'; reason: 'busy' | 'reconciliation_required' }>
  | Readonly<{ kind: 'unconfirmed'; reason: 'provider_outcome_unknown' }>;

export type ModelCallFailure = Exclude<BudgetedProviderResult<never>, { kind: 'completed' }>;
