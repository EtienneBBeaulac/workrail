# Design: triggers.yml Validator for WorkTrain

**Status:** Draft  
**Date:** 2026-04-19  
**Author:** Etienne Beaulac (via wr.discovery workflow)  
**Scope:** `src/trigger/trigger-store.ts`, `src/trigger/types.ts`, `src/cli-worktrain.ts` -- NOT `src/mcp/`

**Artifact strategy:** This document is a human-readable reference for the design decisions made during the `wr.discovery` workflow. It is NOT execution truth -- notes and context variables in the WorkRail session are the durable record. This document may be updated as decisions evolve but is not required for session recovery.

---

## Context / Ask

### Original Stated Goal (solution-framed)

> Design a triggers.yml validator that enforces explicit configuration of all consequential fields, so WorkTrain's behavior is fully readable from the config file without knowing source code defaults.

### Reframed Problem Statement

WorkTrain's runtime behavior cannot be determined from reading `triggers.yml` alone because consequential fields have silent defaults, so operators only discover misconfiguration through production failures rather than at startup.

### Background: Production Incidents

Three classes of misconfiguration have caused real production pain:

1. `branchStrategy` silently defaulted to `none` -- 3 parallel sessions wrote to the same checkout simultaneously (no worktree isolation)
2. `goalTemplate` silently defaulted to `{{$.goal}}` -- confusing startup warning with no guidance
3. `maxSessionMinutes` absent -- 30-minute hidden system default, no visibility in config
4. Same issue dispatched 3 times before idempotency kicked in -- concurrency cap as sole safety net

**Root cause:** implicit defaults + no startup validation = behavior that cannot be determined from reading the config.

---

## Path Recommendation

**Chosen path: `design_first`**

Rationale: the goal is solution-framed (prescribes a validator). The design risk is solving the wrong problem or designing the wrong interface. Before writing any code, we need to resolve three key questions:

1. **Strict vs. lenient mode** -- should the validator be always-strict or configurable?
2. **Migration path** -- how do existing triggers.yml files that predate the validator get handled?
3. **Where validation runs** -- startup only, `worktrain trigger validate` only, or both?

`design_first` over `full_spectrum`: the landscape is already well-understood from code inspection. The trigger system is fully readable. The risk is not missing context -- it is committing to the wrong design contract.

---

## Constraints / Anti-Goals

### Constraints

- **Scope:** Only `src/trigger/trigger-store.ts`, `src/trigger/types.ts`, `src/cli-worktrain.ts`
- **No `src/mcp/` changes**
- **No external dependencies** for the validator (no JSON Schema library, no ajv)
- **Backward-compatible parse API** -- `loadTriggerConfig()` public signature must not change (callers in trigger-listener.ts)
- **Result types, not exceptions** -- consistent with existing TriggerStoreError pattern
- **Deterministic** -- same triggers.yml produces same validation result always

### Anti-Goals

- Do not build a general-purpose YAML schema validator
- Do not add a `strict: true` flag to `~/.workrail/config.json` (introduces hidden behavior)
- Do not add API calls to `worktrain trigger validate` (it must be static analysis only)
- Do not auto-fix or auto-fill missing fields (that hides the problem)
- Do not break existing `triggers.yml` files that are already correctly configured

---

## Landscape Packet

### Current State: What trigger-store.ts Already Validates

`validateAndResolveTrigger()` (1354 lines in trigger-store.ts) already enforces:

| Check | Behavior |
|---|---|
| `autoOpenPR: true` without `autoCommit: true` | **Warning** (soft, not error) |
| `github_queue_poll` without `source.repo` | **Hard error** (missing_field) |
| `github_queue_poll` without `source.token` | **Hard error** (missing_field) |
| `branchStrategy` invalid value | **Hard error** (invalid_field_value) |
| `concurrencyMode` invalid value | **Hard error** (invalid_field_value) |
| `dispatchCondition` missing payloadPath/equals | **Hard error** (missing_field) |
| `maxSessionMinutes` non-integer or <= 0 | **Hard error** (invalid_field_value) |

### Current State: What Is NOT Validated (Silent Defaults)

| Field | Current Behavior | Production Risk |
|---|---|---|
| `branchStrategy` absent + `autoCommit: true` | Defaults to `none` silently | Parallel sessions corrupt main checkout |
| `goalTemplate` absent + `goal` absent | Defaults to `{{$.goal}}` with a console.log | Confusing startup warning |
| `maxSessionMinutes` absent | System default 30 min (hidden) | No visibility in config |
| `concurrencyMode` absent | Defaults to `serial` silently | OK, serial is safe -- but not visible |
| `branchPrefix`/`baseBranch` absent with worktree | Defaults to `worktrain/` and `main` | Acceptable defaults, but invisible |

### Existing Production triggers.yml Audit

| Trigger | maxSessionMinutes | branchStrategy | concurrencyMode | goalTemplate | Verdict |
|---|---|---|---|---|---|
| `test-task` | 60 (explicit) | worktree (explicit) | parallel (explicit) | explicit | **PASSES** |
| `mr-review` | 30 (explicit) | none (explicit) | parallel (explicit) | explicit | **PASSES** |
| `self-improvement` | 90 (explicit) | worktree (explicit) | absent (defaults serial) | absent (defaults {{$.goal}}) | **WARNINGS** |

The existing production `triggers.yml` is mostly compliant. Only `self-improvement` would generate warnings for `concurrencyMode` and `goalTemplate`.

### TriggerStoreError Taxonomy (Current)

```typescript
type TriggerStoreError =
  | { kind: 'parse_error'; message: string; lineNumber?: number }
  | { kind: 'missing_secret'; envVarName: string; triggerId: string }
  | { kind: 'missing_field'; field: string; triggerId: string }
  | { kind: 'invalid_field_value'; field: string; triggerId: string }
  | { kind: 'unknown_provider'; provider: string; triggerId: string }
  | { kind: 'unknown_workspace'; workspaceName: string; triggerId: string }
  | { kind: 'file_not_found'; filePath: string }
  | { kind: 'io_error'; message: string }
  | { kind: 'duplicate_id'; triggerId: string }
```

No new error kinds are needed. The proposed hard errors all map to `missing_field` or `invalid_field_value`.

---

## Problem Frame Packet

### Primary Users and Stakeholders

| Stakeholder | Job / Outcome | Pain / Tension |
|---|---|---|
| **Etienne (operator, solo)** | Configure WorkTrain to autonomously handle GitHub issues and PRs | Has to read source code to understand what fields matter; discovered branchStrategy gap only after 3 sessions corrupted the same checkout |
| **trigger-listener.ts** (startup path) | Start with a known-good config or fail fast with actionable errors | Currently: one bad trigger skips, daemon starts with valid subset. Stricter: any bad trigger blocks all triggers. |
| **loadTriggerConfig() callers** (trigger-listener.ts, trigger-store tests) | Parse triggers.yml reliably with stable API | A breaking API change (e.g. adding required params) would require updating all call sites |
| **Future WorkTrain operators** (non-Etienne) | Onboard to WorkTrain without reading source code | Need config to be self-documenting at read time |

### Core Tensions

**Tension 1: Fail-fast vs. partial degradation**
Current behavior: one bad trigger is skipped, rest run. Proposed: safety-violation triggers block startup entirely. Operators running 5+ triggers will be frustrated if one misconfiguration blocks all others. Partial degradation (skip the bad trigger, warn loudly) is more practical at scale.

**Tension 2: Explicit config vs. sensible defaults**
The design asks operators to explicitly set `maxSessionMinutes` on every trigger. But `maxSessionMinutes: 30` as a default is actually reasonable for most read-only triggers. Forcing explicit values adds config noise without preventing real incidents (the 30-min default is not what caused any of the production problems). The true danger fields are `branchStrategy` and `concurrencyMode`, not timeout.

**Tension 3: Startup validation vs. validate subcommand**
If hard errors block startup (trigger-listener.ts), operators must fix config before the daemon will run at all. If hard errors only surface via `worktrain trigger validate`, operators might not run it before starting the daemon. The cleanest UX: `worktrain trigger validate` is the single check; the daemon startup calls it automatically before loading triggers.

**Tension 4: Breaking change risk for autoOpenPR + no autoCommit**
The existing code warns on this combination but does not error. Upgrading to hard error is technically correct but breaks any existing trigger that has this config. Since the production `triggers.yml` does not have this combination, it is safe for Etienne. But it is a breaking change for the documented behavior.

### Success Criteria (Concrete)

1. After this design is implemented, an operator can add a new trigger to triggers.yml and `worktrain trigger validate` will tell them if they forgot any field that would cause a production incident -- without running the daemon.
2. The three production incidents (checkout corruption, goalTemplate warning, hidden timeout) each map to a specific named rule that fires for a config that would reproduce them.
3. `worktrain trigger validate` exits in <2 seconds on a 10-trigger file with no network calls.
4. The existing production `triggers.yml` (3 triggers) produces 0 errors and at most 3 warnings from `worktrain trigger validate`.
5. Adding `worktrain trigger validate` does not require any change to `trigger-listener.ts` or `src/mcp/`.

### Primary Framing Risk

**The single specific thing that would make the current framing wrong:**

If the root cause of the production incidents is NOT missing validation, but instead missing documentation or missing defaults in the `worktrain init` scaffolded triggers.yml template -- then validation at startup or via a CLI command addresses the symptom but not the root cause. If `worktrain init` generates a triggers.yml with all consequential fields pre-filled with safe explicit values, then new operators would never encounter the silent default problem in the first place. Validation would then only help operators who hand-edit their config outside of `worktrain init`.

**Evidence that would trigger a retriage:** discovering that the three production incidents all happened on configs originally generated by `worktrain init` (rather than manually written). In that case, fixing `worktrain init`'s template is the higher-leverage intervention.

### The Core Tension (Summary)

The problem has two distinct failure modes:

**Failure mode A: Dangerous silent default** -- `branchStrategy` absent + `autoCommit: true` = parallel sessions corrupting the main checkout. This is a safety violation. It warrants a hard error.

**Failure mode B: Confusing invisible default** -- `maxSessionMinutes` absent = hidden 30-min timeout. This is an observability problem, not a safety problem. A warning surfaces it; a hard error is disproportionate.

The proposed design conflates both into "hard errors block startup." The right design separates them:
- **Safety violations** (could corrupt data or cause infinite loops) = hard errors
- **Observability gaps** (hidden defaults that are still safe) = warnings that appear in `worktrain trigger validate` output

### Three Key Design Questions to Resolve

#### Q1: Strict vs. Lenient Mode

**Options:**
- A. Always strict (no config flag) -- simpler, no hidden behavior, breaks on upgrade
- B. Opt-in strict via `worktrain trigger validate --strict` (flag, not daemon config) -- clean separation between "works" and "passes audit"
- C. Always-on warnings at startup, hard errors only for safety violations

**Recommendation:** Option C. Safety violations (branchStrategy absent + autoCommit) become hard errors always. Observability gaps produce warnings always. No config flags. The `worktrain trigger validate` command surfaces all warnings and errors with formatting.

Rationale: a config flag `strict: true` in `config.json` introduces hidden behavior (triggers.yml behaves differently depending on config.json). A CLI `--strict` flag on `validate` is fine because it only affects the validate subcommand output, not daemon behavior.

#### Q2: Migration Path

**Observation:** existing production `triggers.yml` already passes most checks. Only `self-improvement` is missing `concurrencyMode` and `goalTemplate` explicit values, both of which are safe defaults (serial mode is safe; `{{$.goal}}` is functional).

**Recommendation:** 
- Hard errors for safety violations are non-negotiable on new triggers
- Existing triggers that only have observability gaps (missing concurrencyMode, goalTemplate) get warnings, not errors
- `worktrain trigger validate` output shows a "migration diff" section: what fields to add for clean validation

#### Q3: Where Validation Runs

**Recommendation:** Both locations, with different severity:
- **Startup (daemon):** Hard errors only (safety violations). Daemon refuses to start a trigger that would corrupt data.
- **`worktrain trigger validate`:** Hard errors + all warnings + human-readable summary.

This means startup is not blocked by observability warnings -- only by safety violations.

---

## Candidate Generation Expectations

*This section records what the candidate directions must cover for design_first rigor:*

- At least one direction must meaningfully reframe the problem rather than just packaging the obvious solution (a new validator component)
- At least one direction must be conservative/minimal (extend existing code, smallest surface area)
- At least one direction must be more ambitious (structural change that prevents the class of errors, not just catches them)
- All directions must satisfy the 5 decision criteria (safety violations = hard errors, observability = warnings, static CLI, no API break, scope constraint)
- The severity question (autoCommit+branchStrategy:none under serial = error or warning?) must be explicitly resolved in at least one direction

## Candidate Directions

### Direction 1: Extend validateAndResolveTrigger() with a strict-mode parameter (RECOMMENDED)

Add a `ValidationMode` type and a `mode` parameter to `validateAndResolveTrigger()`:

```typescript
type ValidationMode = 'lenient' | 'strict';

// loadTriggerConfig() adds an optional mode parameter
export function loadTriggerConfig(
  yamlContent: string,
  env: Record<string, string | undefined>,
  workspaces: Readonly<Record<string, WorkspaceConfig>>,
  mode: ValidationMode = 'lenient',
): Result<TriggerConfig, TriggerStoreError>
```

- `lenient` (default): current behavior. Safety violations still hard-error. Observability warnings logged but not blocking.
- `strict`: additionally blocks on observability gaps (missing maxSessionMinutes, missing explicit concurrencyMode for parallel triggers, etc.)

Startup uses `lenient`. `worktrain trigger validate` uses `strict` for its exit code but reports both.

**Pros:** No new files, extends existing error taxonomy, no API surface change for callers.  
**Cons:** The `mode` parameter adds complexity to a function that is already 650+ lines.

### Direction 2: Separate `validateTriggerStrict()` function in trigger-store.ts

Keep `validateAndResolveTrigger()` as-is for parsing. Add a new pure function:

```typescript
export interface TriggerValidationIssue {
  readonly severity: 'error' | 'warning';
  readonly rule: string;         // e.g. 'branch_strategy_required_with_auto_commit'
  readonly triggerId: string;
  readonly message: string;
  readonly suggestedFix?: string;
}

export function validateTriggerStrict(
  trigger: TriggerDefinition,
): readonly TriggerValidationIssue[]
```

This takes an _already-parsed_ TriggerDefinition and applies semantic validation rules on top of structural parse validation.

**Pros:** Clean separation of concerns (parse vs. semantic validation). Pure function, easy to test. Composable with `worktrain trigger validate`.  
**Cons:** Two-pass validation (parse then validate) means startup needs two calls.

### Direction 3: JSON Schema generation for triggers.yml

Generate a JSON Schema from the TypeScript types and validate triggers.yml at authoring time via VS Code or pre-commit hook.

**Pros:** Catches errors before the file is deployed. Works in editors with real-time feedback.  
**Cons:** Out of scope (does not address the `src/cli-worktrain.ts` deliverable). The narrow custom YAML parser would need to be replaced or supplemented. Does not provide the human-readable `worktrain trigger validate` output.

**Verdict:** Complementary to Direction 1 or 2, not a replacement. Noted for future work.

---

## Validator Rule Taxonomy

### Hard Errors (block startup and fail `worktrain trigger validate`)

| Rule ID | Condition | Error Kind |
|---|---|---|
| `auto_commit_requires_branch_strategy` | `autoCommit: true` AND `branchStrategy` absent or `'none'` | `missing_field` / `invalid_field_value` |
| `auto_open_pr_requires_auto_commit` | `autoOpenPR: true` AND `autoCommit` not `true` | `invalid_field_value` (upgrade from current warning) |
| `worktree_requires_base_branch` | `branchStrategy: worktree` AND `baseBranch` absent | `missing_field` |
| `worktree_requires_branch_prefix` | `branchStrategy: worktree` AND `branchPrefix` absent | `missing_field` |
| `queue_poll_requires_source_repo` | `github_queue_poll` AND `source.repo` absent | `missing_field` (already enforced) |
| `queue_poll_requires_source_token` | `github_queue_poll` AND `source.token` absent | `missing_field` (already enforced) |

### Warnings (logged at startup, surfaced by `worktrain trigger validate`)

| Rule ID | Condition | Message |
|---|---|---|
| `max_session_minutes_not_set` | `agentConfig.maxSessionMinutes` absent | "maxSessionMinutes not set; system default is 30 min -- add explicit value for observability" |
| `concurrent_without_worktree` | `concurrencyMode: parallel` AND `branchStrategy: none` | "parallel sessions share a checkout; if autoCommit is true this will corrupt files" |
| `goal_template_implicit` | `goalTemplate` absent AND `goal` absent | "goalTemplate will default to {{$.goal}}; explicit configuration recommended" |
| `max_turns_not_set` | `agentConfig.maxTurns` absent | "maxTurns not set; no turn limit will apply" |
| `auto_commit_without_secret_scan` | `autoCommit: true` AND `secretScan: false` | "secret scanning disabled on a committing trigger" |

---

## `worktrain trigger validate` Output Format

```
$ worktrain trigger validate

WorkTrain Trigger Validation
Config: /Users/etienneb/git/personal/workrail

Trigger: test-task (generic)
  Delivery:     autoCommit=true  autoOpenPR=true
  Branch:       worktree -> worktrain/<sessionId> off main
  Concurrency:  parallel
  Limits:       maxSessionMinutes=60  [maxTurns not set]
  Goal:         from payload (goalTemplate={{$.goal}})
  Status:       WARNING (1)
  - [W] max_turns_not_set: maxTurns not set; no turn limit will apply

Trigger: mr-review (generic)
  Delivery:     autoCommit=false  autoOpenPR=false
  Branch:       none (read-only)
  Concurrency:  parallel
  Limits:       maxSessionMinutes=30
  Goal:         from payload (goalTemplate=Review PR {{$.pull_request.number}}: {{$.pull_request.title}})
  Status:       OK

Trigger: self-improvement (github_queue_poll)
  Queue:        assignee=worktrain-etienneb  repo=EtienneBBeaulac/workrail
  Delivery:     autoCommit=true  autoOpenPR=true
  Branch:       worktree -> worktrain/<sessionId> off main
  Concurrency:  serial [WARNING: concurrencyMode not set, defaulting to serial]
  Limits:       maxSessionMinutes=90  maxTurns=60
  Goal:         implicit {{$.goal}} (no goalTemplate set)
  Status:       WARNING (2)
  - [W] goal_template_implicit: goalTemplate will default to {{$.goal}}; explicit configuration recommended
  - [W] concurrent_without_worktree: N/A (serial mode)

Summary: 3 triggers  0 errors  3 warnings
Exit code: 0 (no errors)
```

---

## Implementation Plan

### Phase 1: Hard error upgrades + startup hint (no new files)

**File:** `src/trigger/trigger-store.ts`

1. Upgrade `autoOpenPR: true` without `autoCommit: true` from warning to hard error (`invalid_field_value`) -- **BREAKING CHANGE**, document in PR
2. Add hard error: `autoCommit: true` with `branchStrategy` absent or `'none'` (new check in `validateAndResolveTrigger`) -- hard error regardless of `concurrencyMode` (latent danger)
3. Add hard error: `branchStrategy: worktree` without `baseBranch` -- only if chosen to require explicit (design question Y3 in review; recommendation: yes, require it)
4. Add `console.log` hint in `loadTriggerConfig()` on successful parse: `"Loaded ${N} trigger(s). Run 'worktrain trigger validate' for a full config health check."`

**File:** `src/trigger/types.ts`

5. No type changes needed for Phase 1 (all TriggerStoreError kinds already exist)

### Phase 2: Semantic validator function (new export from trigger-store.ts)

**File:** `src/trigger/types.ts`

6. Add `TriggerValidationIssue` interface with `severity: 'error' | 'warning'` and closed `rule` union (9 named rules)

**File:** `src/trigger/trigger-store.ts`

7. Add `validateTriggerStrict(trigger: TriggerDefinition): readonly TriggerValidationIssue[]`
   - **INVARIANT (document in code comment):** This function must reproduce ALL error-severity checks from `validateAndResolveTrigger()` as `TriggerValidationIssue` with `severity: 'error'`. The validate CLI must be a strict superset of what the daemon checks. Keep these in sync.
   - Includes: hard error rules (safety violations) AND warning rules (observability gaps)
8. Add `validateAllTriggers(config: TriggerConfig): readonly TriggerValidationIssue[]`

### Phase 3: CLI subcommand + tests

**New file:** `src/cli/commands/worktrain-trigger-validate.ts`

9. `WorktrainTriggerValidateDeps` interface (following `WorktrainTriggerTestDeps` pattern -- all I/O injected)
10. `executeWorktrainTriggerValidateCommand()` function
    - Calls `loadTriggerConfig()` then `validateAllTriggers()`
    - Prints human-readable per-trigger summary
    - Exit 0 if no errors (warnings OK), exit 1 if any errors
    - No API calls, no network I/O

**File:** `src/cli-worktrain.ts`

11. Add `worktrain trigger validate` subcommand to existing `triggerCommand` group (line ~1539)

**Test requirement (Orange O2 from review):**

12. Unit test: construct a TriggerDefinition that would fail validateAndResolveTrigger (e.g., `autoCommit: true, branchStrategy: undefined`) and verify that `validateTriggerStrict()` produces a `severity: 'error'` issue for the same condition. This prevents the sync regression identified in failure mode FM2.

### Phase 4: Startup integration (deferred)

**File:** `src/trigger/trigger-listener.ts` (OUT OF SCOPE -- do not touch)

Note: Hard error upgrades in Phase 1 propagate automatically through the existing `loadTriggerConfigFromFile()` call chain in trigger-listener.ts. Semantic warnings from Phase 2 are NOT surfaced at daemon startup -- only via `worktrain trigger validate`. This is the accepted tradeoff.

---

## Open Questions

1. **Should `branchStrategy: worktree` without explicit `baseBranch`/`branchPrefix` be a hard error or warning?** Defaults (`main`, `worktrain/`) are safe and well-documented. Recommendation: warning only.

2. **Should `autoCommit: true` + `branchStrategy: none` be a hard error or warning?** It's dangerous (corrupts checkout under parallel runs) but safe under `serial` concurrencyMode. Recommendation: hard error only when `concurrencyMode: parallel`, warning when `serial`.

3. **Should `worktrain trigger validate` read from a specific path or always use cwd?** Recommendation: default to `~/.workrail/triggers.yml` (same as daemon), with `--config <path>` override.

4. **Startup behavior change for `trigger-listener.ts`:** The design calls for startup validation, but `trigger-listener.ts` is out of scope. Phase 4 is deferred. The hard error upgrades in Phase 1 (which run inside `validateAndResolveTrigger`) apply at startup automatically via the existing `loadTriggerConfigFromFile()` call chain.

---

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-19 | Use Candidate B (two-layer validation + CLI subcommand) | Best-fit scope, satisfies all 5 decision criteria, clean separation of structural parse from semantic validation. |
| 2026-04-19 | Hard errors for safety violations, warnings for observability gaps | Proportionate. Avoids breaking startup on non-dangerous misconfigs. The three production incidents are safety-class. |
| 2026-04-19 | autoCommit:true + branchStrategy:none = hard error regardless of concurrencyMode | Latent danger: serial+none is safe today but becomes corrupt-checkout immediately when concurrencyMode changes to parallel. Fail-fast on the latent footgun. |
| 2026-04-19 | No strict mode config flag | Config flags introduce hidden behavior. CLI --strict on validate subcommand only. |
| 2026-04-19 | TriggerValidationIssue.rule is a closed string-literal union | Enables exhaustiveness in switch statements. Catches new rules at compile time when consuming code handles them. |
| 2026-04-19 | Phase 4 (startup integration) deferred -- trigger-listener.ts out of scope | Hard error upgrades in Phase 1 propagate automatically through existing loadTriggerConfigFromFile() call chain. No trigger-listener.ts changes needed. |
| 2026-04-19 | Candidate C (type-level discriminated union) deferred as follow-up | Too broad for current scope. The correct long-term fix but a separate task. |

---

## Final Summary

**Selected direction:** Candidate B -- Two-Layer Validation + CLI Subcommand.

**Why it won:** Satisfies all five decision criteria within the stated scope. Hard errors for safety violations (three production incidents prevented), warnings for observability gaps, static `worktrain trigger validate` CLI with no API calls, backward-compatible loadTriggerConfig() API, implementation confined to trigger-store.ts + types.ts + cli-worktrain.ts.

**Strongest alternative:** Candidate A (minimal safety patch). It solves the safety goal but provides no observability improvement or CLI subcommand. It is the correct Phase 1 implementation of Candidate B, not an alternative.

**Accepted tradeoffs:**
- Semantic warnings are only visible via `worktrain trigger validate` (not daemon startup logs). Operators must know to run it.
- Two validation layers means two places to add new rules. Mitigated by unit tests on validateTriggerStrict.
- autoOpenPR+no autoCommit is upgraded from warning to hard error (behavioral change for any config with this combination -- none exist in production).

**Identified failure modes:**
- An operator deploys a new trigger, never runs validate, and misses an observability warning (e.g., missing maxSessionMinutes). Mitigation: loadTriggerConfig() should log a hint to run validate on successful parse.
- A developer adds a new validation rule to validateAndResolveTrigger but forgets to add the corresponding semantic check to validateTriggerStrict. Mitigation: unit test coverage for validateTriggerStrict.

**Confidence band:** High. No red findings from the design review. Two Orange findings (sync invariant contract, unit test requirement) are incorporated into the implementation plan. Remaining uncertainty is implementation-level, not design-level.

**Residual risks:**
- Sync gap between validateAndResolveTrigger and validateTriggerStrict (Orange O1/O2) -- mitigated by contract comment and unit test in Phase 3.
- Operator never runs validate (Yellow Y1) -- mitigated by startup hint in Phase 1.

**Follow-up tasks (not blocking this implementation):**
1. **Candidate C:** Replace optional `branchStrategy` with a discriminated `AutoCommitConfig` type in `types.ts` for compile-time safety guarantee.
2. **worktrain init template:** Fix the scaffold to generate all consequential fields with explicit values so new configs pass strict mode from day one.
3. **self-improvement trigger:** Add `goalTemplate: "{{$.title}}"` and `concurrencyMode: serial` to the production `triggers.yml` to eliminate the 2 warnings from `worktrain trigger validate`.
