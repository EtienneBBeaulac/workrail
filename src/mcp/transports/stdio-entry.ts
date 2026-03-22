/**
 * stdio transport entry point for WorkRail MCP server.
 * 
 * This is the existing IDE/Firebender use case — connects to the agent
 * over stdin/stdout. Supports workspace roots via MCP roots/list protocol.
 */

import { composeServer } from '../server.js';
import { wireShutdownHooks, wireStdinShutdown } from './shutdown-hooks.js';

export async function startStdioServer(): Promise<void> {
  const { server, ctx, rootsManager } = await composeServer();

  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const {
    RootsListChangedNotificationSchema,
  } = await import('@modelcontextprotocol/sdk/types.js');

  // -------------------------------------------------------------------------
  // stdio-specific: Handle root change notifications from the IDE client
  // -------------------------------------------------------------------------
  server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    try {
      const result = await server.listRoots();
      rootsManager.updateRootUris(result.roots.map((r: { uri: string }) => r.uri));
      console.error(`[Roots] Updated workspace roots: ${result.roots.map((r: { uri: string }) => r.uri).join(', ') || '(none)'}`);
    } catch {
      console.error('[Roots] Failed to fetch updated roots after change notification');
    }
  });

  // -------------------------------------------------------------------------
  // stdio-specific: Connect transport
  // -------------------------------------------------------------------------
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // -------------------------------------------------------------------------
  // stdio-specific: Fetch initial workspace roots from the IDE client
  // -------------------------------------------------------------------------
  try {
    const result = await server.listRoots();
    rootsManager.updateRootUris(result.roots.map((r: { uri: string }) => r.uri));
    console.error(`[Roots] Initial workspace roots: ${result.roots.map((r: { uri: string }) => r.uri).join(', ') || '(none)'}`);
  } catch {
    console.error('[Roots] Client does not support roots/list; workspace context will use server CWD fallback');
  }

  console.error('[Transport] WorkRail MCP Server running on stdio');

  // -------------------------------------------------------------------------
  // Shutdown hooks (shared + stdio-specific stdin watcher)
  // -------------------------------------------------------------------------
  wireShutdownHooks({
    onBeforeTerminate: async () => {
      await ctx.httpServer?.stop();
    },
  });
  wireStdinShutdown();
}
