# Design Review Findings: triggers.yml Validator (Candidate B)

*Concise actionable findings for main agent synthesis.*

---

## Tradeoff Review

### T1: Semantic warnings only visible via validate CLI (not daemon startup)
**Severity: Yellow**
Acceptable under realistic conditions. Observability gaps (missing maxSessionMinutes, implicit goalTemplate) are non-blocking. Hard errors still protect against safety violations at startup. The design does not make the current situation worse.

**Hidden assumption:** Operators know to run `worktrain trigger validate` before deploying new triggers.
**Mitigation required:** Add a console.log hint in loadTriggerConfig() on successful parse: "Loaded N trigger(s). Run `worktrain trigger validate` for a full config health check."

### T2: Two validation layers = two places to add rules
**Severity: Orange**
Manageable with documentation and tests, but creates a meaningful maintenance risk. The specific dangerous scenario: a rule is added to validateAndResolveTrigger (causes trigger skip at startup) but not to validateTriggerStrict (so validate CLI reports Status: OK for a trigger that will be skipped). This actively misleads operators.

**Mitigation required:** (1) Add a contract comment in validateTriggerStrict documenting that all error-severity rules in validateAndResolveTrigger must have a counterpart in validateTriggerStrict. (2) Unit test that verifies TriggerDefinitions which fail structural validation also produce error-severity issues from validateTriggerStrict.

### T3: autoOpenPR+no autoCommit upgraded from warning to hard error
**Severity: Yellow**
Breaking behavioral change. Safe for the production config (no such combination exists). Must be documented as a breaking change in the implementation PR. Clear error message required.

---

## Failure Mode Review

### FM1: Operator never runs validate, misses observability warnings
**Severity: Yellow**
The startup hint (T1 mitigation) reduces this risk substantially. Worst case is the current situation (confusing startup messages about missing fields), not a regression.

### FM2: validate CLI says OK but daemon skips trigger (sync failure)
**Severity: Orange -- MOST DANGEROUS**
If a safety rule is in validateAndResolveTrigger but not in validateTriggerStrict, the validate CLI is actively misleading. This is the highest-risk failure mode.

**Required mitigation:** Implement validateTriggerStrict to reproduce all error-severity rules from validateAndResolveTrigger as TriggerValidationIssue with severity:'error'. The validate CLI must be a strict superset of what the daemon checks. Document this invariant in code comments.

---

## Runner-Up / Simpler Alternative Review

**Candidate A (minimal patch):** No simplification opportunity. Candidate A is Phase 1 of Candidate B. No elements to borrow -- B already includes A's changes.

**Simpler variant (single-layer: validateTriggerStrict only):** Analyzed. Does not work. Hard errors in validateAndResolveTrigger prevent dangerous triggers from being dispatched. Moving them to validateTriggerStrict would let dangerous triggers load and dispatch (the validate CLI would show errors, but the daemon would still run the trigger). The two-layer architecture is required.

**Verdict:** No simplification satisfies all acceptance criteria. Candidate B as specified is the minimal correct design.

---

## Philosophy Alignment

### Fully Satisfied
- Errors are data (TriggerValidationIssue is a value, not an exception)
- Explicit domain types (closed rule union, named interface)
- Exhaustiveness (closed rule union enables switch exhaustiveness)
- Immutability (all readonly fields and return types)
- Pure functions (validateTriggerStrict has no I/O)
- Dependency injection (CLI uses WorktrainTriggerValidateDeps interface)
- Validate at boundaries (trigger-store.ts is the boundary)

### Under Tension (Acceptable)
- **Make illegal states unrepresentable:** branchStrategy still optional on TriggerDefinition. Runtime patch accepted for scope constraint. Follow-up: Candidate C (discriminated union).
- **Architectural fixes over patches:** The validator is a runtime patch. Documented as follow-up.
- **YAGNI with discipline:** Slight over-engineering vs. Candidate A, but all new surface is directly required by the stated goal.

---

## Findings

### Red (blocking)
None.

### Orange (important, requires mitigation before implementation)

**O1: Sync invariant must be documented in code** -- validateTriggerStrict must reproduce all error-severity rules from validateAndResolveTrigger as TriggerValidationIssue errors. Without this contract, the two-layer architecture creates a misleading validate CLI.

**O2: Unit test required for sync coverage** -- A test that constructs a TriggerDefinition that would cause a startup-skip (e.g., autoCommit:true + branchStrategy:none) and verifies validateTriggerStrict reports it as severity:'error'. This prevents regression.

### Yellow (recommended, not blocking)

**Y1: Startup hint required** -- loadTriggerConfig() should log "Run `worktrain trigger validate` for a full config health check" on successful parse. Without this, observability warnings are effectively invisible.

**Y2: Breaking change documentation** -- The autoOpenPR+no autoCommit upgrade from warning to hard error must be documented in the implementation PR and in the changelog as a breaking change.

**Y3: Closed rule union vs. constants** -- Open question: should TriggerValidationIssue.rule be a closed string-literal union or a `string` with a named constants object? The closed union is better for exhaustiveness but less extensible. Recommendation: closed union for now (9 rules is a small set); switch to constants if the rule set grows beyond ~15.

---

## Recommended Revisions to Design Doc

1. Add to Phase 2 implementation notes: "validateTriggerStrict must reproduce all error-severity checks from validateAndResolveTrigger as TriggerValidationIssue with severity:'error'. Document this as a maintained invariant in code comments."

2. Add to Phase 1 implementation notes: "loadTriggerConfig() should log a hint to run `worktrain trigger validate` on successful parse of any triggers."

3. Add to Phase 3 implementation notes: "Add unit tests verifying that TriggerDefinitions which would be skipped by validateAndResolveTrigger also produce error-severity issues from validateTriggerStrict."

4. Note Y3 (rule union vs. constants) as an open implementation decision for the coding task.

---

## Residual Concerns

1. **worktrain init template not in scope:** The framing risk (init generates configs without required fields) is unresolved. It is recommended but not required to check worktrain-init.ts during implementation and add the missing explicit field scaffolding. This is a separate, smaller task.

2. **Candidate C deferred:** The type-level discriminated union for AutoCommitConfig is the correct long-term fix. It should be tracked as a follow-up issue. The runtime validator does not prevent a developer from constructing a TriggerDefinition with the dangerous combination programmatically (only from parsing a triggers.yml with it).

3. **Self-improvement trigger warnings:** The production `self-improvement` trigger will produce 2 warnings from validateTriggerStrict (goalTemplate implicit, concurrencyMode not set). These should be fixed in the triggers.yml file as part of this implementation (add explicit `goalTemplate: "{{$.title}}"` and `concurrencyMode: serial`).
