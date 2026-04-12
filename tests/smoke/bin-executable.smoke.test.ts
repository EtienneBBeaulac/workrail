import { describe, it, expect } from 'vitest';
import { accessSync, existsSync, constants } from 'fs';
import { resolve } from 'path';

/**
 * Smoke test: dist/mcp-server.js must be executable.
 *
 * WHY THIS TEST EXISTS:
 * tsc does not set the execute bit on compiled output. When the package is
 * published via CI, actions/upload-artifact@v4 drops Unix file permissions.
 * Without the execute bit, the `workrail` bin symlink installed by
 * `npm install -g` or `npx` fails with EACCES (Permission denied) when the
 * shell tries to exec it via the shebang.
 *
 * The fix is a `prepack` script that runs `chmodSync` before `npm pack`.
 * This test catches regressions where that guarantee is broken.
 */
describe('[SMOKE] bin executable', () => {
  it('dist/mcp-server.js has execute bit set', () => {
    const serverPath = resolve(__dirname, '../../dist/mcp-server.js');
    if (!existsSync(serverPath)) {
      throw new Error(`dist/mcp-server.js not found -- run 'npm run build' first`);
    }
    expect(() => accessSync(serverPath, constants.X_OK)).not.toThrow();
  });
});
