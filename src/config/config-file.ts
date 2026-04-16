/**
 * WorkRail config file loader.
 *
 * Reads ~/.workrail/config.json and returns a flat Record<string, string> that
 * callers merge with process.env (env wins). The file is optional; absence is
 * not an error. Malformed JSON or unknown keys are logged and ignored so that a
 * bad config file never prevents the server from starting.
 *
 * Keys that carry sensitive data (*_TOKEN), the internal dev key (WORKRAIL_DEV),
 * and runtime-injected keys (NODE_ENV, VITEST) are excluded from the allowed set
 * even if present in the file.
 *
 * @module config/config-file
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { z } from 'zod';
import type { Result } from '../runtime/result.js';
import { ok } from '../runtime/result.js';
import type { WorkspaceConfig } from '../trigger/types.js';

// =============================================================================
// Allowed keys (all supported env var names, minus excluded set)
// =============================================================================

/**
 * All keys that may appear in ~/.workrail/config.json.
 *
 * Exclusions (never read from file, must come from process.env only):
 * - *_TOKEN  (GitHub/GitLab/etc tokens - sensitive)
 * - NODE_ENV, VITEST (injected by the Node.js / test runtime)
 *
 * Note: WORKRAIL_DEV is intentionally included so developers can persist dev mode
 * in ~/.workrail/config.json instead of setting the env var on every shell session.
 */
const ALLOWED_CONFIG_FILE_KEYS = new Set([
  // app-config.ts keys
  'CACHE_TTL',
  'WORKRAIL_WORKFLOWS_DIR',
  'WORKRAIL_DISABLE_UNIFIED_DASHBOARD',
  'WORKRAIL_DISABLE_AUTO_OPEN',
  'WORKRAIL_DASHBOARD_PORT',

  // feature-flags.ts keys
  'WORKRAIL_DEV',
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

  // daemon workspace default -- written by `worktrain init`, read by the daemon command
  'WORKRAIL_DEFAULT_WORKSPACE',

  // daemon concurrency settings (numeric; NOT merged into process.env -- parsed directly
  // in trigger-listener.ts and passed to TriggerRouter as a number).
  // Example in config.json: "maxConcurrentSessions": "3"
  'maxConcurrentSessions',
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
// Default config template
// =============================================================================

const CONFIG_FILE_TEMPLATE = `{
  "_comment": "WorkRail configuration. Values here are defaults; process.env always wins.",
  "_docs": "https://github.com/exaudeus/workrail/blob/main/docs/configuration.md",

  "CACHE_TTL": "300000",
  "WORKRAIL_ENABLE_SESSION_TOOLS": "true",
  "WORKRAIL_ENABLE_AGENTIC_ROUTINES": "true",
  "WORKRAIL_ENABLE_V2_TOOLS": "true",
  "WORKRAIL_ENABLE_LEAN_WORKFLOWS": "false",
  "WORKRAIL_AUTHORITATIVE_DESCRIPTIONS": "false",
  "WORKRAIL_CLEAN_RESPONSE_FORMAT": "false",
  "WORKRAIL_VERBOSE_LOGGING": "false",

  "WORKFLOW_STORAGE_PATH": "",
  "WORKFLOW_GIT_REPOS": "",

  "WORKRAIL_LOG_LEVEL": "SILENT",
  "WORKRAIL_LOG_FORMAT": "human"
}
`;

// =============================================================================
// Public API
// =============================================================================

/**
 * Write ~/.workrail/config.json with default values if it does not yet exist.
 * Silent no-op if the file is already present. Never throws.
 */
export function ensureWorkrailConfigFile(): void {
  if (process.env['VITEST']) return;
  const configPath = path.join(os.homedir(), '.workrail', 'config.json');
  try {
    fs.accessSync(configPath);
    // File exists -- nothing to do.
  } catch {
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, CONFIG_FILE_TEMPLATE, 'utf-8');
    } catch {
      // Best-effort -- if we can't write, carry on silently.
    }
  }
}

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

// =============================================================================
// Workspace config loader
// =============================================================================

const WorkspaceConfigEntrySchema = z.object({
  path: z.string().min(1),
  soulFile: z.string().min(1).optional(),
});

/**
 * Load the "workspaces" map from ~/.workrail/config.json.
 *
 * Returns ok(Record<string, WorkspaceConfig>) on success.
 * Returns ok({}) when:
 * - Config file is absent (ENOENT)
 * - Config file has no "workspaces" key
 * - VITEST is set (test isolation -- never reads disk in tests)
 * Invalid entries are warned about and skipped; the rest are returned.
 * This function NEVER errors -- callers can always trust ok(result).
 *
 * WHY a separate function from loadWorkrailConfigFile:
 * The existing loader returns a flat Record<string, string> for env-merging.
 * The workspace map is a nested object serving a different consumer (trigger loading).
 */
export function loadWorkspacesFromConfigFile(): Result<Record<string, WorkspaceConfig>, never> {
  if (process.env['VITEST']) return ok({});

  const configPath = path.join(os.homedir(), '.workrail', 'config.json');

  let rawContent: string;
  try {
    rawContent = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return ok({});
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return ok({});
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return ok({});
  }

  const workspacesRaw = (parsed as Record<string, unknown>)['workspaces'];

  if (workspacesRaw === undefined || workspacesRaw === null) {
    return ok({});
  }

  if (typeof workspacesRaw !== 'object' || Array.isArray(workspacesRaw)) {
    console.warn(
      '[WorkRail] config file: "workspaces" must be an object (map of name -> { path, soulFile? }). Ignoring.',
    );
    return ok({});
  }

  const result: Record<string, WorkspaceConfig> = {};
  for (const [name, entry] of Object.entries(workspacesRaw as Record<string, unknown>)) {
    const parseResult = WorkspaceConfigEntrySchema.safeParse(entry);
    if (!parseResult.success) {
      console.warn(
        `[WorkRail] config file: workspace "${name}" has invalid shape -- skipped. ` +
        `Expected { path: string; soulFile?: string }. ` +
        `Issues: ${parseResult.error.issues.map((i) => i.message).join(', ')}`,
      );
      continue;
    }
    const data = parseResult.data;
    // Expand `~/` tilde prefix in soulFile defensively at config-load time.
    // WHY: Node.js fs APIs do not perform shell-style tilde expansion. Expanding
    // here ensures WorkspaceConfig objects never carry unexpanded tilde paths,
    // even before they reach validateAndResolveTrigger.
    if (data.soulFile?.startsWith('~/')) {
      result[name] = { ...data, soulFile: path.join(os.homedir(), data.soulFile.slice(2)) };
    } else {
      result[name] = data;
    }
  }

  return ok(result);
}
