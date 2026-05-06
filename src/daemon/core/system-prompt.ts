// Pure functions only. No node:/SDK imports -- must be importable in any test context.

import type { WorkflowTrigger } from '../types.js';
import { extractContextSlots } from '../types.js';
import type { EnricherResult } from '../workflow-enricher.js';
export { DAEMON_SOUL_DEFAULT } from '../soul-template.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ASSEMBLED_CONTEXT_BYTES = 8192;

// ---------------------------------------------------------------------------
// BASE_SYSTEM_PROMPT
// ---------------------------------------------------------------------------

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
// truncateToByteLimit
// ---------------------------------------------------------------------------

function truncateToByteLimit(s: string, maxBytes: number, marker: string): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && Buffer.byteLength(s.slice(0, end), 'utf8') > maxBytes) end--;
  while (end > 0) {
    const code = s.charCodeAt(end - 1);
    if (code >= 0xD800 && code <= 0xDFFF) { end--; } else { break; }
  }
  const newlineIdx = s.lastIndexOf('\n', end);
  return (newlineIdx > 0 ? s.slice(0, newlineIdx) : s.slice(0, end)) + '\n' + marker;
}

// ---------------------------------------------------------------------------
// buildSessionRecap
// ---------------------------------------------------------------------------

// <workrail_session_state> tag is reserved in BASE_SYSTEM_PROMPT; using the same tag
// ensures the agent parses it consistently with the documented schema.
export function buildSessionRecap(notes: readonly string[]): string {
  if (notes.length === 0) return '';

  const formattedNotes = notes
    .map((note, i) => `### Prior step ${i + 1}\n${note}`)
    .join('\n\n');

  return `<workrail_session_state>\nThe following notes summarize prior steps from this session:\n\n${formattedNotes}\n</workrail_session_state>`;
}

// ---------------------------------------------------------------------------
// buildSystemPrompt -- pipeline of pure section functions
// ---------------------------------------------------------------------------

// Each section function returns string[] (lines to append) or [] to omit.
// buildSystemPrompt composes them in order. Adding a new section = adding one
// function and one entry in the pipeline array.

const MAX_GIT_DIFF_STAT_BYTES = 2048;

function sectionWorktreeScope(trigger: WorkflowTrigger, effectiveWorkspacePath: string): string[] {
  if (effectiveWorkspacePath === trigger.workspacePath) return [];
  return [
    '',
    `**Worktree session scope:** Your workspace is the isolated git worktree at \`${effectiveWorkspacePath}\`. Do not access, read, or modify the main checkout at \`${trigger.workspacePath}\`. Do not read planning docs, roadmap files, or backlog files. All Bash commands, file reads, and file writes must stay within your worktree path.`,
  ];
}

function sectionWorkspaceContext(workspaceContext: string | null): string[] {
  if (workspaceContext === null) return [];
  return ['', '## Workspace Context (from AGENTS.md / CLAUDE.md)', workspaceContext];
}

function sectionAssembledContext(trigger: WorkflowTrigger): string[] {
  const { assembledContextSummary } = extractContextSlots(trigger.context);
  if (!assembledContextSummary || assembledContextSummary.trim().length === 0) return [];
  const ctxStr = truncateToByteLimit(assembledContextSummary, MAX_ASSEMBLED_CONTEXT_BYTES, '[Prior context truncated at 8KB]');
  return ['', '## Prior Context', ctxStr.trim()];
}

function sectionPriorWorkspaceNotes(trigger: WorkflowTrigger, enricherResult: EnricherResult | undefined): string[] {
  if (!enricherResult || enricherResult.priorSessionNotes.length === 0) return [];
  // Skip when coordinator already provided richer assembled context.
  const { assembledContextSummary } = extractContextSlots(trigger.context);
  if (assembledContextSummary && assembledContextSummary.trim().length > 0) return [];
  const noteLines = enricherResult.priorSessionNotes.map((note) => {
    const title = note.sessionTitle ?? note.sessionId.slice(0, 12);
    const branch = note.gitBranch ? ` (${note.gitBranch})` : '';
    const recap = note.recapSnippet ?? '(no recap)';
    return `**${title}**${branch}: ${recap}`;
  });
  return ['', '## Prior Workspace Notes', ...noteLines];
}

function sectionChangedFiles(enricherResult: EnricherResult | undefined): string[] {
  if (!enricherResult || enricherResult.gitDiffStat === null) return [];
  const diffStat = Buffer.byteLength(enricherResult.gitDiffStat, 'utf8') > MAX_GIT_DIFF_STAT_BYTES
    ? new TextDecoder().decode(Buffer.from(enricherResult.gitDiffStat, 'utf8').subarray(0, MAX_GIT_DIFF_STAT_BYTES)) + '\n[diff stat truncated]'
    : enricherResult.gitDiffStat;
  return ['', '## Changed files', '```', diffStat, '```'];
}

function sectionReferenceUrls(trigger: WorkflowTrigger): string[] {
  if (!trigger.referenceUrls || trigger.referenceUrls.length === 0) return [];
  return [
    '',
    '## Reference documents',
    'Before starting, fetch and read these reference documents: ' + trigger.referenceUrls.join(' '),
    'If you cannot fetch any of these documents, note their unavailability and proceed.',
  ];
}

export function buildSystemPrompt(
  trigger: WorkflowTrigger,
  sessionState: string,
  soulContent: string,
  workspaceContext: string | null,
  effectiveWorkspacePath: string,
  enricherResult?: EnricherResult,
): string {
  const sections: string[][] = [
    [BASE_SYSTEM_PROMPT, '', `<workrail_session_state>${sessionState}</workrail_session_state>`, '', '## Agent Rules and Philosophy', soulContent, '', `## Workspace: ${effectiveWorkspacePath}`],
    sectionWorktreeScope(trigger, effectiveWorkspacePath),
    sectionWorkspaceContext(workspaceContext),
    sectionAssembledContext(trigger),
    sectionPriorWorkspaceNotes(trigger, enricherResult),
    sectionChangedFiles(enricherResult),
    sectionReferenceUrls(trigger),
  ];
  return sections.flat().join('\n');
}
