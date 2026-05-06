/**
 * Context loading abstractions for WorkTrain daemon sessions.
 *
 * WHY this module exists: `runWorkflow()` loads context in two phases:
 *   Phase 1 (loadBase): soul + workspace -- both are independent of the WorkRail session
 *     token and can run concurrently with `buildPreAgentSession()`.
 *   Phase 2 (loadSession): session notes -- requires the `startContinueToken` from
 *     `buildPreAgentSession()` to decode the session ID.
 *
 * Separating these phases into a typed interface (`ContextLoader`) and a concrete
 * implementation (`DefaultContextLoader`) makes the concurrency boundary explicit and
 * allows the domain types (`ContextRule`, `SessionNote`, `ContextBundle`) to carry
 * semantic meaning rather than being loose strings in a flat bag.
 *
 * v1 known gaps (documented per YAGNI discipline):
 *   - `ContextRule.truncated`: always `false` in v1. Real truncation happens inside
 *     `loadWorkspaceContext()` which combines content before returning a single string.
 *     A future v2 could return per-file `ContextRule[]` with accurate `truncated` flags.
 *   - `SessionNote.nodeId / stepId`: always empty strings in v1. The projection that
 *     reads step notes (`projectNodeOutputsV2`) has node IDs, but threading them into
 *     the `loadSessionNotes()` return type requires a schema change (GAP-7 territory).
 *     A future v2 could populate these from the projection's `nodesById` keys.
 */

import type { WorkflowTrigger } from './types.js';
import type { V2ToolContext } from '../mcp/types.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/**
 * A single source of workspace context rules, loaded from one file or aggregate.
 *
 * In v1, `source` is always `'workspace-context'` (the aggregate string from
 * `loadWorkspaceContext()`). Future versions may use file paths here to support
 * per-file truncation and selective injection.
 */
export interface ContextRule {
  /**
   * Source identifier for this rule.
   * v1: always `'workspace-context'` (aggregate from loadWorkspaceContext()).
   * Future: absolute file path for per-file rules.
   */
  readonly source: string;
  /** The rule content to inject into the system prompt. */
  readonly content: string;
  /**
   * Whether this rule was truncated due to byte budget limits.
   * v1 known gap: always `false` here. Real truncation happens inside
   * `loadWorkspaceContext()` which appends a notice to the combined string.
   */
  readonly truncated: boolean;
}

/**
 * A single prior step note from the WorkRail session store.
 *
 * In v1, `nodeId` and `stepId` are always empty strings because `loadSessionNotes()`
 * returns a flat `string[]` without node-level metadata. These fields exist to give
 * future versions a stable shape to populate without breaking callers.
 */
export interface SessionNote {
  /**
   * The WorkRail node ID for this note.
   * v1 known gap: always empty string. Future: from projectNodeOutputsV2 nodesById.
   */
  readonly nodeId: string;
  /**
   * The WorkRail step ID for this note.
   * v1 known gap: always empty string. Future: from node step metadata.
   */
  readonly stepId: string;
  /** The note content (already truncated to MAX_SESSION_NOTE_CHARS by loadSessionNotes). */
  readonly content: string;
}

/**
 * Context loaded in Phase 1: soul + workspace.
 *
 * Both fields are available before the WorkRail session token is created.
 * This is the output of `ContextLoader.loadBase()`.
 */
export interface BaseContext {
  /** Content of the daemon soul file (never empty -- falls back to DAEMON_SOUL_DEFAULT). */
  readonly soulContent: string;
  /**
   * Workspace rules from CLAUDE.md / AGENTS.md and other convention files.
   * Empty array when no context files were found (equivalent to old `workspaceContext: null`).
   * v1: at most one element (the aggregate string from loadWorkspaceContext).
   */
  readonly workspaceRules: readonly ContextRule[];
}

/**
 * Full context bundle passed to `buildSessionContext()`.
 *
 * Extends BaseContext with session notes loaded in Phase 2.
 * The `assembledContext` field is deliberately omitted (YAGNI -- no consumer exists).
 *
 * WHY extends BaseContext: Phase 2 adds sessionHistory to the Phase 1 base.
 * The caller always has `BaseContext` available before `loadSession()` runs,
 * so returning `ContextBundle` (not just `SessionNote[]`) makes the complete
 * picture explicit and avoids the caller having to merge two objects.
 */
export interface ContextBundle extends BaseContext {
  /**
   * Prior step notes from the WorkRail session store.
   * Empty array for fresh sessions (no node_output_appended events yet).
   * At most MAX_SESSION_RECAP_NOTES entries for resumed sessions.
   */
  readonly sessionHistory: readonly SessionNote[];
}

// ---------------------------------------------------------------------------
// ContextLoader interface
// ---------------------------------------------------------------------------

/**
 * Abstraction over the two-phase context loading process.
 *
 * WHY an interface (not a standalone function): `DefaultContextLoader` has four
 * injected dependencies (the three loaders + V2ToolContext). An interface makes
 * it clear at the call site in `runWorkflow()` that the loader is a configured
 * object, not a stateless utility.
 */
export interface ContextLoader {
  /**
   * Load Phase 1 context: soul + workspace.
   *
   * Both are independent of the WorkRail session token and can run concurrently
   * with `buildPreAgentSession()`. Uses `trigger.workspacePath` -- NEVER
   * `sessionWorkspacePath`. For worktree sessions, the context files (CLAUDE.md /
   * AGENTS.md) live in the main checkout, not the isolated worktree.
   *
   * Best-effort: the underlying loaders (`loadDaemonSoul`, `loadWorkspaceContext`)
   * catch their own errors and never throw. `loadBase` itself does not add extra
   * error handling on top.
   */
  loadBase(trigger: WorkflowTrigger): Promise<BaseContext>;

  /**
   * Load Phase 2 context: session notes, combined with Phase 1 base.
   *
   * Requires the `startContinueToken` from `buildPreAgentSession()`. Propagates
   * exceptions from `_loadNotes` -- callers must handle errors.
   *
   * WHY propagates (vs swallows): `loadSessionNotes` in `runWorkflow()` was
   * best-effort (catches all errors, returns []). Moving the swallowing INTO
   * DefaultContextLoader would hide errors from the caller. The caller decides
   * the handling policy.
   *
   * @param continueToken - The continueToken from executeStartWorkflow. Pass null
   *   when no token is available (returns ContextBundle with empty sessionHistory).
   * @param base - The BaseContext from `loadBase()`.
   */
  loadSession(continueToken: string | null, base: BaseContext): Promise<ContextBundle>;
}

// ---------------------------------------------------------------------------
// DefaultContextLoader implementation
// ---------------------------------------------------------------------------

/**
 * Concrete implementation of `ContextLoader` that wraps the three helper functions
 * from `workflow-runner.ts` and the shared `V2ToolContext`.
 *
 * WHY constructor injection (not module-level imports): the three loaders
 * (`loadDaemonSoul`, `loadWorkspaceContext`, `loadSessionNotes`) are exported from
 * `workflow-runner.ts` and tested there directly. Injecting them here:
 *   1. Avoids circular imports (context-loader -> workflow-runner -> context-loader).
 *   2. Makes the dependency boundary explicit and testable in isolation.
 *   3. Follows the DI pattern established by `TurnEndSubscriberContext`,
 *      `FinalizationContext`, and `SessionScope`.
 */
export class DefaultContextLoader implements ContextLoader {
  constructor(
    private readonly _loadSoul: (resolvedPath?: string) => Promise<string>,
    private readonly _loadWorkspace: (workspacePath: string) => Promise<string | null>,
    private readonly _loadNotes: (continueToken: string, ctx: V2ToolContext) => Promise<readonly string[]>,
    private readonly _ctx: V2ToolContext,
  ) {}

  async loadBase(trigger: WorkflowTrigger): Promise<BaseContext> {
    // Run soul and workspace loads concurrently -- they are independent.
    // WHY trigger.workspacePath (not sessionWorkspacePath): for worktree sessions,
    // the context files live in the main checkout, not the isolated worktree.
    // trigger.workspacePath is always the main checkout. See runWorkflow() comment.
    const [soulContent, workspaceContextStr] = await Promise.all([
      this._loadSoul(trigger.soulFile),
      this._loadWorkspace(trigger.workspacePath),
    ]);

    // Wrap the aggregate workspace context string as a single ContextRule.
    // v1 known gap: truncated is always false here. Real truncation happens inside
    // loadWorkspaceContext() which appends a notice to the combined string.
    const workspaceRules: readonly ContextRule[] = workspaceContextStr !== null
      ? [{ source: 'workspace-context', content: workspaceContextStr, truncated: false }]
      : [];

    return { soulContent, workspaceRules };
  }

  async loadSession(continueToken: string | null, base: BaseContext): Promise<ContextBundle> {
    // When no continueToken is available (e.g. executeStartWorkflow returned an empty
    // token), return an empty sessionHistory. This matches the previous behavior:
    // `startContinueToken ? loadSessionNotes(startContinueToken, ctx) : Promise.resolve([])`.
    if (!continueToken) {
      return { ...base, sessionHistory: [] };
    }

    // WHY exceptions propagate: the caller (runWorkflow) decides the handling policy.
    // loadSessionNotes is already best-effort internally (catches all errors, returns []).
    // DefaultContextLoader does not add an extra safety net on top.
    const notes = await this._loadNotes(continueToken, this._ctx);

    // Wrap each note as a SessionNote.
    // v1 known gap: nodeId and stepId are always empty strings.
    const sessionHistory: readonly SessionNote[] = notes.map((content) => ({
      nodeId: '',
      stepId: '',
      content,
    }));

    return { ...base, sessionHistory };
  }
}
