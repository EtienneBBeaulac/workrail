/**
 * System prompt construction for daemon agent sessions.
 *
 * WHY this module: buildSystemPrompt, buildSessionRecap, and BASE_SYSTEM_PROMPT
 * are pure functions/values -- no I/O, no node: imports, no SDK deps. They belong
 * in the functional core, not in the 3,900-line orchestration file.
 *
 * WHY no node: or @anthropic-ai/* imports: this module is part of the functional
 * core. It must be importable in any test context without I/O stubs.
 *
 * DAEMON_SOUL_DEFAULT is re-exported from soul-template.ts (which has zero deps
 * and exists specifically to avoid loading heavy deps in CLI init). Tests that
 * need DAEMON_SOUL_DEFAULT can import from here or from soul-template.ts directly.
 */

import type { WorkflowTrigger } from '../types.js';
import type { EnricherResult } from '../workflow-enricher.js';
export { DAEMON_SOUL_DEFAULT } from '../soul-template.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum combined byte size of assembled coordinator context injected via
 * trigger.context['assembledContextSummary'].
 * WHY: caps the coordinator-assembled context to protect LLM token budget.
 */
const MAX_ASSEMBLED_CONTEXT_BYTES = 8192;

// ---------------------------------------------------------------------------
// BASE_SYSTEM_PROMPT
// ---------------------------------------------------------------------------

/**
 * Static preamble for the daemon agent system prompt.
 *
 * WHY a named constant: extracting the preamble makes it readable as a document,
 * gives it a stable identity for tests, and follows the soul-template.ts precedent
 * of separating stable content from dynamic assembly. The dynamic parts (session
 * state, soul, workspace context) are injected by buildSystemPrompt() below.
 *
 * WHY these sections: daemon sessions run unattended. The agent has no user to ask.
 * The preamble replaces that missing human with: an oracle hierarchy, a reasoning
 * protocol, and explicit contracts for the two failure modes that matter most --
 * skipping steps and silent failure.
 */
export const BASE_SYSTEM_PROMPT = `\
You are WorkRail Auto, an autonomous agent that executes workflows step by step. You are running unattended -- there is no user watching. Your entire job is to faithfully complete the current workflow.

## What you are
You are highly capable. You handle ambitious, multi-step tasks that require real codebase understanding. You don't hedge, ask for permission, or stop to check in. You work.

## Your oracle (consult in this order when uncertain)
1. The daemon soul rules (## Agent Rules and Philosophy below)
2. AGENTS.md / CLAUDE.md in the workspace (injected below under Workspace Context)
3. The current workflow step's prompt and guidance
4. Local code patterns in the relevant module (grep the directory, not the whole repo)
5. Industry best practices -- only when nothing above applies

## Self-directed reasoning
Ask yourself questions to clarify your approach, then answer them yourself using tools before acting. Never wait for a human to answer -- you are the oracle.

Bad pattern: "I'll analyze both layers." (no justification)
Good pattern: "Question: Should I check the middleware? Answer: The workflow step says 'trace the full call chain', and the AGENTS.md says the entry point is in the middleware layer. Yes, start there."

## Your tools
- \`complete_step\`: Mark the current step complete and advance to the next one. Call this after completing ALL work required by the step. Include your notes (min 50 characters) in the notes field. The daemon manages the session token internally -- you do NOT need a continueToken. This is the preferred advancement tool for daemon sessions.
- \`continue_workflow\`: [DEPRECATED -- use complete_step instead. Do NOT pass a continueToken.] Only use this if complete_step is unavailable.
- \`Bash\`: Run shell commands. Use for building, testing, running scripts.
- \`Read\`: Read files.
- \`Write\`: Write files.
- \`report_issue\`: Record a structured issue, error, or unexpected behavior. Call this AND complete_step (unless fatal). Does not stop the session -- it creates a record for the auto-fix coordinator.
- \`spawn_agent\`: Delegate a sub-task to a child WorkRail session. BLOCKS until the child completes. Returns \`{ childSessionId, outcome: "success"|"error"|"timeout", notes: string }\`. Always check \`outcome\` before using \`notes\`. IMPORTANT: your session's time limit (maxSessionMinutes) keeps running while the child executes -- ensure your parent session has enough time for both your work AND the child's work. Maximum spawn depth is 3 by default (configurable). Use only when a step explicitly asks for delegation or when a clearly separable sub-task would benefit from its own WorkRail audit trail.
- \`signal_coordinator\`: Emit a structured mid-session signal to the coordinator WITHOUT advancing the workflow step. Use when the step asks you to surface a finding, request data, request approval, or report a blocking condition. Always returns immediately -- fire-and-observe. Signal kinds: "progress", "finding", "data_needed", "approval_needed", "blocked".

## Execution contract
1. Read the step carefully. Do ALL the work the step asks for.
2. Call \`complete_step\` with your notes. No continueToken needed -- the daemon manages it.
3. Repeat until the workflow reports it is complete.
4. Do NOT skip steps. Do NOT call \`complete_step\` without completing the step's work.

## The workflow is the contract
Every step must be fully completed before you call complete_step. The workflow step prompt is the specification of what 'done' means -- not a suggestion. Don't advance until the work is actually done.

Your cognitive mode changes per step: some steps make you a researcher, others a reviewer, others an implementer. Adopt the mode the step describes. Don't bring your own agenda.

## Silent failure is the worst outcome
If something goes wrong: call report_issue, then continue unless severity is 'fatal'. Do NOT silently retry forever, work around failures without noting them, or pretend things worked. The issue record is how the system learns and self-heals.

## Tools are your hands, not your voice
Don't narrate what you're about to do. Use the tool and report what you found. Token efficiency matters -- you have a wall-clock timeout.

## You don't have a user. You have a workflow and a soul.
If you're unsure, consult the oracle above. If nothing answers the question, make a reasoned decision, call report_issue with kind='self_correction' to document it, and continue.

## IMPORTANT: Never use continue_workflow in daemon sessions
complete_step is your advancement tool. It does not require a continueToken. Do NOT call continue_workflow with a token you found in a previous message -- use complete_step instead.\
`;

// ---------------------------------------------------------------------------
// buildSessionRecap
// ---------------------------------------------------------------------------

/**
 * Format prior step notes into a concise session state recap string.
 *
 * Pure function -- all I/O (note loading, truncation decisions) is handled
 * by the caller. WHY pure: unit-testable without mocking the session store
 * or token codec.
 *
 * Returns an empty string when `notes` is empty so the caller can guard on
 * `recap !== ''` before injecting it into the system prompt.
 *
 * WHY `<workrail_session_state>` tag: `buildSystemPrompt()` already reserves
 * this XML slot in the system prompt. Using the existing tag ensures the agent
 * parses it consistently with the documented schema.
 *
 * @param notes - Prior step notes (already limited to MAX_SESSION_RECAP_NOTES
 *   entries and bounded in size by the caller).
 */
export function buildSessionRecap(notes: readonly string[]): string {
  if (notes.length === 0) return '';

  const formattedNotes = notes
    .map((note, i) => `### Prior step ${i + 1}\n${note}`)
    .join('\n\n');

  return `<workrail_session_state>\nThe following notes summarize prior steps from this session:\n\n${formattedNotes}\n</workrail_session_state>`;
}

// ---------------------------------------------------------------------------
// buildSystemPrompt
// ---------------------------------------------------------------------------

/**
 * Build the system prompt for the daemon agent.
 *
 * Intentionally synchronous and pure -- all I/O (soul file, workspace context)
 * is resolved by the caller before invoking this function. WHY: keeps the
 * function unit-testable by passing pre-loaded strings directly, without
 * requiring fs mocking or real disk access in tests.
 *
 * @param trigger - The workflow trigger containing workspacePath and referenceUrls.
 * @param sessionState - Serialized WorkRail session state (may be empty string).
 * @param soulContent - Loaded content of daemon-soul.md (always a string; caller
 *   provides the hardcoded default if the file was absent).
 * @param workspaceContext - Combined workspace context from CLAUDE.md / AGENTS.md,
 *   or null if no workspace context files were found.
 * @param effectiveWorkspacePath - The workspace path the agent must work in.
 *   Callers compute this as: sessionWorkspacePath ?? trigger.workspacePath.
 *   Required (not optional) so the type system enforces the caller makes an explicit
 *   decision -- there is no silent fallback to trigger.workspacePath inside this function.
 *   WHY a separate parameter (not derived from trigger): trigger.workspacePath is always
 *   the main checkout. The worktree path is only known after worktree creation in
 *   buildPreAgentSession(). Passing it explicitly keeps this function pure and testable.
 */
/**
 * Maximum byte size of git diff stat injected from WorkflowEnricher.
 * WHY 2KB: diff stat is orientation context (file names + change counts), not the
 * full diff. 2KB covers typical PRs without bloating the system prompt.
 */
const MAX_GIT_DIFF_STAT_BYTES = 2048;

export function buildSystemPrompt(
  trigger: WorkflowTrigger,
  sessionState: string,
  soulContent: string,
  workspaceContext: string | null,
  effectiveWorkspacePath: string,
  enricherResult?: EnricherResult,
): string {
  const isWorktreeSession = effectiveWorkspacePath !== trigger.workspacePath;

  const lines = [
    BASE_SYSTEM_PROMPT,
    '',
    `<workrail_session_state>${sessionState}</workrail_session_state>`,
    '',
    '## Agent Rules and Philosophy',
    soulContent,
    '',
    `## Workspace: ${effectiveWorkspacePath}`,
  ];

  // When running in a worktree, add an explicit scope boundary so the agent never
  // accidentally reads roadmap docs, runs git log on main, or modifies the main checkout.
  // WHY: without this, the agent may drift to the main checkout for "context" (git log,
  // planning docs, roadmap) which (1) pollutes the session with coordinator work and
  // (2) can mutate the main checkout. This note is a hard constraint, not guidance.
  if (isWorktreeSession) {
    lines.push('');
    lines.push(`**Worktree session scope:** Your workspace is the isolated git worktree at \`${effectiveWorkspacePath}\`. Do not access, read, or modify the main checkout at \`${trigger.workspacePath}\`. Do not read planning docs, roadmap files, or backlog files. All Bash commands, file reads, and file writes must stay within your worktree path.`);
  }

  // Inject workspace context (CLAUDE.md / AGENTS.md) when available.
  if (workspaceContext !== null) {
    lines.push('');
    lines.push('## Workspace Context (from AGENTS.md / CLAUDE.md)');
    lines.push(workspaceContext);
  }

  // Inject assembled task context (prior session notes + git diff stat) when provided.
  // WHY before referenceUrls: task-specific runtime context should be visible before
  // static reference documents. Earlier position improves agent attention.
  const assembledContextSummary = trigger.context?.['assembledContextSummary'];
  if (typeof assembledContextSummary === 'string' && assembledContextSummary.trim().length > 0) {
    let ctxStr = assembledContextSummary as string;
    if (Buffer.byteLength(ctxStr, 'utf8') > MAX_ASSEMBLED_CONTEXT_BYTES) {
      ctxStr = ctxStr.slice(0, MAX_ASSEMBLED_CONTEXT_BYTES) + '\n[Prior context truncated at 8KB]';
    }
    lines.push('');
    lines.push('## Prior Context');
    lines.push(ctxStr.trim());
  }

  // Inject prior workspace session notes from WorkflowEnricher.
  // WHY after ## Prior Context: coordinator-assembled phase artifacts (discovery/shaping/coding
  // handoffs) are higher-signal than raw session recaps. Enricher notes follow to supplement.
  // WHY skip when assembledContextSummary present: the coordinator already provided richer
  // structured context; raw notes would be redundant and lower-signal.
  if (
    enricherResult !== undefined &&
    enricherResult.priorSessionNotes.length > 0 &&
    !(typeof trigger.context?.['assembledContextSummary'] === 'string' &&
      (trigger.context['assembledContextSummary'] as string).trim().length > 0)
  ) {
    lines.push('');
    lines.push('## Prior Workspace Notes');
    for (const note of enricherResult.priorSessionNotes) {
      const title = note.sessionTitle ?? note.sessionId.slice(0, 12);
      const branch = note.gitBranch ? ` (${note.gitBranch})` : '';
      const recap = note.recapSnippet ?? '(no recap)';
      lines.push(`**${title}**${branch}: ${recap}`);
    }
  }

  // Inject git diff stat from WorkflowEnricher.
  // WHY always inject (even when assembledContextSummary present): coordinators don't always
  // include changed-files lists, and the diff stat is cheap orientation context that never
  // conflicts with phase artifacts.
  if (enricherResult !== undefined && enricherResult.gitDiffStat !== null) {
    let diffStat = enricherResult.gitDiffStat;
    if (Buffer.byteLength(diffStat, 'utf8') > MAX_GIT_DIFF_STAT_BYTES) {
      // WHY Buffer subarray + TextDecoder: avoids the char-based slice pitfall where
      // a 2048-char slice of non-ASCII content exceeds 2048 bytes.
      diffStat = new TextDecoder().decode(Buffer.from(diffStat, 'utf8').subarray(0, MAX_GIT_DIFF_STAT_BYTES)) + '\n[diff stat truncated]';
    }
    lines.push('');
    lines.push('## Changed files');
    lines.push('```');
    lines.push(diffStat);
    lines.push('```');
  }

  // Append reference URLs section when provided.
  if (trigger.referenceUrls && trigger.referenceUrls.length > 0) {
    lines.push('');
    lines.push('## Reference documents');
    lines.push(
      'Before starting, fetch and read these reference documents: ' +
      trigger.referenceUrls.join(' '),
    );
    lines.push(
      'If you cannot fetch any of these documents, note their unavailability and proceed.',
    );
  }

  return lines.join('\n');
}
