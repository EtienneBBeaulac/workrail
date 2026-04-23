# PR Review Coordinator Script: Design Candidates

*Discovery run: 2026-04-18. Three runs completed. Design settled.*

---

## Problem Understanding

### Core Tensions

1. **Parseability vs. output format:** The `mr-review-workflow` final step (`phase-6-final-handoff`) produces free-form markdown designed for human readers. The coordinator needs machine-parseable output. Adding `## COORDINATOR_OUTPUT` to the workflow prompt would make parsing reliable, but changes a workflow other users may run standalone. Decision: two-tier parser in coordinator only; update the workflow prompt as a separate follow-up.

2. **HTTP API vs. CLI subprocess for dispatch:** Using CLI subprocess (`execFile('worktrain', ['spawn', ...])`) is simpler (no port discovery logic), but loses context passing and adds subprocess overhead. Using HTTP directly (`POST /api/v2/auto/dispatch`) requires port discovery (same logic as `worktrain-spawn.ts`), but enables the `context` field. Decision: HTTP direct, copy port discovery pattern.

3. **Coordinator as CLI script vs. daemon workflow:** Could run the coordinator as a WorkRail workflow, getting durability. But that adds circular dependency (WorkRail spawning WorkRail sessions from inside a WorkRail session). The backlog explicitly says "scripts-first coordinator" -- deterministic TypeScript logic, not LLM orchestration. Decision: standalone CLI script.

4. **Fix-agent loop termination:** Max 3 passes is the rule, but what if pass 2 comes back minor again? Need another review pass. The tension: another review = another 15-minute wait. Solution: enforce max 3 passes strictly via counter, track in coordinator state per PR.

### What Makes This Hard

1. **Notes extraction requires 2 sequential HTTP calls:** `GET /api/v2/sessions/:id` must succeed and return a valid `preferredTipNodeId` before the node detail call. If either fails, coordinator must treat as `unknown` severity (conservative, escalate).

2. **Fix agent loop state management:** Need to track per-PR: pass count, current handle, previous findings. This is mutable state, which conflicts with the immutability preference. Resolution: keep loop counter local to the per-PR processing function, not exposed as shared state.

3. **`worktrain await` does NOT return session notes:** `await` returns only `{ results: [...SessionResult], allSucceeded }`. To get what the agent actually found, a separate 2-call HTTP sequence is needed after `await` returns.

4. **Keyword scan ambiguity:** The mr-review markdown may use ambiguous language (e.g., "minor architectural blocking concern"). Conservative default: `unknown` -> blocking always wins over minor.

### Likely Seam

The real seam is `CoordinatorDeps` -- all HTTP calls, CLI calls (`gh`, `git`), and stderr output sit behind this interface. The coordinator core is pure TypeScript with no side effects except through deps.

---

## Philosophy Constraints

Source: `/Users/etienneb/CLAUDE.md`

- **Immutability by default** -- coordinator state as read-only data structures; mutation only in explicit loop counters
- **Errors as data** -- `Result<T, E>` return types from `parseFindingsFromNotes()`, `getAgentResult()` -- no throws
- **Validate at boundaries** -- validate port, workspace path at CoordinatorDeps wiring time (CLI entry point), trust internally
- **DI for I/O** -- all fetch, execFile, stderr injected via CoordinatorDeps; no direct imports in coordinator core
- **Explicit domain types** -- `ReviewSeverity = 'clean' | 'minor' | 'blocking' | 'unknown'` not plain string
- **Exhaustiveness everywhere** -- switch on `ReviewSeverity` must be exhaustive
- **YAGNI with discipline** -- build this coordinator, not a coordinator framework

**No conflicts** between stated philosophy and repo patterns.

---

## Impact Surface

- `src/cli-worktrain.ts` -- adds `run pr-review` subcommand (minimal change, follows existing pattern)
- `src/cli/commands/index.ts` -- exports new command types
- `workflows/mr-review-workflow.agentic.v2.json` -- NOT changed in this PR; the coordinator's two-tier parser handles current output
- `POST /api/v2/auto/dispatch` -- used by coordinator via HTTP (no change to route)
- `GET /api/v2/sessions/:id` + `GET /api/v2/sessions/:id/nodes/:nodeId` -- read-only; no changes

---

## Candidates

### Candidate A: Minimal CLI Script (subprocess model)

**Summary:** `worktrain run pr-review` as a thin TypeScript wrapper shelling out to `worktrain spawn` and `worktrain await` CLIs via `execFile`, parsing stdout manually, calling `gh` directly.

- **Tensions resolved:** Simplest possible change; reuses existing CLI contracts
- **Tensions accepted:** No context passing; subprocess overhead; harder to test
- **Boundary:** CoordinatorDeps wraps `execFile` for all subprocess calls
- **Failure mode:** `worktrain spawn` output format change breaks coordinator silently
- **Repo-pattern relationship:** Departs -- `delivery-action.ts` uses direct function calls, not subprocesses
- **Gain:** Minimal new code
- **Loss:** No context passing, no type safety on spawn/await results, poor testability
- **Scope:** Too narrow
- **Philosophy:** Violates 'prefer fakes over mocks' (exec calls hard to fake cleanly); violates 'errors as data'

### Candidate B: HTTP-first with CoordinatorDeps Interface (RECOMMENDED)

**Summary:** `src/coordinators/pr-review.ts` with a `CoordinatorDeps` readonly interface. Core logic is pure functions. CLI wiring in `src/cli-worktrain.ts` provides real HTTP/CLI deps. Tests inject fakes.

**CoordinatorDeps interface:**
```typescript
interface CoordinatorDeps {
  readonly spawnSession: (workflowId: string, goal: string, workspace: string) => Promise<string>; // sessionHandle
  readonly awaitSessions: (handles: string[], timeoutMs?: number) => Promise<AwaitResult>;
  readonly getAgentResult: (sessionHandle: string) => Promise<string | null>; // recapMarkdown
  readonly listOpenPRs: (workspace: string) => Promise<PrSummary[]>;
  readonly mergePR: (prNumber: number, workspace: string) => Promise<void>;
  readonly postResult: (notes: string) => Promise<void>;
  readonly stderr: (line: string) => void;
  readonly now: () => number;
  readonly port: number;
}
```

**Pure functions:**
- `parseFindingsFromNotes(markdown: string | null): Result<ReviewFindings, string>` -- two-tier (JSON block first, keyword scan fallback)
- `classifySeverity(findings: ReviewFindings): ReviewSeverity`
- `buildFixGoal(prNumber: number, findings: ReviewFindings): string`

- **Tensions resolved:** Context passing possible (HTTP direct), type safety, testability, all 5 robustness rules
- **Tensions accepted:** Slightly more code vs A; port discovery logic duplicated from spawn.ts (intentional)
- **Boundary:** `CoordinatorDeps` -- exactly the same pattern as `WorktrainSpawnCommandDeps`
- **Failure mode:** `recapMarkdown` is null -> treated as `unknown` -> escalate (conservative, correct)
- **Repo-pattern relationship:** Follows `WorktrainSpawnCommandDeps` pattern exactly; adapts `parseHandoffArtifact` two-tier parser
- **Gain:** Full type safety, testable pure core, context passing, matches existing architecture
- **Loss:** More code (but correct code)
- **Scope:** Best-fit -- 3 new files
- **Philosophy:** Honors all -- immutability, DI for I/O, errors as data, explicit domain types, validate at boundaries, prefer fakes over mocks

### Candidate C: Generic Coordinator Framework + pr-review Instance

**Summary:** Build `src/coordinators/base.ts` with `CoordinatorDeps<TInput, TOutput>` generic and pipeline pattern, then implement pr-review as an instance.

- **Tensions resolved:** Extensibility for future coordinators
- **Tensions accepted:** Higher upfront complexity; forced generic mold may not fit next coordinator
- **Boundary:** Generic abstraction layer above CoordinatorDeps
- **Failure mode:** Framework abstraction doesn't fit next coordinator's shape
- **Repo-pattern relationship:** No existing coordinator framework to adapt; departs significantly
- **Gain:** Future reuse
- **Loss:** YAGNI violation -- second coordinator doesn't exist yet
- **Scope:** Too broad
- **Philosophy:** Violates YAGNI with discipline

---

## Comparison and Recommendation

**Recommendation: Candidate B**

Candidate B is the only option that:
1. Follows the established DI interface pattern (`WorktrainSpawnCommandDeps`) exactly
2. Enables the `getAgentResult` 2-call HTTP sequence in a testable way
3. Produces pure functions for finding parsing and severity classification
4. Enforces all 5 robustness rules with explicit typed state
5. Honors all CLAUDE.md philosophy principles

The scope is correct: 3 new files, clear boundaries, no speculative abstractions.

---

## Self-Critique

**Strongest counter-argument against B:** Port discovery logic is duplicated from `worktrain-spawn.ts`. A clean-design purist would extract it to a shared util. However, the coordinator is a standalone script in `src/coordinators/`, not part of the daemon machinery. Coupling it to internal daemon utils would be the wrong dependency direction. The duplication is intentional and bounded.

**What would tip toward A:** If context passing is never needed and the coordinator will always be a thin orchestrator. But the robustness rules (zombie detection, traceability JSON block) require typed interfaces, which Candidate A can't easily provide.

**What evidence would justify C:** A second coordinator (e.g., `groom-prs`, `security-audit`) that shares 50%+ of the shape. Currently speculative.

**Invalidating assumption:** If `GET /api/v2/sessions/:id/nodes/:nodeId` consistently returns `recapMarkdown: null` for the final step (e.g., because `requireConfirmation: true` nodes store notes differently). Mitigation already built in: null -> unknown -> escalate. The coordinator won't crash, it escalates conservatively.

---

## Open Questions for the Main Agent

1. Should `worktrain run pr-review` use a nested commander subcommand (`program.command('run').command('pr-review')`) or a flat command (`program.command('run pr-review')`)? Commander supports both; the existing commands all use flat style -- recommend flat.

2. For the serial merge sequence: should the coordinator do `git pull` before each `gh pr merge --squash`? Yes -- ensures clean base. But this is a coordinator behavior detail, not an architectural question.

3. Should the coordinator write a full report file (`coordinator-pr-review-YYYY-MM-DD.md`)? Yes, per UX spec. This is a simple file write via CoordinatorDeps.

4. Is `wr.coding-task` the correct fix-agent workflow? Yes -- it handles "implement/fix" tasks. The goal string `Fix review findings in PR #N: [finding summaries]` is the goal format.
