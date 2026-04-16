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

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { Result } from '../runtime/result.js';
import { ok, err } from '../runtime/result.js';
import {
  type TriggerConfig,
  type TriggerDefinition,
  type ContextMapping,
  type ContextMappingEntry,
  asTriggerId,
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
  | { readonly kind: 'file_not_found'; readonly filePath: string }
  | { readonly kind: 'io_error'; readonly message: string }
  | { readonly kind: 'duplicate_id'; readonly triggerId: string };

// ---------------------------------------------------------------------------
// Supported providers (extensible: add post-MVP providers here)
// ---------------------------------------------------------------------------

const SUPPORTED_PROVIDERS = new Set(['generic']);

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
    // contextMapping, agentConfig, onComplete handled as sub-object blocks
    default:
      // Unknown fields silently ignored for forward compatibility
      break;
  }
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
): Result<TriggerDefinition, TriggerStoreError> {
  const rawId = raw.id?.trim() ?? '';
  if (!rawId) {
    return err({ kind: 'missing_field', field: 'id', triggerId: '(unknown)' });
  }

  const requiredStringFields: Array<Extract<keyof ParsedTriggerRaw, 'provider' | 'workflowId' | 'workspacePath' | 'goal'>> = [
    'provider',
    'workflowId',
    'workspacePath',
    'goal',
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

  // Resolve hmacSecret if present
  let hmacSecret: string | undefined;
  if (raw.hmacSecret?.trim()) {
    const secretResult = resolveSecret(raw.hmacSecret.trim(), rawId, env);
    if (secretResult.kind === 'err') return secretResult;
    hmacSecret = secretResult.value;
  }

  // Assemble optional new fields
  const goalTemplate = raw.goalTemplate?.trim();
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
        return err({
          kind: 'missing_field',
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
        return err({
          kind: 'missing_field',
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

  const trigger: TriggerDefinition = {
    id: asTriggerId(rawId),
    provider,
    workflowId: raw.workflowId!.trim(),
    workspacePath: raw.workspacePath!.trim(),
    goal: raw.goal!.trim(),
    concurrencyMode,
    ...(hmacSecret !== undefined ? { hmacSecret } : {}),
    ...(raw.contextMapping !== undefined
      ? { contextMapping: assembleContextMapping(raw.contextMapping) }
      : {}),
    ...(goalTemplate ? { goalTemplate } : {}),
    ...(referenceUrls !== undefined && referenceUrls.length > 0 ? { referenceUrls } : {}),
    ...(agentConfig !== undefined ? { agentConfig } : {}),
    ...(callbackUrl !== undefined ? { callbackUrl } : {}),
    ...(onComplete !== undefined ? { onComplete } : {}),
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
): Result<TriggerConfig, TriggerStoreError> {
  const parsedResult = parseTriggersYaml(yamlContent);
  if (parsedResult.kind === 'err') return parsedResult;

  // Collect all errors rather than fail-fast: one bad trigger should not block
  // valid triggers from loading. Invalid entries are logged as warnings and skipped.
  const validTriggers: TriggerDefinition[] = [];
  const validationErrors: TriggerStoreError[] = [];
  for (const rawTrigger of parsedResult.value) {
    const triggerResult = validateAndResolveTrigger(rawTrigger, env);
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

  return loadTriggerConfig(content, env);
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
