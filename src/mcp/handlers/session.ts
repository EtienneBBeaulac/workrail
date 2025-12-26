/**
 * Session Tool Handlers
 *
 * Pure functions that handle session tool invocations.
 * Each handler receives typed input and context, returns ToolResult<T>.
 */

import type { ToolContext, ToolResult } from '../types.js';
import { success, error } from '../types.js';
import {
  CreateSessionOutputSchema,
  OpenDashboardOutputSchema,
  ReadSessionOutputSchema,
  ReadSessionSchemaOutputSchema,
  UpdateSessionOutputSchema,
} from '../output-schemas.js';
import { mapUnknownErrorToToolError } from '../error-mapper.js';
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

export interface SchemaOverview {
  description: string;
  mainSections: Record<string, string>;
  commonQueries: Record<string, string>;
  updatePatterns: Record<string, string>;
  fullSchemaDoc: string;
}

export interface ReadSessionSchemaOutput {
  query: '$schema';
  schema: SchemaOverview;
}

export interface OpenDashboardOutput {
  url: string;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const SESSION_SCHEMA_OVERVIEW: SchemaOverview = {
  description: 'Bug Investigation Session Data Structure',
  mainSections: {
    dashboard: 'Real-time UI display (progress, confidence, currentPhase, status)',
    bugSummary: 'Initial bug context (title, description, impact, reproduction)',
    phases: 'Detailed phase progress (phase-0, phase-1, etc.)',
    hypotheses: 'Array of investigation theories with status tracking',
    ruledOut: 'Array of rejected hypotheses',
    timeline: 'Array of timestamped events',
    confidenceJourney: 'Array of confidence changes over time',
    codebaseMap: 'Spatial understanding of components (optional)',
    rootCause: 'Final diagnosis (set in Phase 6)',
    fix: 'Proposed solution (set in Phase 6)',
    recommendations: 'Future prevention steps (set in Phase 6)',
    metadata: 'Technical details (workflowVersion, projectType, etc.)',
  },
  commonQueries: {
    'dashboard': 'Get all dashboard fields',
    'dashboard.progress': 'Get just progress percentage',
    'timeline': 'Get all timeline events',
    'hypotheses': 'Get all hypotheses',
    'hypotheses[0]': 'Get first hypothesis',
    'phases.phase-1': 'Get Phase 1 data',
    'confidenceJourney': 'Get confidence history',
  },
  updatePatterns: {
    incrementalProgress: 'workrail_update_session(wf, id, {"dashboard.progress": 35, "dashboard.currentPhase": "Phase 2"})',
    addTimelineEvent: 'Read timeline array, append event, write back',
    updateConfidence: 'Update both dashboard.confidence AND confidenceJourney array',
    completePhase: 'Set phases.phase-X.complete = true and add summary',
  },
  fullSchemaDoc: 'See docs/dashboard-architecture/bug-investigation-session-schema.md for complete details',
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Guard that checks if session tools are available.
 * Returns an error result if they're not.
 */
function requireSessionTools(ctx: ToolContext): ToolResult<never> | null {
  if (!ctx.sessionManager || !ctx.httpServer) {
    return error(
      'PRECONDITION_FAILED',
      'Session tools are not enabled',
      'Set WORKRAIL_ENABLE_SESSION_TOOLS=true to enable session tools'
    );
  }
  return null;
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

export async function handleCreateSession(
  input: CreateSessionInput,
  ctx: ToolContext
): Promise<ToolResult<CreateSessionOutput>> {
  const guardError = requireSessionTools(ctx);
  if (guardError) return guardError;

  // TypeScript now knows these are not null
  const sessionManager = ctx.sessionManager!;
  const httpServer = ctx.httpServer!;

  try {
    const session = await sessionManager.createSession(
      input.workflowId,
      input.sessionId,
      input.initialData
    );

    const baseUrl = httpServer.getBaseUrl();
    const dashboardUrl = baseUrl ? `${baseUrl}?session=${input.sessionId}` : null;

    const payload = CreateSessionOutputSchema.parse({
      sessionId: session.id,
      workflowId: session.workflowId,
      path: sessionManager.getSessionPath(input.workflowId, input.sessionId),
      dashboardUrl,
      createdAt: session.createdAt,
    });
    return success(payload);
  } catch (err) {
    const mapped = mapUnknownErrorToToolError(err);
    return mapped;
  }
}

export async function handleUpdateSession(
  input: UpdateSessionInput,
  ctx: ToolContext
): Promise<ToolResult<UpdateSessionOutput>> {
  const guardError = requireSessionTools(ctx);
  if (guardError) return guardError;

  const sessionManager = ctx.sessionManager!;

  try {
    await sessionManager.updateSession(
      input.workflowId,
      input.sessionId,
      input.updates
    );

    const payload = UpdateSessionOutputSchema.parse({ updatedAt: new Date().toISOString() });
    return success(payload);
  } catch (err) {
    // Check for SessionManager "not found" errors via error name/type (preferred) or message fallback
    // TODO: SessionManager should return typed Result errors instead of throwing
    if (err instanceof Error && (
      err.name === 'SessionNotFoundError' ||
      err.message.toLowerCase().includes('not found') ||
      err.message.toLowerCase().includes('does not exist')
    )) {
      return {
        type: 'error',
        code: 'NOT_FOUND',
        message: err.message,
        retry: { kind: 'not_retryable' },
        details: { suggestion: 'Make sure the session exists. Use workrail_create_session() first.' },
      };
    }

    const mapped = mapUnknownErrorToToolError(err);
    return mapped;
  }
}

export async function handleReadSession(
  input: ReadSessionInput,
  ctx: ToolContext
): Promise<ToolResult<ReadSessionOutput | ReadSessionSchemaOutput>> {
  const guardError = requireSessionTools(ctx);
  if (guardError) return guardError;

  const sessionManager = ctx.sessionManager!;

  // Special case: $schema returns structure overview
  if (input.path === '$schema') {
    const payload = ReadSessionSchemaOutputSchema.parse({
      query: '$schema' as const,
      schema: SESSION_SCHEMA_OVERVIEW,
    });
    return success(payload);
  }

  try {
    const data = await sessionManager.readSession(
      input.workflowId,
      input.sessionId,
      input.path
    );

    const payload = ReadSessionOutputSchema.parse({
      query: input.path ?? '(full session)',
      data,
    });
    return success(payload);
  } catch (err) {
    // Check for SessionManager "not found" errors via error name/type (preferred) or message fallback
    // TODO: SessionManager should return typed Result errors instead of throwing
    if (err instanceof Error && (
      err.name === 'SessionNotFoundError' ||
      err.message.toLowerCase().includes('not found') ||
      err.message.toLowerCase().includes('does not exist')
    )) {
      return {
        type: 'error',
        code: 'NOT_FOUND',
        message: err.message,
        retry: { kind: 'not_retryable' },
        details: { suggestion: 'Make sure the session exists. Use workrail_create_session() first.' },
      };
    }

    const mapped = mapUnknownErrorToToolError(err);
    return mapped;
  }
}

export async function handleOpenDashboard(
  input: OpenDashboardInput,
  ctx: ToolContext
): Promise<ToolResult<OpenDashboardOutput>> {
  const guardError = requireSessionTools(ctx);
  if (guardError) return guardError;

  const httpServer = ctx.httpServer!;

  try {
    const url = await httpServer.openDashboard(input.sessionId);

    const payload = OpenDashboardOutputSchema.parse({ url });
    return success(payload);
  } catch (err) {
    const mapped = mapUnknownErrorToToolError(err);
    return mapped;
  }
}
