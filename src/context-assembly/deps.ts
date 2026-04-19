import type { Result } from '../runtime/result.js';
import type { SessionNote } from './types.js';

/**
 * Injectable I/O dependencies for ContextAssembler.
 *
 * Follows CoordinatorDeps pattern exactly: all I/O behind this interface,
 * no direct fs/exec imports in the assembler core. Tests inject fakes.
 */
export interface ContextAssemblerDeps {
  /**
   * Run a git command in the given working directory.
   * Args are passed as an array (no shell interpolation).
   * Returns stdout string on success, err(message) on failure.
   */
  readonly execGit: (
    args: readonly string[],
    cwd: string,
  ) => Promise<Result<string, string>>;

  /**
   * Run a gh CLI command in the given working directory.
   * Args are passed as an array (no shell interpolation).
   * Returns stdout on success, err on failure (gh not installed, auth error, etc.).
   */
  readonly execGh: (
    args: readonly string[],
    cwd: string,
  ) => Promise<Result<string, string>>;

  /**
   * List recent sessions for a workspace, ordered newest-first.
   * Returns at most `limit` sessions.
   * Real implementation: thin adapter over LocalSessionSummaryProviderV2.
   * Test implementation: return a hardcoded array.
   */
  readonly listRecentSessions: (
    workspacePath: string,
    limit: number,
  ) => Promise<Result<readonly SessionNote[], string>>;

  /**
   * Return the current ISO 8601 timestamp.
   * Injected for deterministic test output.
   */
  readonly nowIso: () => string;
}
