/**
 * WorkRail Auto: GitHub Queue Configuration
 *
 * Loads and validates the `queue` key from ~/.workrail/config.json.
 * Returns the parsed GitHubQueueConfig or null when no queue config is present.
 *
 * Design notes:
 * - Returns Result<GitHubQueueConfig | null, string>:
 *     null when config.json exists but has no `queue` key, OR when config.json is absent.
 *     err when the `queue` key is present but malformed or missing required fields.
 * - Token resolution: if token starts with '$', resolve from process.env.
 *   Returns err if the env var is unset or empty.
 * - The type field is validated against the allowed union values.
 *   'assignee' and 'label' are implemented. 'mention' and 'query' parse fine but
 *   throw not_implemented at dispatch time in github-queue-poller.ts.
 *   When type === 'label', queueLabel is required and validated at load time.
 * - repo is required. pollIntervalSeconds, maxTotalConcurrentSessions, excludeLabels are optional
 *   with documented defaults.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Result } from '../runtime/result.js';
import { ok, err } from '../runtime/result.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Queue filter configuration from ~/.workrail/config.json `queue` key.
 *
 * Invariants:
 * - token is already resolved from environment when returned from loadQueueConfig().
 *   The raw config may contain a '$ENV_VAR' reference; loadQueueConfig() resolves it.
 * - type === 'assignee' and type === 'label' are implemented at runtime.
 *   'mention' and 'query' are accepted by the type system but throw not_implemented at dispatch.
 * - repo is in "owner/repo" format.
 * - pollIntervalSeconds: default 300 if absent.
 * - maxTotalConcurrentSessions: default 1 if absent.
 * - excludeLabels: default [] if absent.
 */
export interface GitHubQueueConfig {
  /**
   * Opt-in mechanism. 'assignee' and 'label' are implemented.
   * 'mention' and 'query' are typed but throw 'not_implemented' at runtime.
   */
  readonly type: 'assignee' | 'label' | 'mention' | 'query';
  /** Required when type === 'assignee'. The GitHub login to poll for. */
  readonly user?: string;
  /**
   * Required when type === 'label'. The label name to filter issues by.
   * Example: 'worktrain:ready'
   * WHY queueLabel (not name): avoids collision with trigger-level 'name' field conventions
   * and matches the queueLabel key used in triggers.yml.
   */
  readonly queueLabel?: string;
  /** @deprecated Use queueLabel instead. Legacy field name from earlier design iteration. */
  readonly name?: string;
  /** Required when type === 'mention'. The handle (with @) to match. */
  readonly handle?: string;
  /** Required when type === 'query'. Free-form GitHub issue search query. */
  readonly search?: string;
  /**
   * If true, process any open issue regardless of assignment/label filter.
   * Default: false. Use with extreme care.
   */
  readonly workOnAll?: boolean;
  /**
   * Poll interval in seconds. Default: 300 (5 min).
   */
  readonly pollIntervalSeconds: number;
  /**
   * Maximum total concurrent sessions (across all triggers).
   * Poller skips dispatch when active sessions >= this value.
   * Default: 1.
   */
  readonly maxTotalConcurrentSessions: number;
  /**
   * Issues with ANY of these labels are skipped by the poller.
   * Default: [].
   */
  readonly excludeLabels: readonly string[];
  /**
   * GitHub repository in "owner/repo" format. Required.
   */
  readonly repo: string;
  /**
   * GitHub PAT for the bot account. Already resolved from env.
   * Requires repo:read scope.
   */
  readonly token: string;
  /**
   * Display name for the bot account used when committing from queue sessions.
   * Defaults to 'worktrain' when absent.
   */
  readonly botName?: string;
  /**
   * Email for the bot account used when committing from queue sessions.
   * Defaults to 'worktrain@users.noreply.github.com' when absent.
   */
  readonly botEmail?: string;
}

// ---------------------------------------------------------------------------
// Default config path
// ---------------------------------------------------------------------------

export const WORKRAIL_CONFIG_PATH = path.join(os.homedir(), '.workrail', 'config.json');

// ---------------------------------------------------------------------------
// loadQueueConfig
// ---------------------------------------------------------------------------

/**
 * Load and validate the `queue` key from ~/.workrail/config.json.
 *
 * Returns:
 * - ok(null) when config.json does not exist or has no `queue` key
 * - ok(GitHubQueueConfig) when the queue config is present and valid
 * - err(string) when the queue key is present but invalid
 *
 * @param configPath - Injectable path to config.json (default: ~/.workrail/config.json)
 * @param env - Injectable environment map for $SECRET resolution (default: process.env)
 */
export async function loadQueueConfig(
  configPath: string = WORKRAIL_CONFIG_PATH,
  env: Record<string, string | undefined> = process.env,
): Promise<Result<GitHubQueueConfig | null, string>> {
  // Read config.json
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (e) {
    const error = e as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      // Config file absent -- no queue config
      return ok(null);
    }
    return err(`Failed to read config file at ${configPath}: ${error.message ?? String(e)}`);
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return err(`Failed to parse config JSON at ${configPath}: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return err(`Config at ${configPath} is not a JSON object`);
  }

  const config = parsed as Record<string, unknown>;

  // No queue key -- null result
  if (!('queue' in config)) {
    return ok(null);
  }

  const queue = config['queue'];
  if (typeof queue !== 'object' || queue === null) {
    return err('config.queue is not an object');
  }

  const q = queue as Record<string, unknown>;

  // Validate required fields
  const rawType = q['type'];
  if (typeof rawType !== 'string') {
    return err('config.queue.type is required and must be a string');
  }

  const VALID_TYPES = new Set<string>(['assignee', 'label', 'mention', 'query']);
  if (!VALID_TYPES.has(rawType)) {
    return err(`config.queue.type must be one of: assignee, label, mention, query. Got: "${rawType}"`);
  }

  const rawRepo = q['repo'];
  if (typeof rawRepo !== 'string' || !rawRepo.trim()) {
    return err('config.queue.repo is required and must be a non-empty string');
  }

  const rawToken = q['token'];
  if (typeof rawToken !== 'string' || !rawToken.trim()) {
    return err('config.queue.token is required and must be a non-empty string');
  }

  // Resolve token from env if it starts with '$'
  let resolvedToken: string;
  if (rawToken.startsWith('$')) {
    const envVarName = rawToken.slice(1);
    const envValue = env[envVarName];
    if (!envValue) {
      return err(`config.queue.token references env var $${envVarName} which is unset or empty`);
    }
    resolvedToken = envValue;
  } else {
    resolvedToken = rawToken.trim();
  }

  // Optional numeric fields
  const rawPollInterval = q['pollIntervalSeconds'];
  let pollIntervalSeconds = 300;
  if (rawPollInterval !== undefined) {
    if (typeof rawPollInterval !== 'number' || !Number.isInteger(rawPollInterval) || rawPollInterval <= 0) {
      return err('config.queue.pollIntervalSeconds must be a positive integer');
    }
    pollIntervalSeconds = rawPollInterval;
  }

  // Support both old name (maxConcurrentSelf) and new name (maxTotalConcurrentSessions)
  // for backward compatibility with existing config files.
  const rawMaxConcurrent = q['maxTotalConcurrentSessions'] ?? q['maxConcurrentSelf'];
  let maxTotalConcurrentSessions = 1;
  if (rawMaxConcurrent !== undefined) {
    if (typeof rawMaxConcurrent !== 'number' || !Number.isInteger(rawMaxConcurrent) || rawMaxConcurrent <= 0) {
      return err('config.queue.maxTotalConcurrentSessions must be a positive integer');
    }
    maxTotalConcurrentSessions = rawMaxConcurrent;
  }

  // Optional array fields
  const rawExcludeLabels = q['excludeLabels'];
  let excludeLabels: readonly string[] = [];
  if (rawExcludeLabels !== undefined) {
    if (!Array.isArray(rawExcludeLabels) || !rawExcludeLabels.every(l => typeof l === 'string')) {
      return err('config.queue.excludeLabels must be an array of strings');
    }
    excludeLabels = rawExcludeLabels as string[];
  }

  // Validate type-specific required fields at load time.
  // WHY here (not in poller): fail-fast at config load means the operator sees the error
  // immediately at daemon startup rather than at the first poll cycle.
  if (rawType === 'label') {
    const rawQueueLabel = q['queueLabel'];
    if (typeof rawQueueLabel !== 'string' || !rawQueueLabel.trim()) {
      return err('config.queue.queueLabel is required when type is "label"');
    }
  }

  // Optional string fields
  const rawUser = q['user'];
  const user = typeof rawUser === 'string' && rawUser.trim() ? rawUser.trim() : undefined;

  const rawName = q['name'];
  const labelName = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : undefined;

  const rawQueueLabel = q['queueLabel'];
  const queueLabel = typeof rawQueueLabel === 'string' && rawQueueLabel.trim() ? rawQueueLabel.trim() : undefined;

  const rawHandle = q['handle'];
  const handle = typeof rawHandle === 'string' && rawHandle.trim() ? rawHandle.trim() : undefined;

  const rawSearch = q['search'];
  const search = typeof rawSearch === 'string' && rawSearch.trim() ? rawSearch.trim() : undefined;

  const rawWorkOnAll = q['workOnAll'];
  const workOnAll = rawWorkOnAll === true;

  const rawBotName = q['botName'];
  const botName = typeof rawBotName === 'string' && rawBotName.trim() ? rawBotName.trim() : undefined;

  const rawBotEmail = q['botEmail'];
  const botEmail = typeof rawBotEmail === 'string' && rawBotEmail.trim() ? rawBotEmail.trim() : undefined;

  return ok({
    type: rawType as 'assignee' | 'label' | 'mention' | 'query',
    ...(user !== undefined ? { user } : {}),
    ...(queueLabel !== undefined ? { queueLabel } : {}),
    ...(labelName !== undefined ? { name: labelName } : {}),
    ...(handle !== undefined ? { handle } : {}),
    ...(search !== undefined ? { search } : {}),
    ...(workOnAll ? { workOnAll } : {}),
    pollIntervalSeconds,
    maxTotalConcurrentSessions,
    excludeLabels,
    repo: rawRepo.trim(),
    token: resolvedToken,
    ...(botName !== undefined ? { botName } : {}),
    ...(botEmail !== undefined ? { botEmail } : {}),
  });
}
