import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';

/** Explicit historical prototype, kept separate from the current candidate and installed runtime. */
export function loadNotesBaseline() {
  const root = process.env.WORKRAIL_NOTES_BASELINE_ROOT;
  if (!root || !isAbsolute(root)) throw new Error('Historical notes controls require absolute WORKRAIL_NOTES_BASELINE_ROOT');
  const requireBaseline = createRequire(import.meta.url);
  // Node's shared CJS cache ensures bootstrap and reset act on the same DI instance.
  const container = requireBaseline(join(root, 'dist/di/container.js')) as { resetContainer(): void };
  const server = requireBaseline(join(root, 'dist/mcp/server.js')) as typeof import('../../src/mcp/server.js');
  return { container, server };
}
