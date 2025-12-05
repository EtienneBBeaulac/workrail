/**
 * Session Tool Handlers
 *
 * Pure functions that handle session tool invocations.
 * Each handler receives typed input and context, returns ToolResult<T>.
 *
 * Implementation pending Phase 3.
 */

import type {
  ToolContext,
  ToolResult,
} from '../types.js';
import type {
  CreateSessionInput,
  UpdateSessionInput,
  ReadSessionInput,
  OpenDashboardInput,
} from '../tools.js';

// -----------------------------------------------------------------------------
// Output Types
// -----------------------------------------------------------------------------

export interface CreateSessionOutput {
  sessionId: string;
  workflowId: string;
  path: string;
  dashboardUrl: string | null;
  createdAt: string;
}

export interface UpdateSessionOutput {
  updatedAt: string;
}

export interface ReadSessionOutput {
  query: string;
  data: unknown;
}

export interface OpenDashboardOutput {
  url: string;
}

// -----------------------------------------------------------------------------
// Handlers (Implementation in Phase 3)
// -----------------------------------------------------------------------------

export async function handleCreateSession(
  _input: CreateSessionInput,
  _ctx: ToolContext
): Promise<ToolResult<CreateSessionOutput>> {
  throw new Error('Not implemented - Phase 3');
}

export async function handleUpdateSession(
  _input: UpdateSessionInput,
  _ctx: ToolContext
): Promise<ToolResult<UpdateSessionOutput>> {
  throw new Error('Not implemented - Phase 3');
}

export async function handleReadSession(
  _input: ReadSessionInput,
  _ctx: ToolContext
): Promise<ToolResult<ReadSessionOutput>> {
  throw new Error('Not implemented - Phase 3');
}

export async function handleOpenDashboard(
  _input: OpenDashboardInput,
  _ctx: ToolContext
): Promise<ToolResult<OpenDashboardOutput>> {
  throw new Error('Not implemented - Phase 3');
}
