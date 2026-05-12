# Design Review: Shared Pipeline Worktree

**Feature:** One coordinator-created git worktree for the entire pipeline run (discovery → shaping → coding → review), replacing per-session `branchStrategy: 'worktree'` for coding only.

**Reviewed design:** Two new `AdaptiveCoordinatorDeps` methods (`createPipelineWorktree`, `removePipelineWorktree`), optional `worktreePath` field on `PipelineRunContext`, coordinator creates worktree before first spawn and passes path to all sessions, cleanup in `finally` block.

---

## Tradeoff Review

| Tradeoff | Verdict |
|---|---|
| Uncommitted working-directory files for discovery/shaping output | Holds. Files are in the worktree's working directory and survive daemon restarts. No crash scenario loses them (worktree persists until coordinator's `finally` runs). |
| `CodingHandoffArtifactV1.branchName` becomes redundant for delivery | Acceptable. Field stays required in schema; coordinator ignores it for routing (already knows the branch). No consumers outside the two mode files. |
| `createPipelineContext` extended with optional `worktreePath` param | Clean. Builds the initial context object from scratch -- optional param is the natural extension point. No new dep method needed. |
| Escalation when crash-resume finds priorRunId but absent worktreePath | Safe default. Loses prior discovery/shaping work but avoids double-worktree creation. Acceptable for MVP. |

---

## Failure Mode Review

| Failure Mode | Coverage | Risk |
|---|---|---|
| Crash between worktree creation and context write | **Known gap (follow-up ticket 3):** startup recovery reads `DAEMON_SESSIONS_DIR` session sidecars to find orphaned worktrees -- pipeline context files are not scanned, so pipeline worktrees have no automated GC. Orphaned worktrees accumulate until manually removed. See `final-verification-findings.md`. | Medium |
| Crash recovery creates second worktree | Handled: existence check via `fs.access(worktreePath)` before reuse. Escalate with clear message if missing. | Low |
| AGENTS.md/CLAUDE.md absent from worktree | Not a failure mode. Committed files are present in every git worktree checkout. | None |
| Concurrent pipelines for same workspace | Not a failure mode. Each run gets a separate `runId` → separate worktree path and branch. | None |

**Highest-risk:** Pipeline worktree orphans from crashes -- startup recovery does not scan pipeline context files and cannot GC them automatically. Tracked in follow-up ticket 3.

---

## Runner-Up / Simpler Alternative Review

- **Simpler (coding+review only):** Fails core AC. Shaping writes `current-pitch.md` to `opts.workspace`; coding reads it from the worktree -- file is absent. Not viable.
- **Per-phase commit strategy:** Richer audit trail, cleaner crash recovery. Not worth the complexity for MVP (coordinator would need to track which files each phase wrote). Follow-up ticket.
- **Lazy creation (before coding only + copy):** More complex, more failure surface. Full approach is simpler.

---

## Philosophy Alignment

All principles satisfied:

- **Architectural fix over patch:** coordinator owns workspace lifecycle, not individual sessions
- **Make illegal states unrepresentable:** `createPipelineWorktree` returns `Result<string, string>` -- no code path reaches `spawnSession` with undefined path
- **Single source of state truth:** `PipelineRunContext.worktreePath` is the durable, authoritative path
- **DI for boundaries:** new methods on `AdaptiveCoordinatorDeps`, mode files remain I/O-free
- **Immutability:** context written atomically at creation, not mutated incrementally

No risky philosophy tensions identified.

---

## Findings

### Yellow: `CodingHandoffArtifactV1.branchName` stays required but is now ignored by the coordinator

The field is required in the Zod schema. The coding agent will emit it (as before). The coordinator no longer reads it for delivery routing. The field is now documentation-only. This is not a bug -- it's a minor schema debt. Acceptable for MVP; file a follow-up to make it optional.

### Yellow: Crash recovery for absent worktreePath escalates and loses prior phase work

If `priorRunId` is found but `worktreePath` is absent in `PipelineRunContext` (old-format context or write failure), the pipeline escalates rather than attempting recovery. For old-format contexts this is correct. For fresh runs where the write path failed, work is lost. The occurrence rate is very low (atomic write failure) and the cost is acceptable for MVP.

---

## Recommended Revisions

1. **Use `WORKTREES_DIR` for pipeline worktrees** -- `createPipelineWorktree` creates the worktree at `WORKTREES_DIR/<runId>`, not a new `pipeline-worktrees/` directory. Note: startup recovery does NOT automatically handle orphan cleanup for pipeline worktrees (it scans session sidecars, not pipeline context files). Automated GC is a follow-up ticket.

2. **Persist `worktreePath` via extended `createPipelineContext`** -- add `worktreePath?: string` as an optional 5th parameter. Pass the created path immediately after `createPipelineWorktree` succeeds. No new dep method needed.

3. **Worktree existence check on crash resume** -- in `runFullPipelineCore` and `runImplementCore`, when `priorRunId` and `PipelineRunContext.worktreePath` are found, call `fs.access(worktreePath)` before first spawn. Escalate with `phase: 'init', reason: 'prior pipeline worktree not found at <path>'` if missing.

4. **Remove `branchStrategy: 'worktree'` from coding `spawnSession` calls** -- all sessions now get `opts.workspace` replaced by `worktreePath`. The per-session worktree creation in `buildPreAgentSession` does not fire (no `branchStrategy` field on the trigger).

---

## Residual Concerns

- **Per-phase commit vs. uncommitted files:** The uncommitted approach is correct for MVP. A follow-up exploring per-phase commits (richer crash recovery, better audit trail) is captured as a follow-up ticket.
- **`branchName` schema migration:** Making `CodingHandoffArtifactV1.branchName` optional requires a separate PR with careful backward-compat analysis. Not in scope here.
- **`sectionWorktreeScope` system prompt:** With shared worktree, `trigger.workspacePath === sessionWorkspacePath` for all sessions, so the scope boundary paragraph is never injected. This is correct behavior -- all sessions own their workspace. No change needed.
