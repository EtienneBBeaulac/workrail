/**
 * Console API routes — read-only endpoints for the v2 Console UI.
 *
 * All routes are GET-only (invariant: Console is read-only).
 * Response shape: { success: true, data: T } | { success: false, error: string }
 * (matches existing HttpServer.ts pattern)
 */
import express from 'express';
import type { Application, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import type { ConsoleService } from './console-service.js';

/**
 * Resolve the console dist directory.
 * Works both from source (src/) and from compiled output (dist/).
 */
function resolveConsoleDist(): string | null {
  // From compiled dist/v2/usecases/ -> ../../../console/dist
  const fromDist = path.join(__dirname, '../../../console/dist');
  if (fs.existsSync(fromDist)) return fromDist;

  // From source src/v2/usecases/ -> ../../../console/dist
  const fromSrc = path.join(__dirname, '../../../console/dist');
  if (fs.existsSync(fromSrc)) return fromSrc;

  return null;
}

export function mountConsoleRoutes(app: Application, consoleService: ConsoleService): void {
  // --- API routes ---

  // List all v2 sessions
  app.get('/api/v2/sessions', async (_req: Request, res: Response) => {
    const result = await consoleService.getSessionList();
    result.match(
      (data) => res.json({ success: true, data }),
      (error) => res.status(500).json({ success: false, error: error.message }),
    );
  });

  // Get session detail with full DAG
  app.get('/api/v2/sessions/:sessionId', async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const result = await consoleService.getSessionDetail(sessionId);
    result.match(
      (data) => res.json({ success: true, data }),
      (error) => {
        const status = error.code === 'SESSION_LOAD_FAILED' ? 404 : 500;
        res.status(status).json({ success: false, error: error.message });
      },
    );
  });

  // --- Static file serving for Console UI ---

  const consoleDist = resolveConsoleDist();
  if (consoleDist) {
    // Serve console static assets under /console
    app.use('/console', express.static(consoleDist));

    // SPA catch-all: any /console/* route serves index.html
    // (lets React handle client-side routing)
    app.get('/console/*', (_req: Request, res: Response) => {
      res.sendFile(path.join(consoleDist, 'index.html'));
    });

    console.error(`[Console] UI serving from ${consoleDist}`);
  } else {
    // No built console -- serve a helpful message
    app.get('/console', (_req: Request, res: Response) => {
      res.status(503).json({
        error: 'Console not built',
        message: 'Run "cd console && npm run build" to build the Console UI.',
      });
    });
    console.error('[Console] UI not found (run: cd console && npm run build)');
  }
}
