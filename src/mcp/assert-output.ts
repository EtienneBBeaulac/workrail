/**
 * Dev/test-only output invariant helper.
 *
 * WHY THIS EXISTS:
 * MCP handlers previously called Schema.parse() on server-produced data.
 * This violated "validate at boundaries, trust inside" -- the data comes from
 * internal typed code, not an external boundary. TypeScript 'as T' assertions
 * provide compile-time safety at zero runtime cost.
 *
 * However, some schemas had cross-field invariants worth catching during
 * development (blocker sort order, continueToken presence). Those checks are
 * extracted here and run only outside production.
 *
 * USAGE:
 *   // Instead of: const payload = SomeSchema.parse(data);
 *   // Use:        const payload = data as z.infer<typeof SomeSchema>;
 *   // And in dev: assertOutput(payload, assertSomeInvariants);
 *
 * The assertOutput() call is a no-op in production (NODE_ENV === 'production').
 * It runs the check function and throws on invariant violations in all other environments.
 */

// ---------------------------------------------------------------------------
// Core guard
// ---------------------------------------------------------------------------

/**
 * Run invariant check on server-produced output data in dev/test only.
 * Returns the data unchanged (same reference, no copy).
 *
 * In production: no-op (returns data immediately, check never called).
 * In development/test: runs check(data) and throws if it throws.
 */
export function assertOutput<T>(data: T, check: (data: T) => void): T {
  if (process.env['NODE_ENV'] !== 'production') {
    check(data);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Extracted invariant: V2BlockerReportSchema.superRefine
// ---------------------------------------------------------------------------

// Mirrors the pointer type from output-schemas.ts -- kept local to avoid import
// coupling. The type is structural (not nominal) so duck-typing works.
type BlockerPointer =
  | { readonly kind: 'context_key'; readonly key: string }
  | { readonly kind: 'context_budget' }
  | { readonly kind: 'output_contract'; readonly contractRef: string }
  | { readonly kind: 'capability'; readonly capability: string }
  | { readonly kind: 'assessment_dimension'; readonly assessmentId: string; readonly dimensionId: string }
  | { readonly kind: 'workflow_step'; readonly stepId: string };

type BlockerLike = {
  readonly code: string;
  readonly pointer: BlockerPointer;
};

type BlockerReportLike = {
  readonly blockers: readonly BlockerLike[];
};

/**
 * Assert that blockers in a report are sorted by their composite key.
 *
 * This is the invariant from V2BlockerReportSchema.superRefine: duplicate-key
 * detection and deterministic ordering. Runs in dev/test only via assertOutput().
 *
 * Throws if blockers are not sorted ascending by composite key.
 */
export function assertBlockerReportInvariants(report: BlockerReportLike): void {
  const keyFor = (b: BlockerLike): string => {
    const p = b.pointer;
    let ptrStable: string;
    switch (p.kind) {
      case 'context_key':
        ptrStable = p.key;
        break;
      case 'output_contract':
        ptrStable = p.contractRef;
        break;
      case 'capability':
        ptrStable = p.capability;
        break;
      case 'assessment_dimension':
        ptrStable = `${p.assessmentId}|${p.dimensionId}`;
        break;
      case 'workflow_step':
        ptrStable = p.stepId;
        break;
      case 'context_budget':
        ptrStable = '';
        break;
      default: {
        const _exhaustive: never = p;
        ptrStable = String(_exhaustive);
      }
    }
    return `${b.code}|${p.kind}|${String(ptrStable)}`;
  };

  for (let i = 1; i < report.blockers.length; i++) {
    if (keyFor(report.blockers[i - 1]!) > keyFor(report.blockers[i]!)) {
      throw new Error('assertOutput: blockers must be deterministically sorted by composite key');
    }
  }
}

// ---------------------------------------------------------------------------
// Extracted invariant: V2ContinueWorkflowOutputSchema.refine and V2StartWorkflowOutputSchema.refine
// ---------------------------------------------------------------------------

type PendingLike = { readonly stepId: string } | null;

type ContinueTokenHolder = {
  readonly continueToken?: string | null | undefined;
  readonly pending: PendingLike;
};

/**
 * Assert that continueToken is present when a pending step exists.
 *
 * This is the invariant from the .refine() on V2ContinueWorkflowOutputSchema
 * and V2StartWorkflowOutputSchema. Runs in dev/test only via assertOutput().
 *
 * Throws if pending is non-null but continueToken is absent.
 */
export function assertContinueTokenPresence(data: ContinueTokenHolder): void {
  if (data.pending != null && data.continueToken == null) {
    throw new Error('assertOutput: continueToken is required when a pending step exists');
  }
}
