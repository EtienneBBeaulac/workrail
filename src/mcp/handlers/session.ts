/**
 * Session Tool Handlers
 *
 * Pure functions that handle session tool invocations.
 * Each handler receives typed input and context, returns ToolResult<T>.
 */

import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { request } from 'http';
import type { ToolContext, ToolResult } from '../types.js';
import { success, errNotRetryable } from '../types.js';
import type {
  CreateSessionInput,
  UpdateSessionInput,
  ReadSessionInput,
  OpenDashboardInput,
} from '../tools.js';
import { DEFAULT_CONSOLE_PORT } from '../../infrastructure/console-defaults.js';

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
  guidance?: string;
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
 *
 * Only checks for sessionManager -- HttpServer is no longer part of the MCP
 * server. The dashboard is served by `worktrain console` independently.
 */
function requireSessionTools(ctx: ToolContext): ToolResult<never> | null {
  if (!ctx.sessionManager) {
    return errNotRetryable(
      'PRECONDITION_FAILED',
      'Session tools are not enabled',
      { suggestion: 'Set WORKRAIL_ENABLE_SESSION_TOOLS=true to enable session tools' }
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

  const sessionManager = ctx.sessionManager!;

  const res = await sessionManager.createSession(
    input.workflowId,
    input.sessionId,
    input.initialData
  );

  if (res.isErr()) {
    return errNotRetryable('INTERNAL_ERROR', res.error.message);
  }

  const session = res.value;

  let port = DEFAULT_CONSOLE_PORT;
  try {
    const lock = await readConsoleLock();
    if (lock) {
      port = lock.port;
    }
  } catch {
    // Ignore and use default
  }
  const dashboardUrl = `http://localhost:${port}?session=${input.sessionId}`;

  const payload: CreateSessionOutput = {
    sessionId: session.id,
    workflowId: session.workflowId,
    path: sessionManager.getSessionPath(input.workflowId, input.sessionId),
    dashboardUrl,
    createdAt: session.createdAt,
  };
  return success(payload);
}

export async function handleUpdateSession(
  input: UpdateSessionInput,
  ctx: ToolContext
): Promise<ToolResult<UpdateSessionOutput>> {
  const guardError = requireSessionTools(ctx);
  if (guardError) return guardError;

  const sessionManager = ctx.sessionManager!;

  const res = await sessionManager.updateSession(
    input.workflowId,
    input.sessionId,
    input.updates
  );

  if (res.isErr()) {
    if (res.error.code === 'SESSION_NOT_FOUND') {
      return errNotRetryable('NOT_FOUND', res.error.message, {
        suggestion: 'Make sure the session exists. Use workrail_create_session() first.',
      });
    }
    return errNotRetryable('INTERNAL_ERROR', res.error.message);
  }

  const payload: UpdateSessionOutput = { updatedAt: new Date().toISOString() };
  return success(payload);
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
    const payload: ReadSessionSchemaOutput = {
      query: '$schema' as const,
      schema: SESSION_SCHEMA_OVERVIEW,
    };
    return success(payload);
  }

  const res = await sessionManager.readSession(
    input.workflowId,
    input.sessionId,
    input.path
  );

  if (res.isErr()) {
    if (res.error.code === 'SESSION_NOT_FOUND') {
      return errNotRetryable('NOT_FOUND', res.error.message, {
        suggestion: 'Make sure the session exists. Use workrail_create_session() first.',
      });
    }
    return errNotRetryable('INTERNAL_ERROR', res.error.message);
  }

  const payload: ReadSessionOutput = {
    query: input.path ?? '(full session)',
    data: res.value,
  };
  return success(payload);
}

interface ConsoleLockInfo {
  pid: number;
  port: number;
}

export function getCliWorktrainPath(): string {
  // Try compiled dist path relative to handlers
  const compiledPath = path.resolve(__dirname, '..', '..', 'cli-worktrain.js');
  try {
    if (existsSync(compiledPath)) {
      return compiledPath;
    }
    // Try source-tree path pointing to compiled dist
    const devPath = path.resolve(__dirname, '..', '..', '..', 'dist', 'cli-worktrain.js');
    if (existsSync(devPath)) {
      return devPath;
    }
  } catch {
    // Fallback
  }
  return compiledPath;
}

async function readConsoleLock(): Promise<ConsoleLockInfo | null> {
  const lockPath = path.join(os.homedir(), '.workrail', 'daemon-console.lock');
  try {
    const raw = await fs.readFile(lockPath, 'utf-8');
    const data = JSON.parse(raw);
    if (
      data &&
      typeof data === 'object' &&
      typeof data.pid === 'number' &&
      typeof data.port === 'number'
    ) {
      return data as ConsoleLockInfo;
    }
  } catch {
    // Ignore, lock doesn't exist or is invalid
  }
  return null;
}

function isPidAlive(pid: number): boolean {
  if (process.platform === 'win32') {
    return true; // Signal 0 is not emulated on Windows; let ping check handle liveness
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM'; // Process exists but we lack signal permissions
  }
}

async function pingConsolePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/v2/sessions',
        method: 'GET',
        timeout: 400, // Very fast local ping
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

export async function autoBootConsoleBackground(options?: { forceSpawnInTest?: boolean }): Promise<void> {
  if ((process.env.VITEST || process.env.NODE_ENV === 'test') && !options?.forceSpawnInTest) {
    return;
  }
  try {
    const lock = await readConsoleLock();
    if (lock && isPidAlive(lock.pid)) {
      const active = await pingConsolePort(lock.port);
      if (active) {
        return; // Alive and listening -- skip spawn
      }
    }
    const cliPath = getCliWorktrainPath();
    const child = spawn(process.execPath, [cliPath, 'console'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (err: any) {
    try {
      process.stderr.write(`[ConsoleAutoBoot] Warning: Failed to spawn console background: ${err?.message || err}\n`);
    } catch {
      // Ignored
    }
  }
}

export async function handleOpenDashboard(
  input: OpenDashboardInput,
  ctx: ToolContext
): Promise<ToolResult<OpenDashboardOutput>> {
  const guardError = requireSessionTools(ctx);
  if (guardError) return guardError;

  let active = false;
  let port = DEFAULT_CONSOLE_PORT;

  try {
    const lock = await readConsoleLock();
    if (lock && isPidAlive(lock.pid)) {
      active = await pingConsolePort(lock.port);
      if (active) {
        port = lock.port;
      }
    }

    if (!active) {
      // Spawn console in the background
      await autoBootConsoleBackground();

      // Poll for up to 2 seconds (20 * 100ms) for lock file and liveness
      const startTime = Date.now();
      const timeoutMs = 2000;
      const intervalMs = 100;

      while (Date.now() - startTime < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        const newLock = await readConsoleLock();
        if (newLock && isPidAlive(newLock.pid)) {
          const isUp = await pingConsolePort(newLock.port);
          if (isUp) {
            port = newLock.port;
            active = true;
            break;
          }
        }
      }
    }
  } catch (err: any) {
    try {
      process.stderr.write(`[handleOpenDashboard] Warning: Self-healing lookup failed: ${err?.message || err}\n`);
    } catch {
      // Ignored
    }
  }

  const sessionQuery = input.sessionId ? `?session=${input.sessionId}` : '';
  const url = `http://localhost:${port}${sessionQuery}`;

  const payload: OpenDashboardOutput = {
    url,
    guidance: "Run 'worktrain console' to start the dashboard UI if it's not already running.",
  };
  return success(payload);
}
