/**
 * WorkRail config file loader.
 *
 * Reads ~/.workrail/config.json and returns a flat Record<string, string> that
 * callers merge with process.env (env wins). The file is optional; absence is
 * not an error. Malformed JSON or unknown keys are logged and ignored so that a
 * bad config file never prevents the server from starting.
 *
 * Keys that carry sensitive data (*_TOKEN), internal dev keys (WORKRAIL_DEV,
 * WORKRAIL_DEV_STALENESS), and runtime-injected keys (NODE_ENV, VITEST) are
 * excluded from the allowed set even if present in the file.
 *
 * @module config/config-file
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { z } from 'zod';
import type { Result } from '../runtime/result.js';
import { ok } from '../runtime/result.js';

// =============================================================================
// Allowed keys (all supported env var names, minus excluded set)
// =============================================================================

/**
 * All keys that may appear in ~/.workrail/config.json.
 *
 * Exclusions (never read from file, must come from process.env only):
 * - *_TOKEN  (GitHub/GitLab/etc tokens - sensitive)
 * - WORKRAIL_DEV, WORKRAIL_DEV_STALENESS (internal dev-only)
 * - NODE_ENV, VITEST (injected by the Node.js / test runtime)
 */
const ALLOWED_CONFIG_FILE_KEYS = new Set([
  // app-config.ts keys
  'CACHE_TTL',
  'WORKRAIL_WORKFLOWS_DIR',
  'WORKRAIL_DISABLE_UNIFIED_DASHBOARD',
  'WORKRAIL_DISABLE_AUTO_OPEN',
  'WORKRAIL_DASHBOARD_PORT',

  // feature-flags.ts keys
  'WORKRAIL_ENABLE_SESSION_TOOLS',
  'WORKRAIL_ENABLE_EXPERIMENTAL_WORKFLOWS',
  'WORKRAIL_VERBOSE_LOGGING',
  'WORKRAIL_ENABLE_AGENTIC_ROUTINES',
  'WORKRAIL_ENABLE_LEAN_WORKFLOWS',
  'WORKRAIL_AUTHORITATIVE_DESCRIPTIONS',
  'WORKRAIL_ENABLE_V2_TOOLS',
  'WORKRAIL_CLEAN_RESPONSE_FORMAT',

  // storage / git keys
  'WORKFLOW_STORAGE_PATH',
  'WORKFLOW_GIT_REPOS',
  'WORKFLOW_GIT_REPO_URL',
  'WORKFLOW_GIT_REPO_BRANCH',
  'WORKFLOW_GIT_SYNC_INTERVAL',

  // logging / infra keys
  'WORKRAIL_LOG_LEVEL',
  'WORKRAIL_LOG_FORMAT',
  'WORKRAIL_DATA_DIR',
  'WORKRAIL_CACHE_DIR',

  // response format keys
  'WORKRAIL_JSON_RESPONSES',
]);

// =============================================================================
// Error type
// =============================================================================

export type ConfigFileError = {
  readonly _tag: 'ConfigFileError';
  readonly message: string;
  readonly cause?: unknown;
};

// =============================================================================
// Zod schema
// =============================================================================

/**
 * Validate the raw JSON. Only string values are accepted for all keys;
 * unknown keys are stripped (and warned about by the caller).
 */
const ConfigFileSchema = z.record(z.string(), z.string());

// =============================================================================
// Public API
// =============================================================================

/**
 * Load and validate ~/.workrail/config.json.
 *
 * - File absent       -> ok({})   (not an error)
 * - Malformed JSON    -> warn + ok({})
 * - Unknown keys      -> warn per key, ignore them
 * - Returns ok(validatedRecord) on success
 */
export function loadWorkrailConfigFile(): Result<Record<string, string>, ConfigFileError> {
  const configPath = path.join(os.homedir(), '.workrail', 'config.json');

  let rawContent: string;
  try {
    rawContent = fs.readFileSync(configPath, 'utf-8');
  } catch (e) {
    // ENOENT (file absent) and other read errors are both treated as "no config"
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // Warn but still return empty rather than crashing
      console.warn(`[WorkRail] Could not read config file at ${configPath}: ${(e as Error).message}`);
    }
    return ok({});
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    console.warn(
      `[WorkRail] config file at ${configPath} contains invalid JSON -- ignoring it. Fix or regenerate with "workrail init --config".`
    );
    return ok({});
  }

  const result = ConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    console.warn(
      `[WorkRail] config file at ${configPath} has an unexpected shape -- ignoring it. Expected a flat JSON object with string values.`
    );
    return ok({});
  }

  const validated: Record<string, string> = {};
  for (const [key, value] of Object.entries(result.data)) {
    if (!ALLOWED_CONFIG_FILE_KEYS.has(key)) {
      console.warn(
        `[WorkRail] config file: unknown key "${key}" -- ignored. See "workrail init --config" for supported keys.`
      );
      continue;
    }
    validated[key] = value;
  }

  return ok(validated);
}
