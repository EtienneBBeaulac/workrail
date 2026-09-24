export type WorkspaceFailure = Readonly<{ reason: 'invalid_batch' | 'intent_unacknowledged' | 'execution_unknown' | 'outcome_unacknowledged'; effect?: string }>;
