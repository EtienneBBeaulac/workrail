/**
 * Barrel re-export for src/daemon/runner/.
 *
 * Import boundary: runner/ files may import from io/, state/, core/, tools/,
 * and agent-loop.ts. They must NOT import runWorkflow from workflow-runner.ts
 * at runtime (that would be a circular dependency since workflow-runner.ts
 * calls runner/ functions). This is enforced by the architecture test in
 * tests/unit/architecture-boundaries.test.ts.
 *
 * runWorkflow is imported as `import type { runWorkflow }` in runner/ files --
 * type-only, erased at compile time, no runtime circular dependency.
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
export { constructTools } from './construct-tools.js';
export { finalizeSession } from './finalize-session.js';
export { buildPreAgentSession } from './pre-agent-session.js';
export type { TurnEndSubscriberContext } from './agent-loop-runner.js';
export {
  buildTurnEndSubscriber,
  buildAgentCallbacks,
  buildAgentReadySession,
  runAgentLoop,
} from './agent-loop-runner.js';
