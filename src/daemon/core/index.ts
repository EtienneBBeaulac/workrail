/**
 * Barrel re-export for src/daemon/core/.
 *
 * WHY a barrel: allows callers to import from './core/index.js' rather than
 * knowing which sub-module owns each symbol.
 *
 * Import boundary: all files in core/ (except agent-client.ts) must have
 * no node: or @anthropic-ai/* imports. This is enforced by the architecture
 * test in tests/unit/architecture-boundaries.test.ts.
 */

export { BASE_SYSTEM_PROMPT, buildSessionRecap, buildSystemPrompt, DAEMON_SOUL_DEFAULT } from './system-prompt.js';
export type { SessionContext } from './session-context.js';
export {
  DEFAULT_SESSION_TIMEOUT_MINUTES,
  DEFAULT_MAX_TURNS,
  DEFAULT_STALL_TIMEOUT_SECONDS,
  buildSessionContext,
} from './session-context.js';
export type { SidecarLifecycle } from './session-result.js';
export { tagToStatsOutcome, sidecardLifecycleFor, buildSessionResult } from './session-result.js';
export { buildAgentClient } from './agent-client.js';
