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
  /**
   * When false, skip the secret scan before committing. Default: true (scan runs by default).
   *
   * WHY opt-out semantics (not opt-in): the safer default is to scan. Users who encounter
   * false positives from the Generic secret assign pattern can explicitly opt out with
   * secretScan: false in their trigger config.
   */
  readonly secretScan?: boolean;
  /**
   * Process-local session UUID used to construct the expected branch name for HEAD assertion.
   * Only set when branchStrategy === 'worktree'. When present (with branchPrefix), runDelivery()
   * asserts the current HEAD branch matches `${branchPrefix}${sessionId}` before staging files.
   *
   * WHY sessionId not expectedBranch: the session UUID is already used as the worktree path
   * component and branch name suffix. Passing it here (rather than the full branch name) keeps
   * the contract consistent with how the branch was created in runWorkflow().
   */
  readonly sessionId?: string;
  /**
   * Branch prefix used to construct the expected HEAD branch name for assertion.
   * Only meaningful when sessionId is also set. Defaults to 'worktrain/' if absent.
   * Full expected branch: `${branchPrefix}${sessionId}`.
   */
  readonly branchPrefix?: string;
  /**
   * Trigger ID sourced from TriggerDefinition.id.
   * Used in the PR body footer to identify which trigger produced this PR.
   * When absent, the footer omits the trigger field.
   */
  readonly triggerId?: string;
  /**
   * Workflow ID sourced from TriggerDefinition.workflowId.
   * Used in the PR body footer to identify which workflow produced this PR.
   * When absent, the footer omits the workflow field.
   */
  readonly workflowId?: string;
  /**
   * Optional bot identity for per-command git attribution.
   *
   * When present, git commit is called with `-c user.name=X -c user.email=Y` flags
   * instead of relying on the persisted git config. This is safe across parallel worktrees --
   * identity is scoped to the single command, not written to the shared .git/config.
   *
   * WHY per-command (not git config): git config --local writes to the shared .git/config,
   * which is shared across all worktrees of the same repo. In parallel sessions, last writer
   * wins and silently stomps other sessions' identities. Per-command -c flags have no
   * persistent side effects.
   *
   * When absent, git commit uses the git config identity already in the environment.
   */
  readonly botIdentity?: {
    readonly name: string;
    readonly email: string;
  };
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
       * - 'secret_scan': staged diff contains a potential secret (delivery aborted before commit)
       * - 'commit': git add/commit failed
       * - 'pr': gh pr create failed (commit may have succeeded)
       */
      readonly phase: 'parse' | 'secret_scan' | 'commit' | 'pr';
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
// Secret scanning
// ---------------------------------------------------------------------------

/**
 * Result of a secret scan over a staged diff.
 *
 * WHY no matchedValue field: we must NEVER log or surface the actual secret value,
 * even in error messages or internal logs. Omitting the field from the type makes
 * it structurally impossible to accidentally include the matched value downstream.
 * Only the pattern name, file path, and line number are safe to surface.
 */
export interface SecretScanResult {
  readonly found: boolean;
  readonly findings: ReadonlyArray<{
    readonly name: string;
    readonly file: string;
    readonly lineNumber: number;
  }>;
}

/**
 * Secret patterns to scan for in staged diffs.
 *
 * Each entry has a human-readable name (for error messages) and a regex with the global flag.
 * WHY global flag: allows matchAll() to find ALL occurrences per line, not just the first.
 * WHY reset lastIndex before each use: global regexes maintain state across calls.
 * These patterns are the baseline; gitleaks is the optional upgrade.
 */
const SECRET_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: 'GitHub token',          pattern: /ghp_[A-Za-z0-9]{36}/g },
  { name: 'GitHub OAuth token',    pattern: /gho_[A-Za-z0-9]{36}/g },
  { name: 'GitHub app token',      pattern: /ghs_[A-Za-z0-9]{36}/g },
  { name: 'OpenAI key',            pattern: /sk-[A-Za-z0-9]{48}/g },
  { name: 'Anthropic key',         pattern: /sk-ant-[A-Za-z0-9\-_]{90,}/g },
  { name: 'AWS access key',        pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'AWS secret key',        pattern: /[Aa][Ww][Ss][._-]?[Ss][Ee][Cc][Rr][Ee][Tt][._-]?[Kk][Ee][Yy]\s*[:=]\s*['"]?[A-Za-z0-9+\/]{40}/g },
  { name: 'Slack token',           pattern: /xox[aboprs]-[A-Za-z0-9\-]+/g },
  { name: 'Private key',           pattern: /-----BEGIN [A-Z]+ PRIVATE KEY-----/g },
  { name: 'Generic secret assign', pattern: /(?:password|passwd|secret|api[_-]?key|auth[_-]?token)\s*[:=]\s*['"][^'"]{8,}/gi },
];

/**
 * Scan a unified diff string for potential secrets.
 *
 * Strategy:
 * 1. Parse the diff to extract file names and added lines (lines starting with '+').
 * 2. Track file names from '+++' diff headers and line numbers from '@@ -l,s +l,s @@' hunks.
 * 3. For each added line, run all SECRET_PATTERNS against the content (after stripping the '+').
 * 4. Collect findings without capturing the matched value.
 *
 * WHY only '+' lines: removed lines are secrets being deleted (good). Context lines are
 * unchanged and were already committed (would produce false positives). Only added lines
 * represent new content being introduced.
 *
 * WHY parse hunk headers for line numbers: allows operators to navigate directly to the
 * offending line in their editor rather than searching the file for the pattern.
 *
 * @param diff - Output of `git diff --cached` (unified diff format)
 * @returns SecretScanResult with found=false if no secrets detected
 */
export function scanForSecrets(diff: string): SecretScanResult {
  // Empty diff = nothing staged = nothing to scan
  if (!diff.trim()) {
    return { found: false, findings: [] };
  }

  const findings: Array<{ name: string; file: string; lineNumber: number }> = [];

  // Parse unified diff line by line
  const lines = diff.split('\n');
  let currentFile = '(unknown)';
  let currentLineNumber = 0;

  for (const line of lines) {
    // Track current file from '+++' header (e.g., '+++ b/src/foo.ts')
    if (line.startsWith('+++ ')) {
      // Strip 'b/' prefix from git diff output ('+++ b/src/foo.ts' -> 'src/foo.ts')
      const filePath = line.slice(4);
      currentFile = filePath.startsWith('b/') ? filePath.slice(2) : filePath;
      currentLineNumber = 0;
      continue;
    }

    // Parse hunk header to get the starting line number of the new file block
    // Format: @@ -old_start[,old_count] +new_start[,new_count] @@ [context]
    if (line.startsWith('@@')) {
      const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch?.[1] !== undefined) {
        // new_start - 1 because we increment before checking each line
        currentLineNumber = parseInt(hunkMatch[1], 10) - 1;
      }
      continue;
    }

    // Skip diff metadata lines (--- header, diff --git, index lines, etc.)
    if (line.startsWith('--- ') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('\\')) {
      continue;
    }

    // Context lines (unchanged): advance the new-file line counter
    if (line.startsWith(' ')) {
      currentLineNumber++;
      continue;
    }

    // Removed lines: do NOT advance the new-file line counter (these lines are not in the new file)
    if (line.startsWith('-')) {
      continue;
    }

    // Added lines: advance counter and scan for secrets
    if (line.startsWith('+')) {
      currentLineNumber++;
      const content = line.slice(1); // Strip leading '+'

      for (const { name, pattern } of SECRET_PATTERNS) {
        // Reset lastIndex before each use -- global regexes maintain state across calls
        pattern.lastIndex = 0;
        if (pattern.test(content)) {
          findings.push({ name, file: currentFile, lineNumber: currentLineNumber });
          // WHY break after first pattern match per line: one finding per line is sufficient.
          // Reporting multiple findings on the same line adds noise without operator value.
          // The operator needs to find the line and review it -- the first match is enough signal.
          break;
        }
        // Reset again after test() to leave the regex in a clean state
        pattern.lastIndex = 0;
      }
    }
  }

  return {
    found: findings.length > 0,
    findings,
  };
}

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

  // Gate 3 (worktree sessions only): assert HEAD branch matches expected branch before staging.
  //
  // WHY: when branchStrategy === 'worktree', the agent should have been working on
  // worktrain/<sessionId>. If HEAD points elsewhere (e.g. the agent ran git checkout),
  // pushing would corrupt an unrelated branch. This assertion is the last safety check.
  //
  // WHY errors as data (not throw): branch mismatch returns DeliveryResult, not an exception.
  // Callers (trigger-router) log the result and continue regardless.
  if (flags.sessionId) {
    const expectedBranch = `${flags.branchPrefix ?? 'worktrain/'}${flags.sessionId}`;
    let headBranch: string;
    try {
      const result = await execFn(
        'git',
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        { cwd: workspacePath, timeout: DELIVERY_TIMEOUT_MS },
      );
      headBranch = result.stdout.trim();
    } catch (e: unknown) {
      return {
        _tag: 'error',
        phase: 'commit',
        details: `HEAD branch check failed (cannot stage): ${formatExecError(e)}`,
      };
    }

    if (headBranch !== expectedBranch) {
      return {
        _tag: 'error',
        phase: 'commit',
        details:
          `HEAD branch mismatch: expected "${expectedBranch}" but found "${headBranch}". ` +
          `Refusing to stage or push -- the agent may have switched branches. ` +
          `Worktree path: ${workspacePath}`,
      };
    }
  }

  // Build commit message: "<type>(<scope>): <subject>"
  // The subject already includes the full first line per the workflow prompt.
  // If commitSubject already starts with type(scope), use it as-is; otherwise build it.
  const baseCommitMessage = artifact.commitSubject.startsWith(`${artifact.commitType}(`)
    ? artifact.commitSubject
    : `${artifact.commitType}(${artifact.commitScope}): ${artifact.commitSubject}`;

  // Attribution trailers: appended to every commit WorkTrain opens.
  //
  // WHY always (not conditional on botIdentity): attribution signals identify WorkTrain
  // commits in git log and blame regardless of which git identity signed the commit.
  // The Co-authored-by trailer is a GitHub-recognized convention that surfaces in PR UIs.
  //
  // WHY Worktrain-Session (not X-Worktrain-Session): git trailers do not require the X-
  // prefix. Using a clean namespace avoids confusion with HTTP headers.
  const trailers = [
    ...(flags.sessionId ? [`Worktrain-Session: ${flags.sessionId}`] : []),
    'Co-authored-by: WorkTrain <worktrain@noreply.local>',
  ].join('\n');
  const commitMessage = `${baseCommitMessage}\n\n${trailers}`;

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

    // Step 2: Secret scan -- run after staging so `git diff --cached` shows the full staged diff.
    //
    // WHY scan after git add, before git commit: the staged diff represents exactly what is about
    // to be committed. Scanning before git add would miss newly staged content; scanning after
    // git commit would be too late. git diff --cached is the only window where we see the precise
    // content being committed.
    //
    // WHY secretScan !== false (not === true): opt-out semantics -- scan is the safe default.
    // Only explicit secretScan: false bypasses the scan.
    if (flags.secretScan !== false) {
      let stagedDiff = '';
      try {
        const diffResult = await execFn('git', ['diff', '--cached'], { cwd: workspacePath, timeout: DELIVERY_TIMEOUT_MS });
        stagedDiff = diffResult.stdout;
      } catch (e: unknown) {
        // git diff --cached failure after a successful git add is unexpected.
        // Abort delivery -- we cannot commit safely without scanning.
        return {
          _tag: 'error',
          phase: 'secret_scan',
          details: `Failed to retrieve staged diff for secret scan: ${formatExecError(e)}\nDelivery aborted.`,
        };
      }

      const scanResult = scanForSecrets(stagedDiff);
      if (scanResult.found) {
        const findingLines = scanResult.findings
          .map(f => `  - ${f.name} in ${f.file}:${f.lineNumber}`)
          .join('\n');
        return {
          _tag: 'error',
          phase: 'secret_scan',
          details:
            `Secret scan detected potential secrets in staged files:\n${findingLines}\n` +
            `Delivery aborted. Review and remove secrets before retrying.\n` +
            `Set secretScan: false in your trigger config to bypass this check.`,
        };
      }

      // Optional upgrade: run gitleaks if available.
      // WHY gitleaks is optional: the pattern scan is the baseline. gitleaks provides broader
      // coverage but requires an external binary. If not installed (ENOENT), skip silently.
      // WHY check exit code only (not stdout): gitleaks prints findings to stdout, but the
      // authoritative signal is the exit code (0 = clean, non-zero = found secrets).
      try {
        await execFn(
          'gitleaks',
          ['detect', '--source', '.', '--staged', '--no-git'],
          { cwd: workspacePath, timeout: DELIVERY_TIMEOUT_MS },
        );
        // exit code 0: no secrets found by gitleaks -- continue
      } catch (e: unknown) {
        const execErr = e as Error & { code?: string };
        if (execErr.code === 'ENOENT') {
          // gitleaks binary not found -- skip silently (optional upgrade not installed)
        } else {
          // Non-zero exit code: gitleaks found secrets (or failed with an error).
          // Treat any non-ENOENT failure as a signal to abort delivery.
          return {
            _tag: 'error',
            phase: 'secret_scan',
            details:
              `gitleaks detected potential secrets in staged files.\n` +
              `Delivery aborted. Review and remove secrets before retrying.\n` +
              `Set secretScan: false in your trigger config to bypass this check.`,
          };
        }
      }
    }

    // Step 3: git commit -m <message> [with optional per-command identity]
    //
    // WHY -c user.name/user.email instead of git config: git config --local writes to the
    // shared .git/config, which is shared across all worktrees. In parallel sessions, last
    // writer wins and silently stomps other sessions' identities. Per-command -c flags scope
    // identity to this single command and have no persistent side effects.
    //
    // WHY only when botIdentity is set: if no bot identity is configured, use whatever git
    // config identity is already in the environment (the operator's own identity).
    const commitArgs: string[] = flags.botIdentity
      ? [
          '-c', `user.name=${flags.botIdentity.name}`,
          '-c', `user.email=${flags.botIdentity.email}`,
          'commit', '-m', commitMessage,
        ]
      : ['commit', '-m', commitMessage];
    const commitResult = await execFn('git', commitArgs, { cwd: workspacePath, timeout: DELIVERY_TIMEOUT_MS });
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

  // Build PR title with [WT] prefix.
  //
  // WHY always (not conditional on botIdentity): the prefix identifies the PR as WorkTrain-
  // generated regardless of which git identity was used. Operators need to distinguish
  // WorkTrain PRs in PR lists without checking commit trailers.
  //
  // WHY idempotent guard: prevents a double prefix if the agent writes [WT] in the handoff
  // artifact. The agent should NOT include [WT] (it is infrastructure, not agent content),
  // but the guard protects against accidental contamination.
  const prTitle = artifact.prTitle.startsWith('[WT] ')
    ? artifact.prTitle
    : `[WT] ${artifact.prTitle}`;

  // Build PR body with attribution footer.
  //
  // WHY always (not conditional on botIdentity): the footer provides traceability for any
  // WorkTrain-generated PR. Operators and reviewers need to find the session, trigger, and
  // workflow that produced this PR without digging through logs.
  const footerParts: string[] = ['---', '\u{1F916} **Automated by WorkTrain**'];
  if (flags.sessionId) footerParts.push(`Session: \`${flags.sessionId}\``);
  if (flags.triggerId) footerParts.push(`Trigger: \`${flags.triggerId}\``);
  if (flags.workflowId) footerParts.push(`Workflow: \`${flags.workflowId}\``);
  const prBodyWithFooter = `${artifact.prBody}\n\n${footerParts.join(' | ')}`;

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
    await fs.writeFile(tmpFile, prBodyWithFooter, 'utf8');
    try {
      const prResult = await execFn(
        'gh',
        ['pr', 'create', '--title', prTitle, '--body-file', tmpFile],
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

  // Add worktrain:generated label to the PR.
  //
  // WHY non-fatal: label creation is best-effort. If gh label create or gh pr edit fails
  // (permissions, network, API error), the PR was already opened successfully. Failing the
  // entire delivery for a missing label would be a worse outcome than missing the label.
  //
  // WHY two calls (label create then pr edit): gh pr create --label requires the label to
  // already exist. Creating it first is idempotent (2>/dev/null || true equivalent via
  // try/catch). Then pr edit adds it to the specific PR by URL.
  //
  // WHY if (prUrl): gh pr edit requires a valid PR URL or number. If gh pr create returned
  // empty output, prUrl is '' and gh pr edit would fail with an unhelpful error.
  if (prUrl) {
    try {
      await execFn(
        'gh',
        ['label', 'create', 'worktrain:generated', '--description', 'PR authored by WorkTrain', '--color', '0075ca'],
        { cwd: workspacePath, timeout: DELIVERY_TIMEOUT_MS },
      );
    } catch {
      // Label may already exist -- ignore the error and proceed to gh pr edit.
    }
    try {
      await execFn(
        'gh',
        ['pr', 'edit', prUrl, '--add-label', 'worktrain:generated'],
        { cwd: workspacePath, timeout: DELIVERY_TIMEOUT_MS },
      );
    } catch (e: unknown) {
      // Non-fatal: log the failure so operators can investigate, but do not change the result.
      console.warn(
        `[runDelivery] WARNING: Failed to add worktrain:generated label to PR ${prUrl}: ` +
        `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

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
