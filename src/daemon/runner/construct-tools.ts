/**
 * Tool construction for daemon agent sessions.
 *
 * WHY this module: constructTools() wires all tool factories into a list for
 * the agent loop. It belongs in runner/ (the orchestration layer), not in
 * workflow-runner.ts. With runWorkflowFn injected, there is no runtime circular
 * dependency on workflow-runner.ts.
 *
 * WHY runWorkflowFn is injected: makes this function testable and movable.
 * Without injection, constructTools would need to import runWorkflow from
 * workflow-runner.ts at runtime, creating runner/ -> workflow-runner.ts -> runner/.
 */

import type { AgentTool } from '../agent-loop.js';
import type { V2ToolContext } from '../../mcp/types.js';
import { executeContinueWorkflow } from '../../mcp/handlers/v2-execution/index.js';
import type { SessionScope } from '../session-scope.js';
import { makeContinueWorkflowTool, makeCompleteStepTool } from '../tools/continue-workflow.js';
import { makeBashTool } from '../tools/bash.js';
import { makeReadTool, makeWriteTool, makeEditTool } from '../tools/file-tools.js';
import { makeGlobTool, makeGrepTool } from '../tools/glob-grep.js';
import { makeSpawnAgentTool } from '../tools/spawn-agent.js';
import { makeReportIssueTool } from '../tools/report-issue.js';
import { makeSignalCoordinatorTool } from '../tools/signal-coordinator.js';
import type { runWorkflow } from '../workflow-runner.js';

/**
 * Construct the tool list for a daemon agent session.
 *
 * WHY a named function (not inline in runWorkflow): makes the intentional impurity
 * visible at the call site. The tool closures reference side-effecting callbacks
 * (onAdvance, onComplete, onTokenUpdate, onIssueReported) from scope.
 *
 * WHY scope-only (no PreAgentSession): scope is the complete typed boundary for
 * everything constructTools needs. No field on state is read or written here.
 * All values come from scope's explicit, named fields.
 *
 * WHY not exported: this is an internal construction detail. Tests exercise tool
 * behavior through runWorkflow() integration paths.
 */
export function constructTools(
  ctx: V2ToolContext,
  apiKey: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schemas: Record<string, any>,
  scope: SessionScope,
  /**
   * Injectable runWorkflow implementation.
   * WHY injected: breaks the circular import that would arise if this module
   * imported runWorkflow directly from workflow-runner.ts.
   */
  runWorkflowFn: typeof runWorkflow,
): readonly AgentTool[] {
  const {
    fileTracker, onAdvance, onComplete, onTokenUpdate, onIssueReported,
    getCurrentToken, sessionWorkspacePath, spawnCurrentDepth, spawnMaxDepth,
    emitter, activeSessionSet,
  } = scope;
  const sid = scope.sessionId;
  const workrailSid = scope.workrailSessionId;
  // WHY toMap(): tool factories (makeReadTool, makeWriteTool, makeEditTool) accept
  // Map<string, ReadFileState> directly. Their public signatures cannot change because
  // tests call them directly with Maps. toMap() returns the same Map instance the
  // tracker uses internally, so read-before-write checks remain valid.
  const readFileStateMap = fileTracker.toMap();

  return [
    makeCompleteStepTool(
      sid,
      ctx,
      getCurrentToken,
      onAdvance,
      onComplete,
      onTokenUpdate,
      schemas,
      executeContinueWorkflow,
      emitter,
      workrailSid,
    ),
    makeContinueWorkflowTool(sid, ctx, onAdvance, onComplete, schemas, executeContinueWorkflow, emitter, workrailSid),
    // WHY sessionWorkspacePath: when branchStrategy === 'worktree', all agent file operations
    // must target the isolated worktree, not the main checkout.
    makeBashTool(sessionWorkspacePath, schemas, sid, emitter, workrailSid),
    makeReadTool(sessionWorkspacePath, readFileStateMap, schemas, sid, emitter, workrailSid),
    makeWriteTool(sessionWorkspacePath, readFileStateMap, schemas, sid, emitter, workrailSid),
    makeGlobTool(sessionWorkspacePath, schemas, sid, emitter, workrailSid),
    makeGrepTool(sessionWorkspacePath, schemas, sid, emitter, workrailSid),
    makeEditTool(sessionWorkspacePath, readFileStateMap, schemas, sid, emitter, workrailSid),
    makeReportIssueTool(sid, emitter, workrailSid, undefined, onIssueReported),
    makeSpawnAgentTool(
      sid,
      ctx,
      apiKey,
      workrailSid ?? '',
      spawnCurrentDepth,
      spawnMaxDepth,
      runWorkflowFn,
      schemas,
      emitter,
      activeSessionSet,
    ),
    makeSignalCoordinatorTool(sid, emitter, workrailSid),
  ];
}
