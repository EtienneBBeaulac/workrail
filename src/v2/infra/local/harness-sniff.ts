import type { HarnessIndicators } from '../../durable-core/domain/harness-detection.js';

export function captureProcessHarnessIndicators(): HarnessIndicators {
  const forced = process.env['WORKRAIL_FORCE_HARNESS'];
  return {
    forcedHarness: forced === 'mcp' || forced === 'cursor' || forced === 'claude_code' || forced === 'daemon' ? forced : null,
    claudeCode: process.env['CLAUDE_CODE'] === 'true',
    claudeCli: process.env['CLAUDE_CLI'] === 'true',
    // A terminal marker alone does not establish Cursor identity.
    cursorApp: process.env['CURSOR_APP'] === 'true',
    daemon: process.env['WORKRAIL_IS_DAEMON'] === 'true',
  };
}
