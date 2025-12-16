export type DomainError =
  | { readonly kind: 'workflow_not_found'; readonly workflowId: string }
  | { readonly kind: 'invalid_state'; readonly message: string }
  | { readonly kind: 'invalid_loop'; readonly loopId: string; readonly message: string }
  | { readonly kind: 'condition_eval_failed'; readonly message: string }
  | { readonly kind: 'max_iterations_exceeded'; readonly loopId: string; readonly maxIterations: number }
  | { readonly kind: 'missing_context'; readonly message: string };
