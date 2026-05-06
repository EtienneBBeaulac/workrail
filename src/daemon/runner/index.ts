/**
 * Barrel re-export for src/daemon/runner/.
 *
 * Import boundary: runner/ files may import from io/, state/, core/, tools/,
 * and agent-loop.ts. They must NOT import runWorkflow from workflow-runner.ts
 * at runtime (that would be a circular dependency since workflow-runner.ts
 * calls runner/ functions). This is enforced by the architecture test in
 * tests/unit/architecture-boundaries.test.ts.
 *
 * Note: constructTools(), buildPreAgentSession(), buildAgentReadySession(),
 * runAgentLoop(), buildAgentCallbacks(), buildTurnEndSubscriber(), and
 * finalizeSession() remain in workflow-runner.ts pending a follow-on refactor
 * that introduces runWorkflow injection to eliminate the circular dependency.
 */

export { WORKTREES_DIR } from './runner-types.js';
export type {
  PreAgentSession,
  PreAgentSessionResult,
  AgentReadySession,
  SessionOutcome,
  FinalizationContext,

} from './runner-types.js';
export { getSchemas } from './tool-schemas.js';
