import type { Result } from '../runtime/result.js';

/**
 * Typed task descriptor -- the assembler uses the kind discriminant to decide
 * which sources to query. Validate at entry, trust inside the assembler.
 */
export type AssemblyTask =
  | {
      readonly kind: 'pr_review';
      readonly prNumber: number;
      readonly workspacePath: string;
      /** PR description body text (from webhook payload), for future URL extraction. */
      readonly payloadBody?: string;
    }
  | {
      readonly kind: 'coding_task';
      readonly issueNumber?: number;
      readonly workspacePath: string;
      readonly payloadBody?: string;
    };

/**
 * A single prior session note extracted from the session summary store.
 * Maps directly to fields on HealthySessionSummary from LocalSessionSummaryProviderV2.
 */
export interface SessionNote {
  readonly sessionId: string;
  /** Aggregated recap from tip node and ancestors. Null if session has no recap. */
  readonly recapSnippet: string | null;
  /** Derived session title from context fields or first recap line. */
  readonly sessionTitle: string | null;
  /** Git branch observed during that session. */
  readonly gitBranch: string | null;
  /** Filesystem mtime for the session directory (epoch ms). */
  readonly lastModifiedMs: number;
}

/**
 * Assembled context bundle -- returned by ContextAssembler.assemble().
 *
 * Each source field is a Result<T, string> so a single source failure does NOT
 * block other sources. The coordinator renders only the ok() fields.
 */
export interface ContextBundle {
  readonly task: AssemblyTask;
  /**
   * Output of `gh pr diff --name-only <prNumber>` (for pr_review) or
   * `git diff HEAD~1 --stat` (fallback). File names and change counts only.
   */
  readonly gitDiff: Result<string, string>;
  /**
   * Prior session notes for this workspace, newest-first, capped at `limit`.
   */
  readonly priorSessionNotes: Result<readonly SessionNote[], string>;
  /** ISO 8601 timestamp of assembly. */
  readonly assembledAt: string;
}

/**
 * Rendering options stub -- empty in v1. Kept as explicit interface to
 * preserve the extension point without implementing it.
 */
export interface RenderOpts {
  // v1: empty -- populated when coordinators need different rendering
}

/**
 * ContextAssembler service interface.
 * Inject into CoordinatorDeps as an optional field.
 */
export interface ContextAssembler {
  assemble(task: AssemblyTask): Promise<ContextBundle>;
}
