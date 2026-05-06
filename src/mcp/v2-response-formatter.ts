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

import {
  getV2ExecutionRenderEnvelope,
  type V2ExecutionResponseLifecycle,
} from './render-envelope.js';
import {
  buildResponseSupplements,
  type FormattedSupplement,
} from './response-supplements.js';

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

interface V2AssessmentFollowupSupplement {
  readonly title: string;
  readonly guidance: string;
}

interface V2BindingDriftWarning {
  readonly code: 'BINDING_DRIFT';
  readonly slotId: string;
  readonly pinnedValue: string;
  readonly currentValue: string;
}

interface V2ExecutionBase {
  readonly continueToken?: string;
  readonly checkpointToken?: string;
  readonly isComplete: boolean;
  readonly pending: V2PendingStep | null;
  readonly preferences: V2Preferences;
  readonly nextIntent: string;
  readonly nextCall: V2NextCall | null;
  readonly warnings?: readonly V2BindingDriftWarning[];
}

interface V2Blocked extends V2ExecutionBase {
  readonly kind: 'blocked';
  readonly blockers: { readonly blockers: readonly V2Blocker[] };
  readonly retryable?: boolean;
  readonly retryContinueToken?: string;
  readonly validation?: V2Validation;
  readonly assessmentFollowup?: V2AssessmentFollowupSupplement;
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
 * canonical source. The formatted block surfaces `continueToken` as the
 * single agent-facing continuation token.
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
// Binding drift warning section
// ---------------------------------------------------------------------------

/**
 * Render binding drift warnings as a SYSTEM advisory block.
 * Returns an empty string when there are no warnings.
 */
function formatBindingDriftWarnings(data: V2ExecutionResponse): string {
  if (!data.warnings || data.warnings.length === 0) return '';
  const lines: string[] = [
    '',
    '> **⚠ Binding Drift Detected**',
    '> Your `.workrail/bindings.json` has changed since this session was started.',
    '> The session continues with the original compiled bindings. Start a new session to pick up the changes.',
    '>',
  ];
  for (const w of data.warnings) {
    lines.push(`> - \`${w.slotId}\`: was \`${w.pinnedValue}\`, now \`${w.currentValue}\``);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Variant formatters
// ---------------------------------------------------------------------------

function formatComplete(data: V2ExecutionResponse): string {
  const driftBlock = formatBindingDriftWarnings(data);
  return [
    PERSONA_SYSTEM,
    '',
    '# Workflow Complete',
    '',
    'The workflow has finished. No further steps to execute.',
    ...(driftBlock ? [driftBlock] : []),
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

  if (data.assessmentFollowup) {
    lines.push('**Follow-up required before retrying this step:**');
    lines.push(`- ${data.assessmentFollowup.title}`);
    lines.push(`- ${data.assessmentFollowup.guidance}`);
    lines.push('');
  }

  lines.push('Retry the same step with improved output:');
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

  const driftBlock = formatBindingDriftWarnings(data);
  if (driftBlock) {
    lines.push(driftBlock);
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

  const driftBlock = formatBindingDriftWarnings(data);
  if (driftBlock) {
    lines.push('');
    lines.push(driftBlock);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Clean format variants ("transparent proxy" — authored prompt as-is)
// ---------------------------------------------------------------------------

// Footer phrasing variants to avoid looking templated.
// Selected by step index (derived from stepId hash) for determinism.
const CLEAN_ADVANCE_FOOTERS: readonly string[] = [
  'WorkRail: when done, call continue_workflow with your notes. Token:',
  'WorkRail: advance with continue_workflow when ready. Include your notes. Token:',
  'WorkRail: call continue_workflow with your notes to move on. Token:',
  'WorkRail: finished? continue_workflow with notes. Token:',
];

const CLEAN_REHYDRATE_FOOTERS: readonly string[] = [
  'WorkRail: you are resuming this step. When ready, call continue_workflow with your notes. Token:',
  'WorkRail: picking up where you left off. Advance with continue_workflow and notes. Token:',
  'WorkRail: resuming. Call continue_workflow with notes when done. Token:',
];

function pickFooter(variants: readonly string[], stepId: string | undefined): string {
  if (!stepId) return variants[0]!;
  // Simple deterministic hash from stepId
  let hash = 0;
  for (let i = 0; i < stepId.length; i++) {
    hash = ((hash << 5) - hash + stepId.charCodeAt(i)) | 0;
  }
  return variants[Math.abs(hash) % variants.length]!;
}

function formatCleanComplete(_data: V2ExecutionResponse): string {
  return 'Workflow complete. No further steps.';
}

function formatCleanBlocked(data: V2Blocked): string {
  const firstBlocker = data.blockers.blockers[0];
  const heading = firstBlocker ? (BLOCKER_HEADING[firstBlocker.code] ?? firstBlocker.code) : 'Blocked';
  const lines: string[] = [`Blocked: ${heading}`, ''];

  for (const b of data.blockers.blockers) {
    lines.push(b.message);
    if (b.suggestedFix) {
      lines.push('');
      lines.push(`What to do: ${b.suggestedFix}`);
    }
    lines.push('');
  }

  if (data.validation) {
    if (data.validation.issues.length > 0) {
      lines.push('Issues:');
      for (const issue of data.validation.issues) lines.push(`- ${issue}`);
      lines.push('');
    }
  }

  const token = data.retryContinueToken ?? data.nextCall?.params.continueToken ?? data.continueToken;
  if (token) {
    lines.push(`WorkRail: retry with corrected output. Token: ${token}`);
    lines.push('---');
  }

  return lines.join('\n');
}

function formatCleanRehydrate(data: V2ExecutionResponse): string {
  const lines: string[] = [];

  if (data.pending) {
    lines.push(data.pending.prompt);
    lines.push('');
  }

  const token = data.nextCall?.params.continueToken ?? data.continueToken;
  lines.push('---');
  if (token) {
    const footer = pickFooter(CLEAN_REHYDRATE_FOOTERS, data.pending?.stepId);
    lines.push(`${footer} ${token}`);
    lines.push('---');
  }

  const driftBlock = formatBindingDriftWarnings(data);
  if (driftBlock) {
    lines.push(driftBlock);
  }

  return lines.join('\n');
}

function formatCleanSuccess(data: V2ExecutionResponse): string {
  const lines: string[] = [];

  if (data.pending) {
    lines.push(data.pending.prompt);
    lines.push('');
  }

  const token = data.nextCall?.params.continueToken ?? data.continueToken;
  lines.push('---');
  if (token) {
    const footer = pickFooter(CLEAN_ADVANCE_FOOTERS, data.pending?.stepId);
    lines.push(`${footer} ${token}`);
    lines.push('---');
  }

  const driftBlock = formatBindingDriftWarnings(data);
  if (driftBlock) {
    lines.push(driftBlock);
  }

  return lines.join('\n');
}

function deriveRenderInput(data: unknown): {
  readonly response: V2ExecutionResponse;
  readonly lifecycle: V2ExecutionResponseLifecycle;
  readonly contentEnvelope?: import('./step-content-envelope.js').StepContentEnvelope;
} | null {
  const envelope = getV2ExecutionRenderEnvelope(data);
  if (envelope != null) {
    return isV2ExecutionResponse(envelope.response)
      ? { response: envelope.response, lifecycle: envelope.lifecycle, contentEnvelope: envelope.contentEnvelope }
      : null;
  }

  return isV2ExecutionResponse(data)
    ? { response: data, lifecycle: 'advance' }
    : null;
}

// ---------------------------------------------------------------------------
// Reference rendering
// ---------------------------------------------------------------------------

/**
 * Render workflow references as a dedicated text section.
 *
 * Returns null when no references exist or the envelope is absent.
 * On 'start' lifecycle: full reference set with titles, paths, purposes.
 * On 'rehydrate' lifecycle: compact reminder (titles and paths only).
 * On 'advance' lifecycle: no references emitted.
 */
function renderReferencesSection(
  contentEnvelope: import('./step-content-envelope.js').StepContentEnvelope | undefined,
  lifecycle: V2ExecutionResponseLifecycle,
): FormattedReferences | null {
  if (contentEnvelope == null) return null;
  const refs = contentEnvelope.references;
  if (refs.length === 0) return null;

  switch (lifecycle) {
    case 'start': {
      const lines = ['Workflow References:', ''];
      for (const ref of refs) {
        const displayPath = ref.status === 'resolved' ? ref.resolvedPath : ref.source;
        const statusTag = ref.status === 'unresolved' ? ' [unresolved]' : ref.status === 'pinned' ? ' [pinned]' : '';
        const authority = ref.authoritative ? ' (authoritative)' : '';
        const resolveTag = ref.resolveFrom === 'package' ? ' [package]' : '';
        lines.push(`- **${ref.title}**${authority}${statusTag}${resolveTag}`);
        lines.push(`  Path: ${displayPath}`);
        lines.push(`  Purpose: ${ref.purpose}`);
        lines.push('');
      }
      return { kind: 'references', text: lines.join('\n').trimEnd() };
    }
    case 'rehydrate': {
      const lines = ['Workflow References (reminder):', ''];
      for (const ref of refs) {
        const displayPath = ref.status === 'resolved' ? ref.resolvedPath : ref.source;
        const statusTag = ref.status === 'unresolved' ? ' [unresolved]' : ref.status === 'pinned' ? ' [pinned]' : '';
        const resolveTag = ref.resolveFrom === 'package' ? ' [package]' : '';
        lines.push(`- ${ref.title}${statusTag}${resolveTag}: ${displayPath}`);
      }
      return { kind: 'references', text: lines.join('\n').trimEnd() };
    }
    case 'advance':
      return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Typed wrapper for rendered reference content, distinguishable from supplements. */
export interface FormattedReferences {
  readonly kind: 'references';
  readonly text: string;
}

/**
 * Structured response from the formatter.
 *
 * - `primary`: the main content (authored prompt + footer, or system message)
 * - `references`: optional typed reference content, structurally separate
 * - `supplements`: optional system payloads delivered as separate MCP content items
 */
export interface FormattedResponse {
  readonly primary: string;
  readonly references?: FormattedReferences;
  readonly supplements?: readonly FormattedSupplement[];
}

/**
 * Format a v2 execution response as natural language.
 *
 * Returns a FormattedResponse if the data is a recognized v2 execution
 * response shape (start_workflow or continue_workflow output). Returns null
 * if the data does not match, signaling the caller to fall back to JSON.
 *
 * When cleanResponseFormat is true, uses the "transparent proxy" format:
 * authored prompt delivered as-is with a minimal WorkRail footer.
 * This improves agent authority perception by removing system scaffolding.
 *
 * @param data - The tool result data to format
 * @param cleanResponseFormat - Whether to use the clean response format (from feature flags)
 */
export function formatV2ExecutionResponse(data: unknown, cleanResponseFormat: boolean): FormattedResponse | null {
  const renderInput = deriveRenderInput(data);
  if (!renderInput) return null;
  const cleanFormat = cleanResponseFormat;
  const { response, lifecycle, contentEnvelope } = renderInput;

  // Render references from content envelope (if present and non-empty)
  const references = renderReferencesSection(contentEnvelope, lifecycle);

  if (cleanFormat) {
    return {
      ...formatV2Clean(response),
      ...(references != null ? { references } : {}),
      supplements: buildResponseSupplements({ lifecycle, cleanFormat }),
    };
  }

  // Classic format: single content item, no separate guidance
  return {
    primary: formatV2Classic(response),
    ...(references != null ? { references } : {}),
  };
}

function formatV2Classic(data: V2ExecutionResponse): string {
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

function formatV2Clean(data: V2ExecutionResponse): Pick<FormattedResponse, 'primary'> {
  if (data.nextIntent === 'complete' && !data.pending) {
    return { primary: formatCleanComplete(data) };
  }

  if (isBlocked(data)) {
    return { primary: formatCleanBlocked(data) };
  }

  if (data.nextIntent === 'rehydrate_only') {
    return { primary: formatCleanRehydrate(data) };
  }

  return {
    primary: formatCleanSuccess(data),
  };
}

// ---------------------------------------------------------------------------
// Resume session response formatter
// ---------------------------------------------------------------------------

interface ResumeCandidate {
  readonly sessionId: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly sessionTitle?: string | null;
  readonly gitBranch?: string | null;
  readonly resumeToken: string;
  readonly snippet: string;
  readonly whyMatched: readonly string[];
  readonly confidence?: 'strong' | 'medium' | 'weak';
  readonly matchExplanation?: string;
  readonly pendingStepId?: string | null;
  readonly isComplete?: boolean;
  readonly lastModifiedMs?: number | null;
  readonly nextCall: {
    readonly tool: 'continue_workflow';
    readonly params: { readonly continueToken: string; readonly intent: 'rehydrate' };
  };
}

interface ResumeSessionResponse {
  readonly candidates: readonly ResumeCandidate[];
  readonly totalEligible: number;
}

function isResumeSessionResponse(data: unknown): data is ResumeSessionResponse {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  // Distinguish from execution responses (which have pending/nextIntent/preferences)
  // and other tool outputs. Resume responses uniquely have candidates + totalEligible
  // WITHOUT the execution response fields.
  return (
    Array.isArray(d.candidates) &&
    typeof d.totalEligible === 'number' &&
    !('pending' in d) &&
    !('nextIntent' in d)
  );
}

const WHY_MATCHED_LABELS: Readonly<Record<string, string>> = {
  matched_exact_id: 'Exact ID match',
  matched_notes: 'Query matched session notes',
  matched_notes_partial: 'Query partially matched session notes',
  matched_workflow_id: 'Query matched workflow type',
  matched_head_sha: 'Same git commit (HEAD SHA)',
  matched_branch: 'Same git branch',
  matched_repo_root: 'Same workspace/repository',
  recency_fallback: 'No strong match signal (recent session)',
};

/** Format a relative time string from epoch ms (e.g. "2 hours ago", "3 days ago"). */
function formatRelativeTime(epochMs: number): string {
  const diffMs = Date.now() - epochMs;
  if (diffMs < 0) return 'just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

function formatResumeCandidate(c: ResumeCandidate, index: number): string {
  const lines: string[] = [];
  const matchLabel = c.whyMatched.map(w => WHY_MATCHED_LABELS[w] ?? w).join(', ');
  const isWeak = c.whyMatched.every(w => w === 'recency_fallback');
  const statusTag = c.isComplete ? ' (completed)' : '';

  const heading = c.sessionTitle?.trim() || c.workflowId;
  lines.push(`### Candidate ${index + 1}: \`${heading}\`${statusTag}${isWeak ? ' (weak match)' : ''}`);
  lines.push(`- **Session**: \`${c.sessionId}\``);
  lines.push(`- **Run**: \`${c.runId}\``);
  lines.push(`- **Workflow**: \`${c.workflowId}\``);
  lines.push(`- **Match reason**: ${matchLabel}`);
  if (c.confidence) {
    lines.push(`- **Confidence**: ${c.confidence}`);
  }
  if (c.matchExplanation) {
    lines.push(`- **Why this ranked here**: ${c.matchExplanation}`);
  }

  if (c.gitBranch) {
    lines.push(`- **Branch**: \`${c.gitBranch}\``);
  }

  if (c.pendingStepId) {
    lines.push(`- **Current step**: \`${c.pendingStepId}\``);
  } else if (c.isComplete) {
    lines.push('- **Status**: Workflow completed');
  }

  if (c.lastModifiedMs != null) {
    lines.push(`- **Last active**: ${formatRelativeTime(c.lastModifiedMs)}`);
  }

  if (c.snippet) {
    // Show first ~200 chars of snippet
    const preview = c.snippet.length > 200 ? c.snippet.slice(0, 200) + '...' : c.snippet;
    lines.push(`- **Preview**: ${preview.replace(/\n/g, ' ')}`);
  } else {
    lines.push('- **Preview**: (no recap notes available)');
  }

  if (c.isComplete) {
    lines.push('');
    lines.push('> This workflow has already completed. Resuming it will show the final state.');
  }

  lines.push('');
  lines.push('To inspect or resume this candidate, call `continue_workflow` with:');
  lines.push('```json');
  lines.push(JSON.stringify(c.nextCall.params, null, 2));
  lines.push('```');
  lines.push('This `rehydrate` call restores the exact workflow state and shows the current step/context.');

  return lines.join('\n');
}

/** Help text showing the agent what parameters are available for narrowing results. */
const SEARCH_PARAMS_HELP = [
  '**To narrow results, call `resume_session` again with any of these parameters:**',
  '- `query`: Free text keywords from the session (e.g. "mr ownership", "ACEI-1234", "login feature")',
  '- `runId`: Exact run ID if the user has one (e.g. "run_abc123def456")',
  '- `sessionId`: Exact session ID if the user has one (e.g. "sess_abc123")',
  '- `workspacePath`: Absolute path to the workspace (helps match by git branch/commit)',
  '- `sameWorkspaceOnly`: Restrict results to the current repo/workspace when that is clearly what the user means',
].join('\n');

/**
 * Format a resume_session response as natural language.
 *
 * The key design goal: an agent with ZERO context about WorkRail should be able
 * to read this response and know exactly what to do. The formatter explains:
 * 1. What these candidates are
 * 2. Which one to pick and why
 * 3. Exactly how to resume (copy-paste JSON)
 * 4. What to do if none match
 * 5. What parameters are available for better searching
 */
export function formatV2ResumeResponse(data: unknown): FormattedResponse | null {
  if (!isResumeSessionResponse(data)) return null;

  const { candidates, totalEligible } = data;
  const lines: string[] = [];

  if (candidates.length === 0) {
    lines.push('## No Resumable Sessions Found');
    lines.push('');
    lines.push(`Searched ${totalEligible} session(s) but none matched your query or workspace context.`);
    lines.push('');
    lines.push('**What to do**: Ask the user for more details about which session they want to resume. They might know:');
    lines.push('- A description of what they were working on (pass as `query`)');
    lines.push('- A run ID or session ID (pass as `runId` or `sessionId`)');
    lines.push('- Or start a fresh workflow with `start_workflow`.');
    lines.push('');
    lines.push(SEARCH_PARAMS_HELP);
    return { primary: lines.join('\n') };
  }

  const hasStrongMatch = candidates.some(c => !c.whyMatched.every(w => w === 'recency_fallback'));
  const allRecencyFallback = !hasStrongMatch;

  if (allRecencyFallback) {
    // No search signal was provided or nothing matched - show recent sessions as context
    // but tell the agent to ask the user
    lines.push('## Recent Workflow Sessions');
    lines.push('');
    lines.push(`No specific search criteria matched, so here are the **${candidates.length} most recent** sessions (out of ${totalEligible} total).`);
    lines.push('');
    lines.push('**Action required**: Present these to the user and ask which one they want to resume. If none of these are right, ask the user to describe what they were working on so you can search more specifically.');
    lines.push('');

    for (let i = 0; i < candidates.length; i++) {
      lines.push(formatResumeCandidate(candidates[i]!, i));
      lines.push('');
    }

    if (totalEligible > candidates.length) {
      lines.push('---');
      lines.push(`${totalEligible - candidates.length} more session(s) not shown.`);
      lines.push('');
    }

    lines.push(SEARCH_PARAMS_HELP);
  } else {
    // We have signal - show ranked results
    lines.push('## Resumable Workflow Sessions');
    lines.push('');
    lines.push(`Found **${totalEligible}** session(s) total. Showing the top ${candidates.length} ranked by match strength.`);
    lines.push('');

    const allWorkspaceDriven = candidates.every((c) =>
      c.whyMatched.every((w) => w === 'matched_head_sha' || w === 'matched_branch')
    );
    if (allWorkspaceDriven) {
      lines.push('**Note**: These candidates are ranked primarily from current workspace git context (branch/commit), not from a strong text match on your query.');
      lines.push('If the previews do not clearly match the user\'s request, inspect a candidate with `continue_workflow(..., intent: "rehydrate")` or ask for a more specific phrase / session ID.');
      lines.push('');
    }

    const best = candidates[0]!;
    const bestIsExact = best.whyMatched.includes('matched_exact_id');
    if (bestIsExact) {
      lines.push(`**Recommendation**: Candidate 1 is an exact ID match. Resume it directly.`);
    } else {
      lines.push(`**Recommendation**: Candidate 1 has the strongest match signal. Present the top candidates to the user and let them confirm which one to resume.`);
    }
    lines.push('');

    for (let i = 0; i < candidates.length; i++) {
      lines.push(formatResumeCandidate(candidates[i]!, i));
      lines.push('');
    }

    if (totalEligible > candidates.length) {
      lines.push('---');
      lines.push(`${totalEligible - candidates.length} more session(s) not shown.`);
      lines.push('');
      lines.push(SEARCH_PARAMS_HELP);
    }
  }

  return { primary: lines.join('\n') };
}
