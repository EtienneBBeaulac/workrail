export type HarnessKind = 'mcp' | 'cursor' | 'claude_code' | 'daemon';
export type CurrentHost = 'daemon' | 'mcp';

/** Indicators describe the current host process, not its clients or permissions. */
export interface HarnessIndicators {
  readonly forcedHarness: HarnessKind | null;
  readonly claudeCode: boolean;
  readonly claudeCli: boolean;
  readonly cursorApp: boolean;
  readonly daemon: boolean;
}

export function resolveHarness(indicators: HarnessIndicators, currentHost?: CurrentHost): HarnessKind {
  if (indicators.forcedHarness !== null) return indicators.forcedHarness;
  if (indicators.claudeCode || indicators.claudeCli) return 'claude_code';
  if (indicators.cursorApp) return 'cursor';
  if (indicators.daemon || currentHost === 'daemon') return 'daemon';
  return 'mcp';
}
