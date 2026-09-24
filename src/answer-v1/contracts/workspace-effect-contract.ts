export type WorkspaceRefusal = 'invalid_command' | 'closed' | 'deadline_stopped' | 'stale_owner';
export type WorkspaceFailure =
  | Readonly<{reason:'backend_refused';refusal:WorkspaceRefusal;effect:string}>
  | Readonly<{ reason: 'invalid_batch' | 'intent_unacknowledged' | 'execution_unknown' | 'outcome_unacknowledged'; effect?: string }>;
