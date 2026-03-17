/**
 * V2 Natural Language Response Formatter
 *
 * Converts v2 execution tool output (start_workflow, continue_workflow) from
 * typed JSON objects into natural language with embedded JSON code blocks for
 * opaque tokens.
 *
 * Non-execution tools (list_workflows, inspect_workflow, resume_session,
 * checkpoint_workflow) continue returning JSON — they are not matched by the
 * shape detector.
 *
 * Output schemas and handler logic are unchanged; this only affects the MCP
 * text serialization at the toMcpResult boundary.
 *
 * @module mcp/v2-response-formatter
 */

// ---------------------------------------------------------------------------
// Response shape types (mirrors output schemas without importing them)
// ---------------------------------------------------------------------------

interface V2PendingStep {
  readonly stepId: string;
  readonly title: string;
  readonly prompt: string;
  readonly agentRole?: string;
}

interface V2Preferences {
  readonly autonomy: string;
  readonly riskPolicy: string;
}

interface V2NextCallParams {
  readonly continueToken: string;
}

interface V2NextCall {
  readonly tool: 'continue_workflow';
  readonly params: V2NextCallParams;
}

interface V2Blocker {
  readonly code: string;
  readonly pointer: Record<string, unknown>;
  readonly message: string;
  readonly suggestedFix?: string;
}

interface V2Validation {
  readonly issues: readonly string[];
  readonly suggestions: readonly string[];
}

interface V2ExecutionBase {
  readonly continueToken?: string;
  readonly checkpointToken?: string;
  readonly isComplete: boolean;
  readonly pending: V2PendingStep | null;
  readonly preferences: V2Preferences;
  readonly nextIntent: string;
  readonly nextCall: V2NextCall | null;
}

interface V2Blocked extends V2ExecutionBase {
  readonly kind: 'blocked';
  readonly blockers: { readonly blockers: readonly V2Blocker[] };
  readonly retryable?: boolean;
  readonly retryContinueToken?: string;
  readonly validation?: V2Validation;
}

type V2ExecutionResponse = V2ExecutionBase | (V2ExecutionBase & { readonly kind: 'ok' }) | V2Blocked;

// ---------------------------------------------------------------------------
// Shape detection
// ---------------------------------------------------------------------------

/**
 * Detect whether the data is a v2 execution response (start_workflow or
 * continue_workflow). Returns false for all other tool outputs.
 *
 * Detection relies on the co-presence of `pending`, `nextIntent`, and
 * `preferences` — a shape unique to execution responses.
 */
function isV2ExecutionResponse(data: unknown): data is V2ExecutionResponse {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    'pending' in d &&
    typeof d.nextIntent === 'string' &&
    typeof d.preferences === 'object' && d.preferences !== null
  );
}

function isBlocked(data: V2ExecutionResponse): data is V2Blocked {
  return 'kind' in data && (data as { kind: string }).kind === 'blocked';
}

// ---------------------------------------------------------------------------
// Preferences labels
// ---------------------------------------------------------------------------

const AUTONOMY_LABEL: Readonly<Record<string, string>> = {
  guided: 'guided mode',
  full_auto_stop_on_user_deps: 'full autonomy (stop on user deps)',
  full_auto_never_stop: 'full autonomy (never stop)',
};

const RISK_LABEL: Readonly<Record<string, string>> = {
  conservative: 'conservative risk',
  balanced: 'balanced risk',
  aggressive: 'aggressive risk',
};

function formatPreferences(prefs: V2Preferences): string {
  const autonomy = AUTONOMY_LABEL[prefs.autonomy] ?? prefs.autonomy;
  const risk = RISK_LABEL[prefs.riskPolicy] ?? prefs.riskPolicy;
  return `Preferences: ${autonomy}, ${risk}.`;
}

// ---------------------------------------------------------------------------
// Blocker code → human heading
// ---------------------------------------------------------------------------

const BLOCKER_HEADING: Readonly<Record<string, string>> = {
  USER_ONLY_DEPENDENCY: 'User Input Required',
  MISSING_REQUIRED_OUTPUT: 'Missing Required Output',
  INVALID_REQUIRED_OUTPUT: 'Invalid Output',
  MISSING_REQUIRED_NOTES: 'Missing Required Notes',
  MISSING_CONTEXT_KEY: 'Missing Context',
  CONTEXT_BUDGET_EXCEEDED: 'Context Budget Exceeded',
  REQUIRED_CAPABILITY_UNKNOWN: 'Unknown Capability Required',
  REQUIRED_CAPABILITY_UNAVAILABLE: 'Capability Unavailable',
  INVARIANT_VIOLATION: 'Invariant Violation',
  STORAGE_CORRUPTION_DETECTED: 'Storage Error',
};

// ---------------------------------------------------------------------------
// Persona section delimiters
// ---------------------------------------------------------------------------

const PERSONA_USER = '---------\nUSER\n---------';
const PERSONA_SYSTEM = '---------\nSYSTEM\n---------';

// ---------------------------------------------------------------------------
// Token JSON block
// ---------------------------------------------------------------------------

/**
 * Build the JSON code block the agent copies into their next call.
 *
 * Uses nextCall.params (minus intent, which is auto-inferred) as the
 * canonical source. The formatted block surfaces `nextToken` as the single
 * agent-facing advance token, while the raw API continues to use `ackToken`.
 * When nextCall is null (complete / non-retryable blocked), includes only
 * stateToken for session reference.
 *
 * checkpointToken is intentionally omitted from the prose output — it is
 * available in the raw JSON response for callers who need it, but surfacing it
 * in formatted output adds noise for agents on the happy path.
 *
 * stepId is included as a label so agents can anchor to the correct block in
 * long multi-step sessions and avoid accidentally using tokens from earlier steps.
 */
function formatTokenBlock(data: V2ExecutionResponse): string {
  const params: Record<string, string> = {};

  if (data.nextCall) {
    params.continueToken = data.nextCall.params.continueToken;
  } else if (data.continueToken) {
    params.continueToken = data.continueToken;
  }

  const lines: string[] = [];

  // Label with step ID to help agents identify the current token block and
  // avoid reusing tokens from earlier steps in their context.
  if (data.pending?.stepId) {
    lines.push(`**Tokens for step \`${data.pending.stepId}\` — use these for your next \`continue_workflow\` call (not tokens from earlier steps):**`);
    lines.push('');
  }

  lines.push('```json');
  lines.push(JSON.stringify(params));
  lines.push('```');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Variant formatters
// ---------------------------------------------------------------------------

function formatComplete(_data: V2ExecutionResponse): string {
  return [
    PERSONA_SYSTEM,
    '',
    '# Workflow Complete',
    '',
    'The workflow has finished. No further steps to execute.',
  ].join('\n');
}

function formatBlocked(data: V2Blocked): string {
  if (data.retryable) {
    return formatBlockedRetryable(data);
  }
  return formatBlockedNonRetryable(data);
}

function formatBlockedRetryable(data: V2Blocked): string {
  const firstBlocker = data.blockers.blockers[0];
  const heading = firstBlocker ? (BLOCKER_HEADING[firstBlocker.code] ?? firstBlocker.code) : 'Blocked';
  const lines: string[] = [];

  lines.push(PERSONA_SYSTEM);
  lines.push('');
  lines.push(`# Blocked: ${heading}`);
  if (data.pending) lines.push(`<!-- stepId: ${data.pending.stepId} -->`);
  lines.push('');

  for (const b of data.blockers.blockers) {
    lines.push(b.message);
    if (b.suggestedFix) {
      lines.push('');
      lines.push(`**What to do:** ${b.suggestedFix}`);
    }
    lines.push('');
  }

  if (data.validation) {
    if (data.validation.issues.length > 0) {
      lines.push('**Issues:**');
      for (const issue of data.validation.issues) lines.push(`- ${issue}`);
      lines.push('');
    }
    if (data.validation.suggestions.length > 0) {
      lines.push('**Suggestions:**');
      for (const s of data.validation.suggestions) lines.push(`- ${s}`);
      lines.push('');
    }
  }

  lines.push('Retry with corrected output:');
  lines.push('');
  lines.push(formatTokenBlock(data));

  return lines.join('\n');
}

function formatBlockedNonRetryable(data: V2Blocked): string {
  const firstBlocker = data.blockers.blockers[0];
  const heading = firstBlocker ? (BLOCKER_HEADING[firstBlocker.code] ?? firstBlocker.code) : 'Blocked';
  const lines: string[] = [];

  lines.push(PERSONA_SYSTEM);
  lines.push('');
  lines.push(`# Blocked: ${heading}`);
  if (data.pending) lines.push(`<!-- stepId: ${data.pending.stepId} -->`);
  lines.push('');

  for (const b of data.blockers.blockers) {
    lines.push(b.message);
    if (b.suggestedFix) {
      lines.push('');
      lines.push(`**What to do:** ${b.suggestedFix}`);
    }
    lines.push('');
  }

  lines.push('You cannot proceed without resolving this. Inform the user and wait for their response, then call `continue_workflow` with the updated context.');
  lines.push('');
  lines.push(formatTokenBlock(data));

  return lines.join('\n');
}

function formatRehydrate(data: V2ExecutionResponse): string {
  const lines: string[] = [];

  if (data.pending) {
    lines.push(PERSONA_USER);
    lines.push('');
    lines.push(`# ${data.pending.title} (resumed)`);
    lines.push(`<!-- stepId: ${data.pending.stepId} -->`);
    lines.push('');
    lines.push(data.pending.prompt);
    lines.push('');
  }

  lines.push(PERSONA_SYSTEM);
  lines.push('');
  // Token block at the top of SYSTEM section for easy agent reference.
  lines.push(formatTokenBlock(data));
  lines.push('');

  if (!data.pending) {
    lines.push('# State Recovered');
    lines.push('');
    lines.push('No pending step. The workflow may be complete or waiting for external input.');
    lines.push('');
  }

  lines.push('Continue working on this step. When done, call `continue_workflow` to advance.');

  return lines.join('\n');
}

function formatSuccess(data: V2ExecutionResponse): string {
  const lines: string[] = [];

  if (data.pending) {
    lines.push(PERSONA_USER);
    lines.push('');
    lines.push(`# ${data.pending.title}`);
    lines.push(`<!-- stepId: ${data.pending.stepId} -->`);
    lines.push('');
    lines.push(data.pending.prompt);
    lines.push('');
  }

  lines.push(PERSONA_SYSTEM);
  lines.push('');
  // Token block at the top of SYSTEM section — agents read from top, and it's
  // the most salient piece of information they need for the next call.
  lines.push(formatTokenBlock(data));
  lines.push('');
  lines.push('Execute this step, then call `continue_workflow` to advance.');
  lines.push('');
  lines.push('Include `output.notesMarkdown` documenting your work — what you did, key decisions, what you produced, and anything notable.');
  lines.push('');
  lines.push(formatPreferences(data.preferences));

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Format a v2 execution response as natural language.
 *
 * Returns the formatted string if the data is a recognized v2 execution
 * response shape (start_workflow or continue_workflow output). Returns null
 * if the data does not match, signaling the caller to fall back to JSON.
 */
export function formatV2ExecutionResponse(data: unknown): string | null {
  if (!isV2ExecutionResponse(data)) return null;

  if (data.nextIntent === 'complete' && !data.pending) {
    return formatComplete(data);
  }

  if (isBlocked(data)) {
    return formatBlocked(data);
  }

  if (data.nextIntent === 'rehydrate_only') {
    return formatRehydrate(data);
  }

  return formatSuccess(data);
}
