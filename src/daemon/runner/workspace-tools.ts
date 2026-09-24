import type { AgentTool } from '../agent-loop.js';
import type { DaemonEventEmitter, RunId } from '../daemon-events.js';
import type { SessionId } from '../../v2/durable-core/ids/index.js';
import type { ReadFileState } from '../types.js';
import { makeBashTool } from '../tools/bash.js';
import { makeReadTool, makeWriteTool, makeEditTool } from '../tools/file-tools.js';
import { makeGlobTool, makeGrepTool } from '../tools/glob-grep.js';

/** Explicit schema slots prevent accidentally requiring workflow-control schemas. */
export interface WorkspaceToolSchemas {
  readonly BashParams: AgentTool['inputSchema'];
  readonly ReadParams: AgentTool['inputSchema'];
  readonly WriteParams: AgentTool['inputSchema'];
  readonly GlobParams: AgentTool['inputSchema'];
  readonly GrepParams: AgentTool['inputSchema'];
  readonly EditParams: AgentTool['inputSchema'];
}

export interface WorkspaceToolContext {
  readonly workspacePath: string;
  readonly readFileState: Map<string, ReadFileState>;
  readonly runId: RunId;
  readonly sessionId: SessionId | null;
  readonly emitter: DaemonEventEmitter | undefined;
}

/** No engine, tokens, spawning or issue-reporting protocol enters this composition.
 * These are ordinary workspace operations, not a filesystem or shell sandbox. */
export function constructWorkspaceTools(context: WorkspaceToolContext, schemas: WorkspaceToolSchemas): readonly AgentTool[] {
  const { workspacePath, readFileState, runId, sessionId, emitter } = context;
  return [
    makeBashTool(workspacePath, schemas, runId, emitter, sessionId),
    makeReadTool(workspacePath, readFileState, schemas, runId, emitter, sessionId),
    makeWriteTool(workspacePath, readFileState, schemas, runId, emitter, sessionId),
    makeGlobTool(workspacePath, schemas, runId, emitter, sessionId),
    makeGrepTool(workspacePath, schemas, runId, emitter, sessionId),
    makeEditTool(workspacePath, readFileState, schemas, runId, emitter, sessionId),
  ];
}
