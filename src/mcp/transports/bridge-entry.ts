/**
 * Bridge transport entry point for WorkRail MCP server.
 *
 * When a healthy primary WorkRail server is already running on the MCP HTTP
 * port, secondary instances (firebender worktrees, additional Claude Code
 * sessions, any other IDE integration) start in bridge mode rather than
 * spinning up a full second server.
 *
 * The bridge is a thin, stateless stdio↔HTTP proxy:
 *   IDE/firebender (stdio) ←→ WorkRail bridge ←→ primary WorkRail (:3100)
 *
 * PRIMARY DEATH + AUTOMATIC RESPAWN
 * When the primary dies, all bridges detect the closure simultaneously via
 * httpTransport.onclose. Each bridge:
 *   1. Tries to reconnect with exponential backoff.
 *   2. If reconnection fails, exits cleanly.
 *
 * The IDE client (Claude Code, firebender) automatically restarts the MCP
 * command on exit. The restarted process calls detectHealthyPrimary():
 *   - If another bridge already became primary: it bridges to it.
 *   - If no primary exists yet: it starts as the full primary (server +
 *     dashboard) and wins the lock election.
 *
 * The existing lock mechanism in HttpServer handles the multi-bridge election
 * race atomically — no coordination between bridges is needed.
 *
 * DETECTION
 * Uses /workrail-health (added to http-entry.ts) rather than a generic
 * HTTP check, so a non-WorkRail server on port 3100 is never mistaken for
 * a primary.
 */

import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** Max reconnect attempts before giving up and exiting. */
const RECONNECT_MAX_ATTEMPTS = 8;
/** Base delay (ms) for exponential backoff. Doubles each attempt: 250 500 1000 2000 4000... */
const RECONNECT_BASE_DELAY_MS = 250;
/** Warning threshold for slow primary responses (ms). */
const FORWARD_TIMEOUT_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Check whether a healthy WorkRail MCP server is accepting connections on
 * the given port. Uses the /workrail-health endpoint so an unrelated HTTP
 * server on the same port is never mistaken for a WorkRail primary.
 *
 * @param retries  Number of attempts (default 3). Attempts use linear backoff.
 * @param baseDelayMs  Base delay between attempts (default 200ms).
 */
export async function detectHealthyPrimary(
  port: number,
  opts: { retries?: number; baseDelayMs?: number } = {},
): Promise<number | null> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 200;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(`http://localhost:${port}/workrail-health`, {
        method: 'GET',
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) {
        const body = (await response.json().catch(() => null)) as { service?: string } | null;
        if (body?.service === 'workrail') {
          return port;
        }
      }
    } catch {
      // Connection refused or timeout — primary not available yet.
    }
    if (attempt < retries - 1) {
      await sleep(baseDelayMs * (attempt + 1)); // linear: 200ms, 400ms, 600ms
    }
  }
  return null;
}

export async function startBridgeServer(primaryPort: number): Promise<void> {
  console.error(`[Bridge] Forwarding stdio → http://localhost:${primaryPort}/mcp`);

  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  );

  const stdioTransport = new StdioServerTransport();
  let shuttingDown = false;
  let isReconnecting = false;

  // Build a fresh HTTP transport and wire it to the stdio side.
  // Called on initial connect and on every successful reconnect.
  const buildHttpTransport = () => {
    const t = new StreamableHTTPClientTransport(
      new URL(`http://localhost:${primaryPort}/mcp`),
    );

    t.onerror = (err) => console.error('[Bridge] HTTP error:', err);

    // Primary → IDE
    t.onmessage = (msg: JSONRPCMessage) => {
      void stdioTransport.send(msg).catch((err) => {
        console.error('[Bridge] Forward to IDE failed:', err);
      });
    };

    return t;
  };

  // ---- Reconnect loop --------------------------------------------------------

  let httpTransport = buildHttpTransport();

  const handlePrimaryClose = () => {
    if (shuttingDown) return;
    isReconnecting = true;
    console.error('[Bridge] Primary connection lost — reconnecting with backoff');

    void (async () => {
      for (let attempt = 0; attempt < RECONNECT_MAX_ATTEMPTS; attempt++) {
        const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt);
        await sleep(delay); // 250 500 1000 2000 4000 8000 16000 32000ms
        if (shuttingDown) return;

        const detected = await detectHealthyPrimary(primaryPort, { retries: 1 });
        if (detected != null) {
          try {
            httpTransport = buildHttpTransport();
            httpTransport.onclose = handlePrimaryClose;
            await httpTransport.start();
            isReconnecting = false;
            console.error(`[Bridge] Reconnected to primary (attempt ${attempt + 1})`);
            return;
          } catch {
            // New transport failed to connect; keep retrying.
          }
        }
      }

      // All reconnect attempts exhausted. Exit cleanly so the IDE client
      // restarts the command — the restarted process will either bridge to a
      // new primary (if another bridge elected itself) or become the primary.
      console.error('[Bridge] Primary unresponsive after all retries — exiting for IDE respawn');
      process.exit(0);
    })();
  };

  httpTransport.onclose = handlePrimaryClose;

  // ---- Initial connection ----------------------------------------------------

  await httpTransport.start();
  console.error('[Bridge] Connected to primary');

  // ---- Message routing: IDE → primary ----------------------------------------

  stdioTransport.onmessage = (msg: JSONRPCMessage) => {
    const currentTransport = httpTransport;

    // If the primary is down and we are in the reconnect window, reply with a
    // clear JSON-RPC error immediately so the agent doesn't hang waiting for a
    // timeout. The message includes actionable instructions for both the agent
    // and the human user.
    //
    // Detection: httpTransport.onclose sets a reconnecting flag. We check it
    // via a simple module-level variable. Using the transport reference works
    // too but the flag is more explicit.
    if (isReconnecting) {
      const req = msg as { id?: string | number };
      if (req.id != null) {
        void stdioTransport
          .send({
            jsonrpc: '2.0',
            id: req.id,
            error: {
              code: -32603,
              message:
                'WorkRail primary server is temporarily unavailable — reconnecting. ' +
                'Wait a few seconds and retry your tool call. ' +
                'If this persists, please tell the user: ' +
                '"WorkRail disconnected. Check the terminal running workrail for the error message, ' +
                'then run /mcp in Claude to reconnect."',
            },
          } as JSONRPCMessage)
          .catch(() => undefined);
      }
      return;
    }

    const timer = setTimeout(() => {
      console.error('[Bridge] Warning: no response from primary after', FORWARD_TIMEOUT_MS, 'ms');
    }, FORWARD_TIMEOUT_MS);

    void currentTransport
      .send(msg)
      .catch((err) => console.error('[Bridge] Forward to primary failed:', err))
      .finally(() => clearTimeout(timer));
  };

  stdioTransport.onerror = (err) => console.error('[Bridge] Stdio error:', err);

  // ---- Stdout guard (same rationale as stdio-entry.ts) -----------------------

  process.stdout.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
      console.error('[Bridge] stdout pipe broken, shutting down');
    } else {
      console.error('[Bridge] stdout error:', err);
    }
    shuttingDown = true;
    void httpTransport.close().finally(() => process.exit(0));
  });

  await stdioTransport.start();
  console.error('[Bridge] WorkRail MCP bridge running on stdio');

  // ---- Shutdown hooks --------------------------------------------------------

  process.stdin.once('end', () => {
    console.error('[Bridge] stdin closed, shutting down');
    shuttingDown = true;
    void httpTransport.close().finally(() => process.exit(0));
  });

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[Bridge] Received ${signal}, shutting down`);
    void httpTransport.close().finally(() => process.exit(0));
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGHUP', () => shutdown('SIGHUP'));
}
