/**
 * WorkRail Auto: Trigger Store
 *
 * Loads and validates the triggers.yml configuration file.
 * Resolves $SECRET_NAME references from environment variables.
 *
 * Supported triggers.yml format (narrow YAML subset):
 *
 *   triggers:
 *     - id: my-trigger
 *       provider: generic
 *       workflowId: coding-task-workflow-agentic
 *       workspacePath: /path/to/repo
 *       goal: "Review this MR"
 *       hmacSecret: $MY_HMAC_SECRET   # optional, resolved from env
 *       contextMapping:               # optional
 *         mrUrl: "$.pull_request.html_url"
 *
 * Unsupported YAML features (returns TriggerStoreError.kind: 'parse_error'):
 * - YAML anchors (&ref, *ref)
 * - Inline arrays ([a, b])
 * - Inline objects ({key: value})
 * - Multi-document YAML (---)
 * - Trailing colons in unquoted values
 *
 * Values containing colons MUST be quoted:
 *   goal: "Review: MR #123"   # OK
 *   goal: Review: MR #123     # Parse error
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { Result } from '../runtime/result.js';
import { ok, err } from '../runtime/result.js';
import {
  type TriggerConfig,
  type TriggerDefinition,
  type ContextMapping,
  type ContextMappingEntry,
  type PollingSource,
  type WorkspaceConfig,
  type WorkspaceName,
  asTriggerId,
  asWorkspaceName,
} from './types.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type TriggerStoreError =
  | { readonly kind: 'parse_error'; readonly message: string; readonly lineNumber?: number }
  | { readonly kind: 'missing_secret'; readonly envVarName: string; readonly triggerId: string }
  | { readonly kind: 'missing_field'; readonly field: string; readonly triggerId: string }
  | { readonly kind: 'invalid_field_value'; readonly field: string; readonly triggerId: string }
  | { readonly kind: 'unknown_provider'; readonly provider: string; readonly triggerId: string }
  | { readonly kind: 'unknown_workspace'; readonly workspaceName: string; readonly triggerId: string }
  | { readonly kind: 'file_not_found'; readonly filePath: string }
  | { readonly kind: 'io_error'; readonly message: string }
  | { readonly kind: 'duplicate_id'; readonly triggerId: string };

// ---------------------------------------------------------------------------
// Supported providers (extensible: add post-MVP providers here)
// ---------------------------------------------------------------------------

const SUPPORTED_PROVIDERS = new Set(['generic', 'gitlab_poll', 'github_issues_poll', 'github_prs_poll']);

// ---------------------------------------------------------------------------
// Narrow YAML parser
//
// Handles the specific triggers.yml format described above.
// Returns a raw parsed object tree or a TriggerStoreError.
//
// Grammar handled:
//   document      ::= "triggers:" NEWLINE list-items
//   list-items    ::= ("  - " key-value-block)*
//   key-value-block ::= (key ":" value NEWLINE)*
//   sub-object    ::= (key ":" value NEWLINE)* (under deeper indentation)
//   value         ::= quoted-string | unquoted-value
//   quoted-string ::= '"' chars '"' | "'" chars "'"
//   unquoted-value ::= [^:#]+ (no colon in unquoted values)
//   secret-ref    ::= "$" IDENTIFIER (resolved from env, not a parse concern)
// ---------------------------------------------------------------------------

type ParsedYamlValue = string | ParsedYamlMap | null;
type ParsedYamlMap = { [key: string]: ParsedYamlValue };

interface ParsedTriggerRaw {
  id?: string;
  provider?: string;
  workflowId?: string;
  workspacePath?: string;
  goal?: string;
  hmacSecret?: string;
  contextMapping?: { [key: string]: string };
  goalTemplate?: string;
  referenceUrls?: string;   // space-separated scalar in YAML; split at assemble time
  concurrencyMode?: string; // validated as 'serial' | 'parallel' at assemble time
  callbackUrl?: string;
  // Note: maxSessionMinutes and maxTurns are stored as raw strings here because
  // the YAML parser returns all scalars as strings. Numeric conversion and
  // validation happen in validateAndResolveTrigger at the boundary.
  agentConfig?: { model?: string; maxSessionMinutes?: string; maxTurns?: string };
  onComplete?: { runOn?: string; workflowId?: string; goal?: string };
  autoCommit?: string;   // 'true' | 'false' scalar
  autoOpenPR?: string;   // 'true' | 'false' scalar
  // Workspace namespacing (Phase 1).
  workspaceName?: string;  // raw string; validated + branded in validateAndResolveTrigger
  soulFile?: string;       // raw path; cascade-resolved in validateAndResolveTrigger
  // Worktree isolation (Issue #627).
  branchStrategy?: string; // validated as 'worktree' | 'none' at assemble time; default 'none'
  baseBranch?: string;     // default 'main'
  branchPrefix?: string;   // default 'worktrain/'
  // Polling trigger source (present for gitlab_poll, github_issues_poll, github_prs_poll).
  // Stored as raw strings; resolved and validated in validateAndResolveTrigger().
  // Fields from all providers are unioned here -- the assembler validates which
  // fields are required per provider and rejects invalid combinations.
  source?: {
    // GitLab fields
    baseUrl?: string;
    projectId?: string;
    // GitHub fields
    repo?: string;            // "owner/repo" format
    excludeAuthors?: string;  // space-separated logins; split at assemble time
    notLabels?: string;       // space-separated label names; split at assemble time
    labelFilter?: string;     // space-separated label names; passed to GitHub API
    // Shared fields
    token?: string;           // may be a $SECRET_REF, resolved at assembly time
    events?: string;          // space-separated scalar in YAML; split at assemble time
    pollIntervalSeconds?: string; // numeric string; parsed to number at assembly time
  };
}

/**
 * Strips leading and trailing quotes (single or double) from a YAML scalar value.
 * Returns the unquoted content.
 */
function unquoteYamlScalar(raw: string): string {
  const s = raw.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Parse a YAML scalar value. Rejects inline arrays and inline objects.
 */
function parseScalar(raw: string, lineNum: number): Result<string, TriggerStoreError> {
  const s = raw.trim();
  if (s.startsWith('[') || s.startsWith('{')) {
    return err({
      kind: 'parse_error',
      message: `Inline arrays and objects are not supported. Use block style. At line ${lineNum}.`,
      lineNumber: lineNum,
    });
  }
  return ok(unquoteYamlScalar(s));
}

/**
 * Parse triggers.yml content (narrow YAML subset).
 * Returns an array of raw trigger maps.
 */
function parseTriggersYaml(
  content: string,
): Result<ParsedTriggerRaw[], TriggerStoreError> {
  const lines = content.split('\n');
  const triggers: ParsedTriggerRaw[] = [];

  let lineIndex = 0;

  // Skip empty lines / comment lines at the top
  const skipBlankAndComments = (): void => {
    while (lineIndex < lines.length) {
      const l = lines[lineIndex];
      if (l !== undefined && (l.trim() === '' || l.trim().startsWith('#'))) {
        lineIndex++;
      } else {
        break;
      }
    }
  };

  skipBlankAndComments();

  // Expect "triggers:" as the root key
  if (lineIndex >= lines.length || !lines[lineIndex]?.trim().startsWith('triggers:')) {
    return err({
      kind: 'parse_error',
      message: `Expected "triggers:" as the root key at line ${lineIndex + 1}.`,
      lineNumber: lineIndex + 1,
    });
  }
  lineIndex++;

  // Parse list items
  while (lineIndex < lines.length) {
    const line = lines[lineIndex];
    if (line === undefined) break;

    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      lineIndex++;
      continue;
    }

    // Each trigger starts with "  - " (2+ spaces then dash)
    if (!line.match(/^[ ]{2,}- /)) {
      return err({
        kind: 'parse_error',
        message: `Expected a list item starting with "  - " at line ${lineIndex + 1}. Got: "${trimmed}"`,
        lineNumber: lineIndex + 1,
      });
    }

    const trigger: ParsedTriggerRaw = {};
    // Determine the indent level of this list item
    const itemIndent = line.indexOf('-');

    // Parse the first key-value on the same line as the dash (if any)
    const afterDash = line.slice(itemIndent + 1).trim();
    if (afterDash) {
      const colonIdx = afterDash.indexOf(':');
      if (colonIdx === -1) {
        return err({
          kind: 'parse_error',
          message: `Missing colon in key-value pair at line ${lineIndex + 1}: "${afterDash}"`,
          lineNumber: lineIndex + 1,
        });
      }
      const key = afterDash.slice(0, colonIdx).trim();
      const rawValue = afterDash.slice(colonIdx + 1).trim();

      if (rawValue !== '') {
        const valueResult = parseScalar(rawValue, lineIndex + 1);
        if (valueResult.kind === 'err') return valueResult;
        setTriggerField(trigger, key, valueResult.value);
      }
    }
    lineIndex++;

    // Parse subsequent key-value lines for this trigger item
    // They must be indented more than the list item dash
    while (lineIndex < lines.length) {
      const kvLine = lines[lineIndex];
      if (kvLine === undefined) break;
      const kTrimmed = kvLine.trim();
      if (kTrimmed === '' || kTrimmed.startsWith('#')) {
        lineIndex++;
        continue;
      }

      // Determine indent of this line
      const lineIndent = kvLine.search(/\S/);
      if (lineIndent <= itemIndent) {
        // Back to the parent level (next trigger or end)
        break;
      }

      const colonIdx = kTrimmed.indexOf(':');
      if (colonIdx === -1) {
        return err({
          kind: 'parse_error',
          message: `Missing colon in key-value pair at line ${lineIndex + 1}: "${kTrimmed}"`,
          lineNumber: lineIndex + 1,
        });
      }

      const key = kTrimmed.slice(0, colonIdx).trim();
      const rawValue = kTrimmed.slice(colonIdx + 1).trim();

      if (key === 'contextMapping') {
        // contextMapping is a sub-object block
        lineIndex++;
        const contextMapping: { [k: string]: string } = {};
        while (lineIndex < lines.length) {
          const cmLine = lines[lineIndex];
          if (cmLine === undefined) break;
          const cmTrimmed = cmLine.trim();
          if (cmTrimmed === '' || cmTrimmed.startsWith('#')) {
            lineIndex++;
            continue;
          }
          const cmIndent = cmLine.search(/\S/);
          if (cmIndent <= lineIndent) break;

          const cmColonIdx = cmTrimmed.indexOf(':');
          if (cmColonIdx === -1) {
            return err({
              kind: 'parse_error',
              message: `Missing colon in contextMapping entry at line ${lineIndex + 1}: "${cmTrimmed}"`,
              lineNumber: lineIndex + 1,
            });
          }
          const cmKey = cmTrimmed.slice(0, cmColonIdx).trim();
          const cmRawValue = cmTrimmed.slice(cmColonIdx + 1).trim();
          const cmValueResult = parseScalar(cmRawValue, lineIndex + 1);
          if (cmValueResult.kind === 'err') return cmValueResult;
          contextMapping[cmKey] = cmValueResult.value;
          lineIndex++;
        }
        trigger.contextMapping = contextMapping;
        continue;
      }

      if (key === 'agentConfig') {
        // agentConfig is a sub-object block with scalar string values.
        // Baseline indent: lineIndent (indent of the "agentConfig:" key line).
        lineIndex++;
        const agentConfig: { model?: string; maxSessionMinutes?: string; maxTurns?: string } = {};
        while (lineIndex < lines.length) {
          const acLine = lines[lineIndex];
          if (acLine === undefined) break;
          const acTrimmed = acLine.trim();
          if (acTrimmed === '' || acTrimmed.startsWith('#')) {
            lineIndex++;
            continue;
          }
          const acIndent = acLine.search(/\S/);
          if (acIndent <= lineIndent) break;

          const acColonIdx = acTrimmed.indexOf(':');
          if (acColonIdx === -1) {
            return err({
              kind: 'parse_error',
              message: `Missing colon in agentConfig entry at line ${lineIndex + 1}: "${acTrimmed}"`,
              lineNumber: lineIndex + 1,
            });
          }
          const acKey = acTrimmed.slice(0, acColonIdx).trim();
          const acRawValue = acTrimmed.slice(acColonIdx + 1).trim();
          if (acRawValue !== '') {
            const acValueResult = parseScalar(acRawValue, lineIndex + 1);
            if (acValueResult.kind === 'err') return acValueResult;
            if (acKey === 'model') agentConfig.model = acValueResult.value;
            else if (acKey === 'maxSessionMinutes') agentConfig.maxSessionMinutes = acValueResult.value;
            else if (acKey === 'maxTurns') agentConfig.maxTurns = acValueResult.value;
          }
          lineIndex++;
        }
        trigger.agentConfig = agentConfig;
        continue;
      }

      if (key === 'onComplete') {
        // onComplete is a sub-object block with scalar string values.
        // Baseline indent: lineIndent (indent of the "onComplete:" key line).
        lineIndex++;
        const onComplete: { runOn?: string; workflowId?: string; goal?: string } = {};
        while (lineIndex < lines.length) {
          const ocLine = lines[lineIndex];
          if (ocLine === undefined) break;
          const ocTrimmed = ocLine.trim();
          if (ocTrimmed === '' || ocTrimmed.startsWith('#')) {
            lineIndex++;
            continue;
          }
          const ocIndent = ocLine.search(/\S/);
          if (ocIndent <= lineIndent) break;

          const ocColonIdx = ocTrimmed.indexOf(':');
          if (ocColonIdx === -1) {
            return err({
              kind: 'parse_error',
              message: `Missing colon in onComplete entry at line ${lineIndex + 1}: "${ocTrimmed}"`,
              lineNumber: lineIndex + 1,
            });
          }
          const ocKey = ocTrimmed.slice(0, ocColonIdx).trim();
          const ocRawValue = ocTrimmed.slice(ocColonIdx + 1).trim();
          if (ocRawValue !== '') {
            const ocValueResult = parseScalar(ocRawValue, lineIndex + 1);
            if (ocValueResult.kind === 'err') return ocValueResult;
            switch (ocKey) {
              case 'runOn':      onComplete.runOn = ocValueResult.value; break;
              case 'workflowId': onComplete.workflowId = ocValueResult.value; break;
              case 'goal':       onComplete.goal = ocValueResult.value; break;
              default: break; // unknown sub-keys silently ignored
            }
          }
          lineIndex++;
        }
        trigger.onComplete = onComplete;
        continue;
      }

      if (key === 'source') {
        // source: is a sub-object block for gitlab_poll triggers.
        // Contains baseUrl, projectId, token, events, pollIntervalSeconds.
        // Baseline indent: lineIndent (indent of the "source:" key line).
        lineIndex++;
        const source: NonNullable<ParsedTriggerRaw['source']> = {};
        while (lineIndex < lines.length) {
          const srcLine = lines[lineIndex];
          if (srcLine === undefined) break;
          const srcTrimmed = srcLine.trim();
          if (srcTrimmed === '' || srcTrimmed.startsWith('#')) {
            lineIndex++;
            continue;
          }
          const srcIndent = srcLine.search(/\S/);
          if (srcIndent <= lineIndent) break;

          const srcColonIdx = srcTrimmed.indexOf(':');
          if (srcColonIdx === -1) {
            return err({
              kind: 'parse_error',
              message: `Missing colon in source entry at line ${lineIndex + 1}: "${srcTrimmed}"`,
              lineNumber: lineIndex + 1,
            });
          }
          const srcKey = srcTrimmed.slice(0, srcColonIdx).trim();
          const srcRawValue = srcTrimmed.slice(srcColonIdx + 1).trim();
          if (srcRawValue !== '') {
            const srcValueResult = parseScalar(srcRawValue, lineIndex + 1);
            if (srcValueResult.kind === 'err') return srcValueResult;
            switch (srcKey) {
              case 'baseUrl':              source.baseUrl = srcValueResult.value; break;
              case 'projectId':            source.projectId = srcValueResult.value; break;
              case 'repo':                 source.repo = srcValueResult.value; break;
              case 'excludeAuthors':       source.excludeAuthors = srcValueResult.value; break;
              case 'notLabels':            source.notLabels = srcValueResult.value; break;
              case 'labelFilter':          source.labelFilter = srcValueResult.value; break;
              case 'token':                source.token = srcValueResult.value; break;
              case 'events':               source.events = srcValueResult.value; break;
              case 'pollIntervalSeconds':  source.pollIntervalSeconds = srcValueResult.value; break;
              default: break; // unknown sub-keys silently ignored
            }
          }
          lineIndex++;
        }
        trigger.source = source;
        continue;
      }

      if (rawValue === '') {
        // Empty value after key -- skip (e.g. contextMapping: with block below was handled)
        lineIndex++;
        continue;
      }

      const valueResult = parseScalar(rawValue, lineIndex + 1);
      if (valueResult.kind === 'err') return valueResult;
      setTriggerField(trigger, key, valueResult.value);
      lineIndex++;
    }

    triggers.push(trigger);
  }

  return ok(triggers);
}

/**
 * Set a known scalar field on a raw trigger map. Unknown fields are silently ignored.
 * Sub-object fields (contextMapping, agentConfig, onComplete) are handled separately.
 */
function setTriggerField(trigger: ParsedTriggerRaw, key: string, value: string): void {
  switch (key) {
    case 'id':               trigger.id = value; break;
    case 'provider':         trigger.provider = value; break;
    case 'workflowId':       trigger.workflowId = value; break;
    case 'workspacePath':    trigger.workspacePath = value; break;
    case 'goal':             trigger.goal = value; break;
    case 'hmacSecret':       trigger.hmacSecret = value; break;
    case 'goalTemplate':     trigger.goalTemplate = value; break;
    case 'referenceUrls':    trigger.referenceUrls = value; break;
    case 'concurrencyMode':  trigger.concurrencyMode = value; break;
    case 'callbackUrl':      trigger.callbackUrl = value; break;
    case 'autoCommit':       trigger.autoCommit = value; break;
    case 'autoOpenPR':       trigger.autoOpenPR = value; break;
    case 'workspaceName':    trigger.workspaceName = value; break;
    case 'soulFile':         trigger.soulFile = value; break;
    case 'branchStrategy':   trigger.branchStrategy = value; break;
    case 'baseBranch':       trigger.baseBranch = value; break;
    case 'branchPrefix':     trigger.branchPrefix = value; break;
    // contextMapping, agentConfig, onComplete, source handled as sub-object blocks
    default:
      // Unknown fields silently ignored for forward compatibility
      break;
  }
}

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

/**
 * Expand a leading `~/` in a file path to the user's home directory.
 *
 * WHY: Node.js `fs.readFile` (and all other fs APIs) do NOT perform shell-style
 * tilde expansion. A path like `~/.workrail/soul.md` passed directly to fs will
 * produce ENOENT because `~` is treated as a literal directory name, not the
 * home directory. This function converts `~/foo` to `/home/<user>/foo` so that
 * paths written with the common shell convention work correctly.
 *
 * Only the `~/` prefix is handled (the most common case). `~username/` forms are
 * not supported and are returned unchanged.
 */
function expandTildePath(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

// ---------------------------------------------------------------------------
// Secret resolution
//
// Values starting with "$" are treated as environment variable references.
// Example: "$MY_HMAC_SECRET" resolves to process.env.MY_HMAC_SECRET.
// ---------------------------------------------------------------------------

function resolveSecret(
  value: string,
  triggerId: string,
  env: Record<string, string | undefined>,
): Result<string, TriggerStoreError> {
  if (!value.startsWith('$')) {
    return ok(value);
  }
  const envVarName = value.slice(1); // Strip leading "$"
  const resolved = env[envVarName];
  if (resolved === undefined || resolved === '') {
    return err({ kind: 'missing_secret', envVarName, triggerId });
  }
  return ok(resolved);
}

// ---------------------------------------------------------------------------
// Trigger validation and assembly
// ---------------------------------------------------------------------------

function assembleContextMapping(
  raw: { [k: string]: string } | undefined,
): ContextMapping | undefined {
  if (!raw) return undefined;
  const mappings: ContextMappingEntry[] = Object.entries(raw).map(
    ([workflowContextKey, payloadPath]) => ({
      workflowContextKey,
      payloadPath,
    }),
  );
  return { mappings };
}

function validateAndResolveTrigger(
  raw: ParsedTriggerRaw,
  env: Record<string, string | undefined>,
  workspaces: Readonly<Record<string, WorkspaceConfig>> = {},
): Result<TriggerDefinition, TriggerStoreError> {
  const rawId = raw.id?.trim() ?? '';
  if (!rawId) {
    return err({ kind: 'missing_field', field: 'id', triggerId: '(unknown)' });
  }

  // Fields required unconditionally (workspacePath is handled separately below).
  // NOTE: 'goal' is intentionally excluded here -- it may be absent for late-bound triggers.
  // See the late-bound goal injection block below (after hmacSecret resolution).
  const requiredStringFields: Array<Extract<keyof ParsedTriggerRaw, 'provider' | 'workflowId'>> = [
    'provider',
    'workflowId',
  ];
  for (const field of requiredStringFields) {
    const v: string | undefined = raw[field];
    if (!v?.trim()) {
      return err({ kind: 'missing_field', field, triggerId: rawId });
    }
  }

  const provider = raw.provider!.trim();
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    return err({ kind: 'unknown_provider', provider, triggerId: rawId });
  }

  // ---------------------------------------------------------------------------
  // Workspace namespacing (Phase 1): resolve workspacePath and soulFile.
  //
  // If workspaceName is provided:
  //   1. Validate format: ^[a-zA-Z0-9_-]+$
  //   2. Look up in workspaces map (unknown_workspace = per-trigger soft error)
  //   3. Validate path is absolute
  //   4. Soul cascade: trigger YAML soulFile > workspace soulFile > undefined
  // If workspaceName is absent, workspacePath is required.
  // If both are provided, warn and use workspaceName.
  // ---------------------------------------------------------------------------
  let resolvedWorkspacePath: string;
  let resolvedWorkspaceName: WorkspaceName | undefined;
  let resolvedSoulFile: string | undefined;

  const rawWorkspaceName = raw.workspaceName?.trim();
  const rawWorkspacePath = raw.workspacePath?.trim();
  const rawSoulFile = raw.soulFile?.trim();

  if (rawWorkspaceName) {
    if (!/^[a-zA-Z0-9_-]+$/.test(rawWorkspaceName)) {
      return err({
        kind: 'invalid_field_value',
        field: `workspaceName (must match ^[a-zA-Z0-9_-]+$, got: "${rawWorkspaceName}")`,
        triggerId: rawId,
      });
    }

    const workspaceConfig = workspaces[rawWorkspaceName];
    if (!workspaceConfig) {
      return err({ kind: 'unknown_workspace', workspaceName: rawWorkspaceName, triggerId: rawId });
    }

    if (!path.isAbsolute(workspaceConfig.path)) {
      return err({
        kind: 'invalid_field_value',
        field: `workspace "${rawWorkspaceName}".path (must be absolute, got: "${workspaceConfig.path}")`,
        triggerId: rawId,
      });
    }

    if (rawWorkspacePath) {
      console.warn(
        `[TriggerStore] WARNING: trigger "${rawId}" has both workspaceName and workspacePath. ` +
        `workspaceName takes precedence; workspacePath "${rawWorkspacePath}" is ignored.`,
      );
    }

    resolvedWorkspacePath = workspaceConfig.path;
    resolvedWorkspaceName = asWorkspaceName(rawWorkspaceName);
    resolvedSoulFile = rawSoulFile ?? workspaceConfig.soulFile;
  } else {
    if (!rawWorkspacePath) {
      return err({ kind: 'missing_field', field: 'workspacePath', triggerId: rawId });
    }
    resolvedWorkspacePath = rawWorkspacePath;
    resolvedSoulFile = rawSoulFile;
  }

  // Expand `~/` tilde prefix in soulFile, if present.
  // Node.js fs APIs do not perform shell-style tilde expansion; without this, a
  // path like `~/.workrail/soul.md` would produce ENOENT and silently fall through
  // to the default soul with no warning.
  if (resolvedSoulFile) {
    resolvedSoulFile = expandTildePath(resolvedSoulFile);
  }

  // Validate soulFile absoluteness after tilde expansion.
  // WHY: a relative soulFile silently resolves against process.cwd(), which is almost
  // certainly wrong. This mirrors the workspace.path absoluteness check above and
  // ensures fail-fast at load time rather than a confusing runtime failure.
  if (resolvedSoulFile && !path.isAbsolute(resolvedSoulFile)) {
    return err({ kind: 'invalid_field_value', field: 'soulFile', triggerId: rawId });
  }

  // Resolve hmacSecret if present
  let hmacSecret: string | undefined;
  if (raw.hmacSecret?.trim()) {
    const secretResult = resolveSecret(raw.hmacSecret.trim(), rawId, env);
    if (secretResult.kind === 'err') return secretResult;
    hmacSecret = secretResult.value;
  }

  // ---------------------------------------------------------------------------
  // Late-bound goal injection (default goalTemplate: "{{$.goal}}")
  //
  // WHY: static goals in triggers.yml only work for scheduled/cron-style tasks.
  // Dynamic-goal use cases (PR review, incident response, webhook dispatch) need
  // the goal to come from the webhook payload at dispatch time. This default makes
  // that work without any explicit triggers.yml configuration.
  //
  // Injection rules:
  //   - goal absent + goalTemplate absent  -> inject both: use payload $.goal at dispatch
  //     time; fall back to LATE_BOUND_GOAL_SENTINEL if payload has no goal field.
  //   - goal absent + goalTemplate present -> inject sentinel as static fallback only.
  //   - goal present (any)                 -> no injection; existing behavior unchanged.
  //
  // LATE_BOUND_GOAL_SENTINEL is the static fallback that TriggerDefinition.goal requires
  // (type: string, never undefined). It only reaches the session if the webhook payload
  // has no $.goal field -- in which case interpolateGoalTemplate already logs a warning.
  // ---------------------------------------------------------------------------
  const LATE_BOUND_GOAL_SENTINEL = 'Autonomous task';

  let resolvedGoal: string;
  let resolvedGoalTemplate: string | undefined = raw.goalTemplate?.trim();

  if (!raw.goal?.trim()) {
    resolvedGoal = LATE_BOUND_GOAL_SENTINEL;
    if (!resolvedGoalTemplate) {
      // Neither goal nor goalTemplate configured -- default to payload $.goal.
      resolvedGoalTemplate = '{{$.goal}}';
      console.log(
        `[TriggerStore] Trigger "${rawId}" has no static goal or goalTemplate -- ` +
        `defaulting to goalTemplate: "{{$.goal}}" (goal taken from webhook payload). ` +
        `Fallback goal if payload has no goal field: "${LATE_BOUND_GOAL_SENTINEL}".`,
      );
    }
  } else {
    resolvedGoal = raw.goal.trim();
  }

  // Assemble optional new fields (goalTemplate already resolved above)
  const referenceUrlsRaw = raw.referenceUrls?.trim();
  // referenceUrls is stored as space-separated string in YAML (narrow parser limitation).
  // Split on whitespace and filter empty strings.
  const referenceUrls = referenceUrlsRaw
    ? referenceUrlsRaw.split(/\s+/).filter(Boolean)
    : undefined;

  // Validate each referenceUrl is a safe HTTP(S) URL (no file://, private IPs, etc.)
  if (referenceUrls) {
    for (const url of referenceUrls) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          return err({ kind: 'invalid_field_value', field: `referenceUrls (non-HTTP URL rejected: ${url})`, triggerId: raw.id ?? '?' });
        }
      } catch {
        return err({ kind: 'invalid_field_value', field: `referenceUrls (invalid URL: ${url})`, triggerId: raw.id ?? '?' });
      }
    }
  }

  // callbackUrl: validate as a static http(s) URL if present.
  // WHY: fail-fast at load time (same pattern as referenceUrls validation).
  // $ENV_VAR_NAME resolution is not supported for callbackUrl in MVP.
  let callbackUrl: string | undefined;
  if (raw.callbackUrl?.trim()) {
    const rawCb = raw.callbackUrl.trim();
    try {
      const parsedCb = new URL(rawCb);
      if (parsedCb.protocol !== 'https:' && parsedCb.protocol !== 'http:') {
        return err({ kind: 'invalid_field_value', field: `callbackUrl (non-HTTP URL rejected: ${rawCb})`, triggerId: rawId });
      }
    } catch {
      return err({ kind: 'invalid_field_value', field: `callbackUrl (invalid URL: ${rawCb})`, triggerId: rawId });
    }
    callbackUrl = rawCb;
  }

  // agentConfig: only include if at least one sub-field is present.
  // maxSessionMinutes and maxTurns are stored as strings by the YAML parser
  // (all scalars are strings). Convert to integers here at the validation boundary.
  let agentConfig: TriggerDefinition['agentConfig'] | undefined;
  if (raw.agentConfig) {
    const model = raw.agentConfig.model?.trim() || undefined;

    let maxSessionMinutes: number | undefined;
    if (raw.agentConfig.maxSessionMinutes !== undefined) {
      // WHY Number.isInteger instead of parseInt: parseInt('1.5', 10) silently returns 1,
      // so an operator writing maxSessionMinutes: 1.5 would get 1 minute with no warning.
      // Number.isInteger(Number(raw)) catches both non-numeric strings (NaN -> false) and
      // decimal values (1.5 -> false) in one check. Scientific notation integers like 1e2
      // pass correctly (Number('1e2') === 100, which is a valid integer).
      const asNumber = Number(raw.agentConfig.maxSessionMinutes);
      if (!Number.isInteger(asNumber) || asNumber <= 0) {
        // WHY invalid_field_value not missing_field: the field IS present -- its value is
        // invalid (non-integer, negative, or zero). missing_field means the field is absent.
        return err({
          kind: 'invalid_field_value',
          field: 'agentConfig.maxSessionMinutes (must be a positive integer)',
          triggerId: rawId,
        });
      }
      maxSessionMinutes = asNumber;
    }

    let maxTurns: number | undefined;
    if (raw.agentConfig.maxTurns !== undefined) {
      // WHY Number.isInteger: same rationale as maxSessionMinutes above.
      const asNumber = Number(raw.agentConfig.maxTurns);
      if (!Number.isInteger(asNumber) || asNumber <= 0) {
        // WHY invalid_field_value not missing_field: field is present, value is invalid.
        return err({
          kind: 'invalid_field_value',
          field: 'agentConfig.maxTurns (must be a positive integer)',
          triggerId: rawId,
        });
      }
      maxTurns = asNumber;
    }

    if (model !== undefined || maxSessionMinutes !== undefined || maxTurns !== undefined) {
      agentConfig = {
        ...(model !== undefined ? { model } : {}),
        ...(maxSessionMinutes !== undefined ? { maxSessionMinutes } : {}),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
      };
    }
  }

  // concurrencyMode: validate and default to 'serial' at parse time (not at use time).
  // Why: the default must be explicit in the TriggerDefinition so the router never
  // needs a runtime fallback. See trigger-router.ts queue.enqueue() for the product
  // decision this protects.
  const rawConcurrencyMode = raw.concurrencyMode?.trim();
  if (rawConcurrencyMode !== undefined && rawConcurrencyMode !== 'serial' && rawConcurrencyMode !== 'parallel') {
    return err({
      kind: 'invalid_field_value',
      field: `concurrencyMode (invalid value: "${rawConcurrencyMode}"; must be "serial" or "parallel")`,
      triggerId: rawId,
    });
  }
  const concurrencyMode: 'serial' | 'parallel' = rawConcurrencyMode === 'parallel' ? 'parallel' : 'serial';

  // onComplete: emit load-time warning for unsupported runOn values.
  // Why: runOn !== 'success' is parsed and stored but NOT executed in the MVP.
  // The warning ensures users know the field is not active yet.
  let onComplete: TriggerDefinition['onComplete'] | undefined;
  if (raw.onComplete) {
    const rawRunOn = raw.onComplete.runOn?.trim();
    if (rawRunOn && rawRunOn !== 'success') {
      console.warn(
        `[TriggerStore] UNSUPPORTED: onComplete.runOn='${rawRunOn}' is not implemented yet. ` +
        `This trigger will NOT execute a completion hook on ${rawRunOn}. ` +
        `Only runOn: 'success' is planned for a future release.`,
      );
    }
    if (rawRunOn === 'success' || rawRunOn === 'failure' || rawRunOn === 'always') {
      onComplete = {
        runOn: rawRunOn,
        ...(raw.onComplete.workflowId?.trim() ? { workflowId: raw.onComplete.workflowId.trim() } : {}),
        ...(raw.onComplete.goal?.trim() ? { goal: raw.onComplete.goal.trim() } : {}),
      };
    }
  }

  // Parse autoCommit / autoOpenPR boolean flags.
  // Both default to false when absent (opt-in semantics: never commit without explicit true).
  const autoCommit = raw.autoCommit?.trim().toLowerCase() === 'true';
  const autoOpenPR = raw.autoOpenPR?.trim().toLowerCase() === 'true';

  // Warn if autoOpenPR is set without autoCommit -- a PR requires a commit.
  // WHY soft warning (not hard error): allows users to add autoOpenPR first and
  // configure autoCommit later without breaking the config load. Delivery is
  // gated in code (runDelivery checks flags.autoCommit !== true).
  if (autoOpenPR && !autoCommit) {
    console.warn(
      `[TriggerStore] Warning: trigger "${rawId}" has autoOpenPR: true but autoCommit is not true. ` +
      `A PR requires a commit -- delivery will be skipped unless autoCommit is also set to true.`,
    );
  }

  // ---------------------------------------------------------------------------
  // Worktree isolation fields (Issue #627)
  //
  // branchStrategy: 'worktree' | 'none' -- default 'none' (opt-in to worktree isolation).
  // baseBranch: the base branch to branch from; default 'main'.
  // branchPrefix: prefix for the session branch name; default 'worktrain/'.
  //
  // WHY 'none' as default: worktree creation requires git auth (git fetch) and disk
  // access. Read-only triggers (MR review, polling) should not incur this overhead.
  // Only coding triggers that write to the repo should use 'worktree'.
  //
  // WHY validate at parse time: an invalid branchStrategy would silently fall through
  // to 'none' if not caught here. Fail-fast at load time is consistent with other
  // field validation in this function.
  // ---------------------------------------------------------------------------
  const rawBranchStrategy = raw.branchStrategy?.trim();
  if (rawBranchStrategy !== undefined && rawBranchStrategy !== 'worktree' && rawBranchStrategy !== 'none') {
    return err({
      kind: 'invalid_field_value',
      field: `branchStrategy (must be "worktree" or "none", got: "${rawBranchStrategy}")`,
      triggerId: rawId,
    });
  }
  const branchStrategy: 'worktree' | 'none' | undefined =
    rawBranchStrategy === 'worktree' ? 'worktree' : rawBranchStrategy === 'none' ? 'none' : undefined;

  const baseBranch = raw.baseBranch?.trim() || undefined;
  const branchPrefix = raw.branchPrefix?.trim() || undefined;

  // Validate baseBranch and branchPrefix for git-safe characters.
  // WHY validate here (not at worktree creation): a branchPrefix starting with '--' or
  // containing shell-special characters produces a cryptic git error deep in session setup.
  // Fail-fast at parse time gives a clear config error at daemon startup instead.
  // WHY this regex: allows all characters git accepts for branch names in common usage:
  // alphanumeric, dot, underscore, hyphen, forward-slash. Excludes shell metacharacters
  // (~, ^, :, ?, *, [, \, space) and values starting with '-' (git flag confusion).
  const GIT_SAFE_RE = /^[a-zA-Z0-9._/-]+$/;
  if (baseBranch !== undefined) {
    if (!GIT_SAFE_RE.test(baseBranch) || baseBranch.startsWith('-')) {
      return err({
        kind: 'invalid_field_value',
        field: `baseBranch (must match /^[a-zA-Z0-9._/-]+$/ and not start with "-", got: "${baseBranch}")`,
        triggerId: rawId,
      });
    }
  }
  if (branchPrefix !== undefined) {
    if (!GIT_SAFE_RE.test(branchPrefix) || branchPrefix.startsWith('-')) {
      return err({
        kind: 'invalid_field_value',
        field: `branchPrefix (must match /^[a-zA-Z0-9._/-]+$/ and not start with "-", got: "${branchPrefix}")`,
        triggerId: rawId,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // pollingSource assembly (gitlab_poll, github_issues_poll, github_prs_poll)
  //
  // Invariants enforced here:
  // - polling providers require source: block (missing_field error if absent)
  // - provider === 'generic' with source: block logs a warning (block is ignored)
  // - token is resolved from env if it is a $SECRET_REF
  // - events is split from space-separated scalar to string[]
  // - pollIntervalSeconds is parsed to a positive integer (default 60)
  // - GitLab requires baseUrl + projectId; GitHub requires repo
  // - The assembled pollingSource is tagged with provider for discriminated union narrowing
  // ---------------------------------------------------------------------------

  /**
   * Parse pollIntervalSeconds from the raw source block.
   * Returns 60 if absent, or a TriggerStoreError if invalid.
   *
   * WHY Number.isInteger instead of parseInt: parseInt('60.7', 10) silently returns 60,
   * so an operator writing pollIntervalSeconds: 60.7 would get 60 with no warning.
   * Number.isInteger(Number(raw)) catches both non-numeric strings (NaN -> false) and
   * decimal values (60.7 -> false) in one check. Same pattern as maxSessionMinutes above.
   */
  function parsePollIntervalSeconds(
    raw2: NonNullable<ParsedTriggerRaw['source']>,
    triggerId2: string,
  ): Result<number, TriggerStoreError> {
    const intervalRaw = raw2.pollIntervalSeconds?.trim();
    if (!intervalRaw) return ok(60);
    const asNumber = Number(intervalRaw);
    if (!Number.isInteger(asNumber) || asNumber <= 0) {
      return err({
        kind: 'invalid_field_value',
        field: `source.pollIntervalSeconds (must be a positive integer, got: ${intervalRaw})`,
        triggerId: triggerId2,
      });
    }
    return ok(asNumber);
  }

  let pollingSource: PollingSource | undefined;

  const isPollingProvider = provider === 'gitlab_poll' ||
    provider === 'github_issues_poll' ||
    provider === 'github_prs_poll';

  if (isPollingProvider) {
    if (!raw.source) {
      return err({ kind: 'missing_field', field: 'source', triggerId: rawId });
    }

    const src = raw.source;

    // Validate shared required field: token
    if (!src.token?.trim()) {
      return err({ kind: 'missing_field', field: 'source.token', triggerId: rawId });
    }
    const tokenResult = resolveSecret(src.token.trim(), rawId, env);
    if (tokenResult.kind === 'err') return tokenResult;

    // Parse events (required for all polling providers)
    if (!src.events?.trim()) {
      return err({ kind: 'missing_field', field: 'source.events', triggerId: rawId });
    }
    const events = src.events.trim().split(/\s+/).filter(Boolean);
    if (events.length === 0) {
      return err({ kind: 'missing_field', field: 'source.events (empty)', triggerId: rawId });
    }

    // Parse pollIntervalSeconds (shared, optional)
    const intervalResult = parsePollIntervalSeconds(src, rawId);
    if (intervalResult.kind === 'err') return intervalResult;
    const pollIntervalSeconds = intervalResult.value;

    if (provider === 'gitlab_poll') {
      // GitLab-specific required fields
      if (!src.baseUrl?.trim()) {
        return err({ kind: 'missing_field', field: 'source.baseUrl', triggerId: rawId });
      }
      if (!src.projectId?.trim()) {
        return err({ kind: 'missing_field', field: 'source.projectId', triggerId: rawId });
      }

      // Warn on unknown or unreachable event types
      const KNOWN_MR_EVENT_TYPES = new Set([
        'merge_request.opened',
        'merge_request.updated',
        'merge_request.merged',
        'merge_request.closed',
      ]);
      for (const event of events) {
        if (!KNOWN_MR_EVENT_TYPES.has(event)) {
          console.warn(
            `[TriggerStore] Unknown polling event type '${event}' for trigger '${rawId}' -- ` +
            `will match all open MRs as fallback`,
          );
        } else if (event === 'merge_request.merged' || event === 'merge_request.closed') {
          console.warn(
            `[TriggerStore] Event type '${event}' for trigger '${rawId}' cannot be observed ` +
            `with state=opened polling (GitLab only returns open MRs). ` +
            `Use a webhook trigger for merge/close events.`,
          );
        }
      }

      pollingSource = {
        provider: 'gitlab_poll',
        baseUrl: src.baseUrl.trim(),
        projectId: src.projectId.trim(),
        token: tokenResult.value,
        events,
        pollIntervalSeconds,
      };
    } else {
      // GitHub-specific required field: repo
      if (!src.repo?.trim()) {
        return err({ kind: 'missing_field', field: 'source.repo', triggerId: rawId });
      }

      // Warn on unknown GitHub event types
      const KNOWN_GITHUB_ISSUE_EVENTS = new Set(['issues.opened', 'issues.updated']);
      const KNOWN_GITHUB_PR_EVENTS = new Set(['pull_request.opened', 'pull_request.updated']);
      const knownEvents = provider === 'github_issues_poll' ? KNOWN_GITHUB_ISSUE_EVENTS : KNOWN_GITHUB_PR_EVENTS;
      for (const event of events) {
        if (!knownEvents.has(event)) {
          console.warn(
            `[TriggerStore] Unknown GitHub polling event type '${event}' for trigger '${rawId}' -- ` +
            `will match all items as fallback`,
          );
        }
      }

      // Parse optional space-separated list fields
      const excludeAuthors = src.excludeAuthors?.trim()
        ? src.excludeAuthors.trim().split(/\s+/).filter(Boolean)
        : [];
      const notLabels = src.notLabels?.trim()
        ? src.notLabels.trim().split(/\s+/).filter(Boolean)
        : [];
      const labelFilter = src.labelFilter?.trim()
        ? src.labelFilter.trim().split(/\s+/).filter(Boolean)
        : [];

      if (excludeAuthors.length === 0) {
        console.warn(
          `[TriggerStore] WARNING: trigger '${rawId}' has provider='${provider}' but ` +
          `excludeAuthors is not set. If WorkTrain creates issues/PRs under a bot account, ` +
          `omitting excludeAuthors will cause infinite self-review loops. ` +
          `Set excludeAuthors to your WorkTrain bot account login (e.g. "worktrain-bot").`,
        );
      }

      pollingSource = {
        provider: provider as 'github_issues_poll' | 'github_prs_poll',
        repo: src.repo.trim(),
        token: tokenResult.value,
        events,
        pollIntervalSeconds,
        excludeAuthors,
        notLabels,
        labelFilter,
      };
    }
  } else if (raw.source) {
    // provider === 'generic' but source: is present -- warn, do not error.
    // The source: block is only meaningful for polling providers.
    console.warn(
      `[TriggerStore] WARNING: trigger '${rawId}' has provider='${provider}' but also ` +
      `defines a source: block. The source: block is only used for polling providers ` +
      `(gitlab_poll, github_issues_poll, github_prs_poll). It will be ignored for this trigger.`,
    );
  }

  const trigger: TriggerDefinition = {
    id: asTriggerId(rawId),
    provider,
    workflowId: raw.workflowId!.trim(),
    // workspacePath: always set -- from workspaceName resolution or from raw YAML.
    workspacePath: resolvedWorkspacePath,
    goal: resolvedGoal,
    concurrencyMode,
    ...(hmacSecret !== undefined ? { hmacSecret } : {}),
    ...(raw.contextMapping !== undefined
      ? { contextMapping: assembleContextMapping(raw.contextMapping) }
      : {}),
    ...(resolvedGoalTemplate ? { goalTemplate: resolvedGoalTemplate } : {}),
    ...(referenceUrls !== undefined && referenceUrls.length > 0 ? { referenceUrls } : {}),
    ...(agentConfig !== undefined ? { agentConfig } : {}),
    ...(callbackUrl !== undefined ? { callbackUrl } : {}),
    ...(onComplete !== undefined ? { onComplete } : {}),
    ...(autoCommit ? { autoCommit } : {}),
    ...(autoOpenPR ? { autoOpenPR } : {}),
    ...(pollingSource !== undefined ? { pollingSource } : {}),
    // Workspace namespacing (Phase 1).
    ...(resolvedWorkspaceName !== undefined ? { workspaceName: resolvedWorkspaceName } : {}),
    ...(resolvedSoulFile ? { soulFile: resolvedSoulFile } : {}),
    // Worktree isolation (Issue #627).
    ...(branchStrategy !== undefined ? { branchStrategy } : {}),
    ...(baseBranch !== undefined ? { baseBranch } : {}),
    ...(branchPrefix !== undefined ? { branchPrefix } : {}),
  };

  return ok(trigger);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse and validate a triggers.yml YAML string.
 *
 * Resolves $SECRET_NAME refs from the provided env map.
 * Returns a fully validated TriggerConfig on success, or a TriggerStoreError on failure.
 *
 * This function is pure -- no I/O. Use loadTriggerConfigFromFile() for disk access.
 */
export function loadTriggerConfig(
  yamlContent: string,
  env: Record<string, string | undefined> = process.env,
  workspaces: Readonly<Record<string, WorkspaceConfig>> = {},
): Result<TriggerConfig, TriggerStoreError> {
  const parsedResult = parseTriggersYaml(yamlContent);
  if (parsedResult.kind === 'err') return parsedResult;

  // Collect all errors rather than fail-fast: one bad trigger should not block
  // valid triggers from loading. Invalid entries are logged as warnings and skipped.
  const validTriggers: TriggerDefinition[] = [];
  const validationErrors: TriggerStoreError[] = [];
  for (const rawTrigger of parsedResult.value) {
    const triggerResult = validateAndResolveTrigger(rawTrigger, env, workspaces);
    if (triggerResult.kind === 'err') {
      console.warn(`[TriggerStore] Skipping invalid trigger: ${JSON.stringify(triggerResult.error)}`);
      validationErrors.push(triggerResult.error);
      continue;
    }
    validTriggers.push(triggerResult.value);
  }

  if (validationErrors.length > 0) {
    console.warn(
      `[TriggerStore] Loaded ${validTriggers.length} valid trigger(s), ` +
      `skipped ${validationErrors.length} invalid trigger(s).`,
    );
  }

  return ok({ triggers: validTriggers });
}

/**
 * Load and parse a triggers.yml file from disk.
 *
 * Returns:
 * - ok(TriggerConfig) on success
 * - err({ kind: 'file_not_found' }) if the file does not exist
 * - err({ kind: 'io_error' }) on other I/O failures
 * - err(TriggerStoreError) on parse or validation failures
 */
export async function loadTriggerConfigFromFile(
  workspacePath: string,
  env: Record<string, string | undefined> = process.env,
  workspaces: Readonly<Record<string, WorkspaceConfig>> = {},
): Promise<Result<TriggerConfig, TriggerStoreError>> {
  const filePath = path.join(workspacePath, 'triggers.yml');

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (e) {
    const error = e as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      return err({ kind: 'file_not_found', filePath });
    }
    return err({ kind: 'io_error', message: error.message ?? String(e) });
  }

  return loadTriggerConfig(content, env, workspaces);
}

/**
 * Build a lookup map from TriggerId to TriggerDefinition for O(1) routing.
 *
 * Returns err({ kind: 'duplicate_id' }) if two triggers share the same ID.
 * Duplicate IDs would silently clobber one another in the routing table, so
 * the entire index is rejected rather than silently hiding the misconfiguration.
 */
export function buildTriggerIndex(
  config: TriggerConfig,
): Result<Map<string, TriggerDefinition>, TriggerStoreError> {
  const index = new Map<string, TriggerDefinition>();
  for (const trigger of config.triggers) {
    if (index.has(trigger.id)) {
      return err({ kind: 'duplicate_id', triggerId: trigger.id });
    }
    index.set(trigger.id, trigger);
  }
  return ok(index);
}
