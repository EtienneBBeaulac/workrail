# Design Candidates: triggers.yml Validator

*Raw investigative material for main agent synthesis. See trigger-validator.md for the full design doc.*

---

## Problem Understanding

### Core Tensions

**Tension A: Fail-fast vs. partial degradation**
trigger-listener.ts currently uses skip-and-continue for invalid triggers (not daemon-fatal). Adding hard errors to validateAndResolveTrigger() causes affected triggers to be skipped at startup, not the daemon. This is the correct behavior for a multi-trigger deployment, but means the operator needs to notice the warning in startup logs.

**Tension B: Explicit config vs. sensible defaults**
Forcing maxSessionMinutes on every trigger adds config noise. The true danger fields are branchStrategy and concurrencyMode. The design must not over-constrain safe defaults.

**Tension C: Startup validation vs. validate subcommand**
Hard errors at startup (trigger skipped, logged) are the safety net. The validate subcommand is the observability tool. Both are needed for different jobs. An operator who never runs validate relies entirely on startup logs for safety warnings.

**Tension D: Semantic vs. structural validation**
Structural validation (is maxSessionMinutes a positive integer?) is already in validateAndResolveTrigger(). Semantic validation (should autoCommit:true require an explicit branchStrategy?) is a different concern. Conflating them makes the function harder to test and extend. Separating them clarifies responsibilities.

### Likely Seam

The correct boundaries are:
1. `validateAndResolveTrigger()` in trigger-store.ts -- for safety violations (parse-time hard errors)
2. New `validateTriggerStrict()` function (pure, post-parse) -- for observability warnings

NOT trigger-listener.ts (out of scope). Hard error upgrades in validateAndResolveTrigger propagate automatically through trigger-listener.ts's existing loadTriggerConfigFromFile() call.

### What Makes This Hard

The severity decision for `autoCommit: true` + `branchStrategy: none` under **serial** concurrency. Under serial mode, only one session runs at a time -- no corruption risk today. But changing to parallel later (one field change) makes it dangerous immediately. The design must decide: warn now (footgun-prevention) or only error on the dangerous active combination (parallel + none + autoCommit).

**Resolution chosen:** Hard error on autoCommit:true + branchStrategy absent-or-none regardless of concurrencyMode. The error message explains the latent danger.

---

## Philosophy Constraints

### Principles That Matter Here

- **Errors are data** -- new validation issues must be TriggerValidationIssue values, not exceptions. Already the pattern in trigger-store.ts (70+ Result<>/ok()/err() uses).
- **Make illegal states unrepresentable** -- the correct fix is a type-level discriminated union. The runtime validator is a pragmatic patch. Note as follow-up.
- **Explicit domain types** -- TriggerValidationIssue needs a `rule: string` discriminant (not just a message). Rules should be a finite named set to enable programmatic handling.
- **Pure functions, DI** -- validateTriggerStrict must be a pure function taking TriggerDefinition; CLI command must inject I/O via a deps interface.
- **Validate at boundaries** -- trigger-store.ts IS the boundary. No new boundary needed.

### Philosophy Conflict

**Stated:** make illegal states unrepresentable.
**Practiced:** branchStrategy is `?: 'worktree' | 'none'` (optional) on TriggerDefinition, making the dangerous combination representable.

The validator design is a runtime patch over this type-level gap. A follow-up task should explore replacing the optional field with a discriminated AutoCommitConfig union type.

---

## Impact Surface

- **trigger-store.ts** -- new hard error checks in validateAndResolveTrigger(); new exported types TriggerValidationIssue, functions validateTriggerStrict() and validateAllTriggers()
- **types.ts** -- new TriggerValidationIssue interface
- **cli-worktrain.ts** -- new `worktrain trigger validate` subcommand under existing triggerCommand group
- **trigger-listener.ts** (NOT TOUCHING) -- startup behavior changes automatically because it calls loadTriggerConfigFromFile()
- **Test files** -- existing tests that construct TriggerDefinition with missing fields will now get those triggers skipped (behavior change consistent with new hard errors)

---

## Candidates

### Candidate A: Minimal Safety Patch

**Summary:** Add 3 hard error returns inside validateAndResolveTrigger() for safety violations; no new functions, no CLI change.

**Tensions resolved:** A (hard errors at startup via skip), D (validation stays in existing boundary)
**Tensions accepted:** B (no observability warnings), C (no validate subcommand)

**Boundary:** validateAndResolveTrigger() -- correct seam, already handles structural validation.

**Why this boundary:** It is the existing validation seam, called automatically at startup and via CLI. Adding checks here requires no new call sites.

**Failure mode:** Triggers are silently skipped at startup. Operators who don't read logs won't know. No UX improvement over current behavior.

**Repo-pattern relationship:** Exact follow -- same err() return pattern, same TriggerStoreError kinds.

**Gains:** Zero new surface area, minimum risk, fixes safety violations.
**Losses:** No validate CLI, no observability warnings, no per-trigger summary.

**Scope judgment:** Too narrow for the full ask. Satisfies safety goal only.

**Philosophy:** Honors errors-as-data, validate-at-boundaries. Does not progress on make-illegal-states-unrepresentable.

---

### Candidate B: Two-Layer Validation + CLI Subcommand (RECOMMENDED)

**Summary:** (1) Add 3 hard error returns in validateAndResolveTrigger() for safety violations. (2) Add new pure exported function validateTriggerStrict(trigger: TriggerDefinition): readonly TriggerValidationIssue[] for observability warnings. (3) Add worktrain trigger validate subcommand that calls loadTriggerConfigFromFile() then validateAllTriggers() and prints per-trigger summary.

**Tensions resolved:** All four -- safety violations become hard errors (A), observability gaps produce named warnings (B), static validate CLI exits 0/1 (C), semantic validation cleanly separated from structural parsing (D).

**Boundary solved at:**
1. validateAndResolveTrigger() -- structural + safety (parse-time errors, existing boundary)
2. validateTriggerStrict() -- semantic (post-parse, new pure function)
Both boundaries are correct for their respective concerns.

**Why this boundary:** TriggerDefinition is fully resolved at validateTriggerStrict time (secrets expanded, defaults applied, branding done). Cross-field semantics like 'autoCommit:true + branchStrategy absent' can be checked cleanly on a fully-assembled value. The parse-time boundary is wrong for this -- at parse time, branchStrategy might still be absent for a legitimate reason (worktree isolation is optional for read-only triggers).

**Failure mode:** Two validation layers = two places to add new rules. An operator who only runs the daemon (never validate CLI) won't see semantic warnings. Mitigation: loadTriggerConfig() can log 'run worktrain trigger validate for a full config health check' on successful parse.

**Repo-pattern relationship:** Adapts -- extends existing function plus new exported function following same pure-function and DI patterns. New CLI subcommand follows WorktrainTriggerTestDeps injection pattern exactly.

**New types (concrete specification):**
```typescript
// In types.ts
export interface TriggerValidationIssue {
  readonly severity: 'error' | 'warning';
  readonly rule:
    | 'auto_commit_requires_branch_isolation'
    | 'auto_open_pr_requires_auto_commit'
    | 'worktree_requires_base_branch'
    | 'worktree_requires_branch_prefix'
    | 'max_session_minutes_not_set'
    | 'concurrent_without_worktree'
    | 'goal_template_implicit'
    | 'max_turns_not_set'
    | 'auto_commit_without_secret_scan';
  readonly triggerId: string;
  readonly message: string;
  readonly suggestedFix?: string;
}
```

Note: `rule` is a closed string-literal union (not bare string) for exhaustiveness and programmatic handling.

**New exports from trigger-store.ts:**
```typescript
export function validateTriggerStrict(trigger: TriggerDefinition): readonly TriggerValidationIssue[];
export function validateAllTriggers(config: TriggerConfig): readonly TriggerValidationIssue[];
```

**New CLI file:** `src/cli/commands/worktrain-trigger-validate.ts` following WorktrainTriggerTestDeps injection pattern.

**Gains:** Full solution -- safety + observability + CLI. Clean separation. Easy to test validateTriggerStrict in isolation. TriggerValidationIssue is an explicit domain type (not bare string). Closed rule enum enables exhaustiveness.
**Losses:** More surface area than A. Two places to add new validation rules. Startup path only runs first layer.

**Scope judgment:** Best-fit. Covers all five decision criteria within the stated scope.

**Philosophy:** Honors all -- errors-as-data, immutability, explicit domain types, pure functions, DI. The closed rule union advances exhaustiveness. Does not yet fix the make-illegal-states-unrepresentable gap (follow-up).

---

### Candidate C: Type-Level Discriminated Union

**Summary:** Replace `branchStrategy?: 'worktree' | 'none'` in TriggerDefinition with a discriminated union `type CommitConfig = { readonly autoCommit: false } | { readonly autoCommit: true; readonly branchStrategy: 'worktree'; readonly baseBranch: string; readonly branchPrefix: string }` so the dangerous combination is unrepresentable at compile time.

**Tensions resolved:** Tension B (type-level guarantee, permanent prevention rather than runtime detection). Fully resolves make-illegal-states-unrepresentable.

**Tensions accepted:** Tension A, C, D. Does not provide CLI. Large refactor.

**Boundary:** types.ts (TriggerDefinition), trigger-store.ts (assembly code). Would cascade to all TriggerDefinition construction sites including trigger-listener.ts tests (out of scope).

**Why this boundary is wrong for now:** trigger-listener.ts and test files are out of scope. The type change cascades beyond the allowed boundary.

**Failure mode:** All test fixtures that construct TriggerDefinition objects must be updated. High risk for the stated scope.

**Repo-pattern relationship:** Departs from existing flat-interface pattern. Follows philosophy strictly.

**Gains:** Compiler catches dangerous combinations at build time. Zero runtime overhead.
**Losses:** Large refactor, many files beyond scope. Does not address CLI observability.

**Scope judgment:** Too broad.

**Philosophy:** Best honors make-illegal-states-unrepresentable. Conflicts with YAGNI -- more complexity than needed for the immediate problem.

---

## Comparison and Recommendation

| Criterion | A | B | C |
|---|---|---|---|
| Safety violations become hard errors | Yes | Yes | Yes (compile-time) |
| Observability warnings | No | Yes | No |
| Static validate CLI | No | Yes | No |
| No API break | Yes | Yes | No (type break) |
| Fits scope | Yes | Yes | No |
| Easiest to evolve | Yes (tiny) | Yes (clean seams) | Risky |
| Philosophy alignment | Good | Best | Highest (but scope-breaking) |

**Recommendation: Candidate B.** It satisfies all five decision criteria, fits the scope, and follows established patterns. Candidate A is the right Phase 1 of B. Candidate C is the right long-term follow-up.

---

## Self-Critique

**Strongest counter-argument against B:** Semantic warnings are only visible via `worktrain trigger validate`. An operator who never runs the CLI misses them entirely. The startup path only runs the structural validator. This means the observability improvement requires operator behavior change (run validate before deploying).

**Why it still wins:** The alternative (putting semantic warnings in startup logs) is already partially implemented (see the existing console.warn for autoOpenPR without autoCommit). The problem is not that warnings are absent -- it is that they are scattered across trigger-store.ts console.warn calls with no structured output. Candidate B consolidates them into a proper reporting layer.

**Narrower option considered:** Candidate A. It loses because it provides no observability improvement, which is half the stated goal.

**Broader option considered:** Candidate C. It would be justified if the scope constraint is relaxed or if a follow-up task is planned immediately after this design.

**Assumption that would invalidate this design:** If adding new hard errors to validateAndResolveTrigger() causes unexpected startup failures in production (e.g., a trigger that was loading with a bad default is now skipped entirely, breaking the deployment). Mitigation: the production triggers.yml was audited and passes all proposed checks. The hard errors only affect configs that would have caused production incidents anyway.

---

## Open Questions for Main Agent

1. **autoCommit:true + branchStrategy:none + serial concurrency** -- should this be a hard error (latent danger) or a warning (safe today)? Design doc recommends hard error. Do you agree?

2. **Migration path for self-improvement trigger** -- it has no explicit concurrencyMode (defaults to serial) and no explicit goalTemplate (defaults to {{$.goal}}). These are warnings under the proposed design. Is that the right call, or should we add these fields to the production triggers.yml as part of this work?

3. **worktrain init template** -- should fixing the triggers.yml template scaffolding be part of this implementation? (The framing risk: if init generates missing fields, the validator catches hand-edits but not init-generated configs.) The init command is in `src/cli/commands/worktrain-init.ts` -- also in scope since cli-worktrain.ts is allowed.

4. **TriggerValidationIssue.rule as closed union vs. bare string** -- the closed union enables exhaustiveness in switch statements but makes the rule set less extensible. Should it be `string` with a named constants object instead?
