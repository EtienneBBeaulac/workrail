/**
 * WorkRail Auto: Delivery Action
 *
 * After a daemon workflow completes successfully, the trigger layer calls runDelivery()
 * to commit the agent's work and optionally open a PR.
 *
 * Design decisions:
 * - Scripts over agent (backlog.md): all delivery runs as child_process.execFile calls.
 *   The daemon reads the agent's structured handoff note and runs git/gh commands itself --
 *   never delegates to the LLM.
 * - parseHandoffArtifact() is pure (no I/O) -- testable in isolation.
 * - runDelivery() receives an injected execFn for testability (prefer fakes over mocks).
 * - DeliveryResult discriminated union makes outcomes observable without polluting
 *   WorkflowRunSuccess.
 * - filesChanged empty = skip (no git add -A fallback -- safety invariant).
 * - autoCommit/autoOpenPR default to false; flags.autoCommit !== true gates all delivery.
 * - ExecFn uses (file, args[]) instead of a shell string to prevent shell injection.
 *   User-controlled content (prBody, prTitle, file paths) never passes through /bin/sh.
 * - prBody is written to a temp file and passed via --body-file to avoid shell quoting
 *   entirely. The temp file is deleted in a finally block.
 *   Known limitation: temp file is NOT deleted on SIGKILL (OS cleans tmpdir on reboot).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Result } from '../runtime/result.js';
import { ok, err } from '../runtime/result.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Structured handoff artifact written by the agent at the end of a workflow.
 *
 * The agent writes this as a JSON fenced block in its final step notes.
 * The daemon reads it to build the commit message and PR parameters.
 */
export interface HandoffArtifact {
  /** Commit type: feat / fix / chore / refactor / docs / test / perf */
  readonly commitType: string;
  /** Commit scope: product area (console / mcp / workflows / engine / schema / docs) */
  readonly commitScope: string;
  /** Commit subject: imperative mood, max 72 chars total with type(scope): prefix */
  readonly commitSubject: string;
  /** PR title: same as the full commit first line */
  readonly prTitle: string;
  /** PR body: markdown with ## Summary and ## Test plan */
  readonly prBody: string;
  /** Every file created or modified in this workflow run */
  readonly filesChanged: readonly string[];
  /** Deferred items; may be empty */
  readonly followUpTickets: readonly string[];
}

/**
 * Delivery flags from TriggerDefinition.
 * Both default to false (opt-in semantics).
 */
export interface DeliveryFlags {
  /** When true, run git add + git commit after a successful workflow run. */
  readonly autoCommit?: boolean;
  /** When true (and autoCommit is also true), run gh pr create after the commit. */
  readonly autoOpenPR?: boolean;
}

/**
 * Result of a delivery run.
 *
 * Uses a discriminated union so callers can react to outcomes without parsing
 * log output. The trigger layer logs the result and continues regardless.
 */
export type DeliveryResult =
  | { readonly _tag: 'committed'; readonly sha: string }
  | { readonly _tag: 'pr_opened'; readonly url: string }
  | { readonly _tag: 'skipped'; readonly reason: string }
  | {
      readonly _tag: 'error';
      /**
       * Phase where the error occurred.
       * - 'parse': handoff artifact could not be parsed from notes
       * - 'commit': git add/commit failed
       * - 'pr': gh pr create failed (commit may have succeeded)
       */
      readonly phase: 'parse' | 'commit' | 'pr';
      /** stdout + stderr from the failed exec call, or parse error message */
      readonly details: string;
    };

/**
 * Injectable exec function for testability.
 *
 * Matches the signature of promisify(execFile): takes a binary path and an args array
 * rather than a shell command string. This makes shell injection impossible -- user-controlled
 * content (commit messages, PR titles, file paths) is passed as discrete arguments and
 * is never interpolated into a shell string.
 *
 * WHY args array, not shell string: child_process.execFile() does NOT invoke /bin/sh.
 * Backticks, $(), and other shell metacharacters in the args are passed literally to the
 * subprocess. There is no shell expansion.
 */
export type ExecFn = (
  file: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum wall-clock time for a single git or gh command.
 * Delivery commands should complete quickly; 60s is a generous timeout.
 */
const DELIVERY_TIMEOUT_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// parseHandoffArtifact
// ---------------------------------------------------------------------------

/**
 * Extract the structured handoff artifact from a workflow step's notesMarkdown.
 *
 * Strategy (in priority order):
 * 1. JSON fenced block: look for ```json\n{...}\n``` and JSON.parse the contents.
 *    This is the stable machine-parseable format produced by updated workflow prompts.
 * 2. Line-scan fallback: look for `key: value` patterns in the text.
 *    This is a fallback for older prompts or cases where the LLM did not produce
 *    a JSON block. Covers the current fast-path prompt's bullet-list format.
 *
 * WHY two strategies: the line-scan fallback ensures the feature works during the
 * transition period when workflow prompts have not yet been updated. The JSON block
 * is the stable contract going forward.
 *
 * Returns ok(HandoffArtifact) on success, err(reason) on failure.
 */
export function parseHandoffArtifact(notes: string): Result<HandoffArtifact, string> {
  if (!notes || notes.trim() === '') {
    return err('notes is empty');
  }

  // Strategy 1: JSON fenced blocks (try ALL blocks before falling through to line-scan)
  //
  // WHY matchAll instead of match: the notes may contain multiple ```json blocks (e.g.
  // one for context and one for the handoff artifact). If the first block parses as valid
  // JSON but fails assembleArtifact validation (missing required fields), we must try the
  // remaining blocks before giving up. Using match() would stop at the first block.
  const jsonBlockRe = /```json\s*\n([\s\S]*?)\n```/g;
  for (const blockMatch of notes.matchAll(jsonBlockRe)) {
    const blockContent = blockMatch[1];
    if (!blockContent) continue;
    try {
      const parsed = JSON.parse(blockContent) as Record<string, unknown>;
      const artifact = assembleArtifact(parsed);
      if (artifact.kind === 'ok') return ok(artifact.value);
      // assembleArtifact failed (missing required fields) -- try next block
    } catch {
      // JSON parse failed -- try next block
    }
  }

  // Strategy 2: Line-scan fallback
  // Matches patterns like:
  //   - `commitType`: feat
  //   - commitType: feat
  //   * commitType: feat
  const fields: Record<string, string> = {};
  const lines = notes.split('\n');
  for (const line of lines) {
    // Match optional list prefix (- or *), optional backtick-quoted key, colon, value
    const match = line.match(/^[-*]?\s*`?(\w+)`?\s*:\s*(.+)$/);
    if (match && match[1] && match[2]) {
      const key = match[1].trim();
      const value = match[2].trim().replace(/^`|`$/g, ''); // strip surrounding backticks
      fields[key] = value;
    }
  }

  // Attempt to extract filesChanged from a bullet list after `filesChanged:`
  // The agent may write it as:
  //   filesChanged:
  //     - src/foo.ts
  //     - src/bar.ts
  const filesChangedIdx = notes.indexOf('filesChanged');
  if (filesChangedIdx !== -1) {
    const afterFilesChanged = notes.slice(filesChangedIdx);
    const fileMatches = afterFilesChanged.matchAll(/^\s*-\s+(.+)$/mg);
    const fileList: string[] = [];
    for (const fm of fileMatches) {
      if (fm[1]) fileList.push(fm[1].trim());
    }
    if (fileList.length > 0) {
      fields['filesChanged'] = JSON.stringify(fileList);
    }
  }

  if (Object.keys(fields).length === 0) {
    return err('no parseable handoff fields found in notes (no JSON block and no key: value lines)');
  }

  // Parse filesChanged: could be a JSON array string or comma-separated
  let filesChanged: string[] = [];
  if (fields['filesChanged']) {
    try {
      const parsed = JSON.parse(fields['filesChanged']);
      if (Array.isArray(parsed)) {
        filesChanged = parsed.filter((s): s is string => typeof s === 'string');
      }
    } catch {
      // Not JSON -- try comma-separated
      filesChanged = fields['filesChanged'].split(',').map(s => s.trim()).filter(Boolean);
    }
  }

  const assembled = assembleArtifact({
    commitType: fields['commitType'],
    commitScope: fields['commitScope'],
    commitSubject: fields['commitSubject'],
    prTitle: fields['prTitle'],
    prBody: fields['prBody'],
    filesChanged,
    followUpTickets: [],
  });

  return assembled;
}

/**
 * Validate and assemble a HandoffArtifact from a parsed object.
 * Returns err(reason) if any required field is missing or invalid.
 */
function assembleArtifact(raw: Record<string, unknown>): Result<HandoffArtifact, string> {
  const requiredStrings = ['commitType', 'commitScope', 'commitSubject', 'prTitle', 'prBody'] as const;
  for (const field of requiredStrings) {
    if (!raw[field] || typeof raw[field] !== 'string' || !(raw[field] as string).trim()) {
      return err(`missing or empty required field: ${field}`);
    }
  }

  // filesChanged must be a non-empty array of strings
  const filesRaw = raw['filesChanged'];
  if (!Array.isArray(filesRaw)) {
    return err('filesChanged must be an array');
  }
  const filesChanged = (filesRaw as unknown[]).filter((s): s is string => typeof s === 'string');
  if (filesChanged.length === 0) {
    return err('filesChanged is empty -- cannot stage files safely');
  }

  const followUpTickets = Array.isArray(raw['followUpTickets'])
    ? (raw['followUpTickets'] as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];

  return ok({
    commitType: (raw['commitType'] as string).trim(),
    commitScope: (raw['commitScope'] as string).trim(),
    commitSubject: (raw['commitSubject'] as string).trim(),
    prTitle: (raw['prTitle'] as string).trim(),
    prBody: (raw['prBody'] as string).trim(),
    filesChanged,
    followUpTickets,
  });
}

// ---------------------------------------------------------------------------
// runDelivery
// ---------------------------------------------------------------------------

/**
 * Run post-workflow delivery: git commit and optionally gh pr create.
 *
 * WHY scripts over agent: git commit and gh pr create are deterministic operations
 * with no ambiguity. The daemon runs them directly from the agent's structured handoff
 * note -- never delegating to the LLM. This is faster, cheaper, and more reliable.
 *
 * Safety invariants (enforced here, not just at config parse time):
 * - flags.autoCommit !== true: skip delivery (opt-in only)
 * - artifact.filesChanged.length === 0: skip delivery (no git add -A)
 * - flags.autoOpenPR without autoCommit: unreachable (autoCommit check comes first)
 *
 * @param artifact - The parsed handoff artifact from the agent's notes
 * @param workspacePath - Absolute path to use as the git working directory (cwd)
 * @param flags - autoCommit and autoOpenPR flags from the trigger definition
 * @param execFn - Injectable exec function (use promisify(execFile) in production; fake in tests)
 */
export async function runDelivery(
  artifact: HandoffArtifact,
  workspacePath: string,
  flags: DeliveryFlags,
  execFn: ExecFn,
): Promise<DeliveryResult> {
  // Gate 1: autoCommit must be explicitly true (opt-in semantics)
  if (flags.autoCommit !== true) {
    return { _tag: 'skipped', reason: 'autoCommit is not enabled for this trigger' };
  }

  // Gate 2: filesChanged must be non-empty (no git add -A fallback)
  if (artifact.filesChanged.length === 0) {
    return {
      _tag: 'skipped',
      reason: 'filesChanged is empty -- cannot stage files safely (no git add -A fallback)',
    };
  }

  // Build commit message: "<type>(<scope>): <subject>"
  // The subject already includes the full first line per the workflow prompt.
  // If commitSubject already starts with type(scope), use it as-is; otherwise build it.
  const commitMessage = artifact.commitSubject.startsWith(`${artifact.commitType}(`)
    ? artifact.commitSubject
    : `${artifact.commitType}(${artifact.commitScope}): ${artifact.commitSubject}`;

  // Stage and commit the specific files from filesChanged.
  //
  // WHY two separate execFile calls instead of one "git add && git commit" shell string:
  // execFile does NOT invoke /bin/sh -- it passes args directly to the subprocess.
  // Shell metacharacters (&&, ;, backticks, $()) in args are passed literally and have
  // no effect. Chaining commands requires two calls.
  //
  // WHY not git add -A: only stage files the agent declares it changed (safety invariant).
  // Passing files as individual args handles paths with spaces -- no quoting needed.
  let commitStdout: string;
  let commitStderr: string;
  try {
    // Step 1: git add <file1> <file2> ...
    await execFn('git', ['add', ...artifact.filesChanged], { cwd: workspacePath, timeout: DELIVERY_TIMEOUT_MS });
    // Step 2: git commit -m <message>
    const commitResult = await execFn('git', ['commit', '-m', commitMessage], { cwd: workspacePath, timeout: DELIVERY_TIMEOUT_MS });
    commitStdout = commitResult.stdout;
    commitStderr = commitResult.stderr;
  } catch (e: unknown) {
    const details = formatExecError(e);
    return { _tag: 'error', phase: 'commit', details };
  }

  // Extract the commit SHA from git commit output (e.g. "[main abc1234] message")
  const shaMatch = (commitStdout + commitStderr).match(/\[[\w/]+ ([0-9a-f]+)\]/);
  const sha = shaMatch?.[1] ?? 'unknown';

  // If autoOpenPR is not set, we are done after the commit.
  if (flags.autoOpenPR !== true) {
    return { _tag: 'committed', sha };
  }

  // Open PR via gh pr create.
  //
  // WHY --body-file instead of --body: prBody is arbitrary markdown that may contain
  // backticks, $(), newlines, and other characters that are unsafe in shell arguments.
  // Writing to a temp file sidesteps shell quoting entirely -- the file content is passed
  // to gh verbatim.
  //
  // The temp file is deleted in a finally block. Known limitation: SIGKILL prevents
  // finally from running, but OS temp dirs are cleaned on reboot.
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `workrail-pr-body-${crypto.randomUUID()}.md`);

  let prStdout: string;
  try {
    await fs.writeFile(tmpFile, artifact.prBody, 'utf8');
    try {
      const prResult = await execFn(
        'gh',
        ['pr', 'create', '--title', artifact.prTitle, '--body-file', tmpFile],
        { cwd: workspacePath, timeout: DELIVERY_TIMEOUT_MS },
      );
      prStdout = prResult.stdout;
    } catch (e: unknown) {
      // Commit already succeeded; PR failed. Log clearly so operator knows.
      const details = `commit succeeded (sha: ${sha}) but PR creation failed: ${formatExecError(e)}`;
      return { _tag: 'error', phase: 'pr', details };
    }
  } catch (e: unknown) {
    // WHY: fs.writeFile can throw (disk full, tmpdir quota exceeded). Without this catch,
    // the exception exits runDelivery uncaught and becomes a floating unhandled rejection
    // in the void queue.enqueue() callback. Node 20 exits the process on unhandled rejection.
    // This catch converts writeFile failures to a DeliveryResult so the daemon never crashes.
    return { _tag: 'error', phase: 'pr', details: formatExecError(e) };
  } finally {
    // Always delete the temp file, even if gh failed or threw.
    await fs.unlink(tmpFile).catch(() => {
      // Ignore unlink errors -- the file may already be gone or tmpdir may be read-only.
    });
  }

  // Extract PR URL from gh output (typically the last line)
  const prUrl = prStdout.trim().split('\n').at(-1)?.trim() ?? '';

  return { _tag: 'pr_opened', url: prUrl };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format an exec error for inclusion in DeliveryResult.details.
 * Captures stdout + stderr from the failed command if available.
 */
function formatExecError(e: unknown): string {
  if (e instanceof Error) {
    const execErr = e as Error & { stdout?: string; stderr?: string };
    const parts = [e.message];
    if (execErr.stdout) parts.push(`stdout: ${execErr.stdout}`);
    if (execErr.stderr) parts.push(`stderr: ${execErr.stderr}`);
    return parts.join(' | ');
  }
  return String(e);
}
