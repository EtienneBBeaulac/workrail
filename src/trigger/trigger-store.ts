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
  | { readonly kind: 'unknown_provider'; readonly provider: string; readonly triggerId: string }
  | { readonly kind: 'file_not_found'; readonly filePath: string }
  | { readonly kind: 'io_error'; readonly message: string };

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
 * Set a known field on a raw trigger map. Unknown fields are silently ignored.
 */
function setTriggerField(trigger: ParsedTriggerRaw, key: string, value: string): void {
  switch (key) {
    case 'id':            trigger.id = value; break;
    case 'provider':      trigger.provider = value; break;
    case 'workflowId':    trigger.workflowId = value; break;
    case 'workspacePath': trigger.workspacePath = value; break;
    case 'goal':          trigger.goal = value; break;
    case 'hmacSecret':    trigger.hmacSecret = value; break;
    // contextMapping is handled separately (sub-object block)
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

  const trigger: TriggerDefinition = {
    id: asTriggerId(rawId),
    provider,
    workflowId: raw.workflowId!.trim(),
    workspacePath: raw.workspacePath!.trim(),
    goal: raw.goal!.trim(),
    ...(hmacSecret !== undefined ? { hmacSecret } : {}),
    ...(raw.contextMapping !== undefined
      ? { contextMapping: assembleContextMapping(raw.contextMapping) }
      : {}),
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

  const triggers: TriggerDefinition[] = [];
  for (const rawTrigger of parsedResult.value) {
    const triggerResult = validateAndResolveTrigger(rawTrigger, env);
    if (triggerResult.kind === 'err') return triggerResult;
    triggers.push(triggerResult.value);
  }

  return ok({ triggers });
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
 */
export function buildTriggerIndex(
  config: TriggerConfig,
): Map<string, TriggerDefinition> {
  const index = new Map<string, TriggerDefinition>();
  for (const trigger of config.triggers) {
    index.set(trigger.id, trigger);
  }
  return index;
}
