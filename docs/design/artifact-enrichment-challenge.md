# Hypothesis Challenge: Artifact Schema Enrichment Design

**Date:** 2026-05-15
**Challenge method:** Adversarial review (strongest-case construction)
**Challenge target:** Leading candidate -- "Consumer-first + two-tier when ready"
**Runner-up under review:** "Explicit optional fields now"

---

## Target Claim

Defer any artifact schema change until the first concrete consumer (console, inline comment poster, or coordinator integration) is being built. At that point implement a two-tier routing/enrichment split: routing fields remain strictly Zod-validated; enrichment goes in a named `enrichment: Record<string, unknown>` envelope that the engine stores but does not validate. Consumers validate their own sub-schema on read.

---

## Strongest Counter-Argument

**The leading candidate's "no consumer exists" premise is false. The workflow prompt is already a consumer -- and the engine is currently destroying the data it produces.**

The backlog entry (docs/ideas/backlog.md, line 2330) states explicitly:

> "wr.mr-review v2.9.0 overhaul -- the updated Phase 6 verdict prompt *wanted* to include file/line/causalLink/remediation per finding in the typed artifact, but the strict schema forced those fields back into human-readable notes only, losing the machine-readable signal."

This is not a hypothetical future consumer waiting to be built. The workflow agent (Claude executing the mr-review workflow) is a live producer of structured enrichment data. The agent generates `file`, `startLine`, `endLine`, `causalLink`, and `remediation` as part of its review pass, because the workflow prompt instructs it to. Right now, `complete_step` receives this structured data and the engine silently destroys it via `.strict()` rejection -- either blocking the step entirely, or forcing the author to move the data into `notesMarkdown` prose.

The leading candidate misidentifies the problem. The problem is not "no consumer for enrichment exists." The problem is "the engine is actively preventing an existing producer from emitting the data that a known future consumer needs." Deferring to "when a consumer is being built" means the agent has been emitting this data into prose for the entire period between now and then, accumulating a notes-scraping debt that is exactly the design smell the vision document names.

**Sharpest version:** The leading candidate treats "no downstream coordinator reads file/line" as equivalent to "no value in having the data structured." These are different claims. The value of structured enrichment is that it is available to future consumers without a notes-scraping migration. The leading candidate defers the structuring, creating exactly the migration cost it is trying to avoid.

---

## Weak Assumptions in the Leading Candidate

**Assumption 1: "No infrastructure for enrichment before a consumer exists" maps cleanly to "don't change the schema."**

This assumption confuses two things: (a) building consumer-side infrastructure (inline comment poster, console display) before it is needed, and (b) adding typed optional fields to a schema that workflow agents are already trying to populate. The runner-up does (b) only. It adds five optional fields to a Zod schema -- no runtime infrastructure, no new validation path, no new engine machinery. The criterion "no infrastructure for enrichment before a consumer exists" is trivially satisfied by the runner-up if read correctly: the fields are not infrastructure. They are documentation with compile-time checking.

**Assumption 2: The two-tier split can be introduced "when the consumer is being built" without a migration problem.**

Sessions are stored as append-only event logs in `~/.workrail/sessions/`. If enrichment data is emitted into `notesMarkdown` prose between now and the consumer-build date, those sessions are not retroactively enriched when the schema change lands. The console's inline annotation feature or the inline comment poster will show file/line attribution only for sessions created after the schema change. Every session produced during the deferral window is permanently less useful to those consumers. The runner-up avoids this entirely.

**Assumption 3: The `enrichment: Record<string, unknown>` envelope is a clean, stable boundary.**

This assumption is load-bearing but unexamined. Once `enrichment: Record<string, unknown>` is stored in thousands of sessions, the eventual typed design (which the leading candidate calls "two-tier when ready") faces a migration: `artifact.enrichment.file` (envelope path) becomes `artifact.findings[n].file` (explicit field path). Any consumer built against the envelope path is coupled to a schema that must later be changed. The runner-up (explicit fields) commits to the correct field path from the start, because the five fields are already known.

**Assumption 4: Doing the work "when the consumer is being built" costs the same as doing it now.**

The leading candidate implicitly assumes the total engineering cost is equivalent. This is false because: (1) the consumer PR must now include both the consumer logic and the engine schema change, making the consumer PR harder to review and increasing rollback risk; (2) the consumer builder must be aware of the engine schema's state and coordinate with it, creating implicit coupling between two PRs; (3) any sessions produced during the deferral window are permanently impoverished.

---

## Failure Modes of the Leading Candidate

### FM1: The `enrichment` envelope becomes a permanent `Record<string, unknown>` (most likely)

The stated plan is "add `enrichment: Record<string, unknown>` now, replace with typed fields when the consumer is built." In practice, consumer builders see the existing `enrichment` envelope and build against it rather than opening a separate engine PR to add typed fields. The two-tier design collapses into Approach 1 (passthrough everywhere), which both candidate documents call the wrong path. The coding philosophy rule "Types must constrain, not just label" directly applies: `enrichment: Record<string, unknown>` is structurally identical to no envelope at all.

**The runner-up does NOT have this failure mode.** Explicit optional fields on the finding schema are already typed and constrained. There is no second-step migration to fail.

### FM2: The deferral trigger is ambiguous and the PR never gets written

"When the console, inline comment poster, or coordinator integration is being built" describes three different future PRs on different timelines. The trigger condition is underspecified. In a small team, the most likely outcome is that each consumer builder encounters the `enrichment: Record<string, unknown>` envelope and uses it as-is, considering the typed-fields migration "someone else's problem." The runner-up has no trigger condition -- the fields exist from the day of the PR.

### FM3: The leading candidate fails decision criterion #3 on net

Criterion #3 (must-have): "Workflow authors don't need an engine PR per optional field."

The leading candidate plans two engine PRs: (1) the `enrichment: Record<string, unknown>` envelope today, (2) the typed-fields replacement when the consumer is built. The runner-up plans one engine PR: the five explicit optional fields, now. The leading candidate's total PR count is higher, not lower. The criterion is satisfied differently (by making enrichment an open bag), but the total engineering cost is not reduced -- it is deferred and split.

### FM4: The `enrichment` envelope path becomes load-bearing and blocks the eventual typed design

If any production code (coordinator log parsing, console display) reads `artifact.enrichment.file`, changing the field path to `artifact.findings[n].file` is a breaking change to those consumers. The envelope path becomes entrenched. The runner-up never creates this problem because the field path is correct from the start.

---

## Comparison Against the Runner-Up

| Property | Leading (consumer-first + two-tier when ready) | Runner-up (explicit optional fields now) |
|---|---|---|
| Engine PRs total | 2 (envelope now + typed fields later) | 1 (five optional fields now) |
| Sessions produced during deferral | Enrichment in notes only -- permanently prose | Enrichment in typed artifact from day 1 |
| FM1 risk (envelope stays as Record<unknown>) | High -- consumer builders use envelope as-is | None -- fields are already typed |
| Migration risk (envelope path vs field path) | Real -- `enrichment.file` vs `findings[n].file` | None |
| Satisfies criterion 3 (no PR per field) | Via open bag (weak -- accepts typos silently) | Via known field set (strong -- typos caught by strict) |
| Type quality on enrichment fields | `unknown` permanently | Fully typed with optional() |
| YAGNI compliance | Strong on infrastructure; weak on field-path stability | Minor violation (adds fields no consumer reads yet) |
| Reversibility | Low (envelope path becomes entrenched) | High (optional fields with no consumers are dead code that can be deleted) |

**The runner-up's YAGNI violation is minor and reversible.** Optional fields with no consumers are dead code. Dead optional fields can be removed in a future PR with no consumer breakage. The leading candidate's deferral is not reversible: prose-only sessions from the deferral window are permanently less useful.

---

## Critical Tests

**Test 1:** Will the consumer builder (when building the inline comment poster or console annotation feature) change the engine schema, or use `enrichment: Record<string, unknown>` as-is?

If the answer is "use as-is" -- FM1 materializes and the leading candidate has delivered Approach 1 (passthrough everywhere) under a different name.

**Test 2:** How many sessions will be created between today and the consumer build date?

If the answer is "hundreds or thousands" (WorkTrain runs continuously), the prose-only sessions in that window represent a real and permanent capability loss for downstream consumers.

**Test 3:** Does the mr-review v2.9.0 workflow overhaul have a concrete ETA?

If the updated Phase 6 verdict prompt (which already wants to emit file/line/causalLink/remediation) is shipping soon, the runner-up delivers immediate value to a live producer. The leading candidate defers that value with no corresponding cost reduction.

---

## Verdict: Revise

The leading candidate is not wrong in principle -- "consumer-first" is correct discipline, and `enrichment: Record<string, unknown>` is a better design than unconstrained `.passthrough()`. But it is the wrong tool for this specific situation, for two reasons:

1. The producer is already live. The mr-review workflow is already trying to emit file/line/causalLink/remediation. The leading candidate reads this as "no consumer exists" but the correct reading is "a consumer-ready producer is being suppressed." Deferral here does not prevent premature infrastructure -- it prevents the producer from using the channel the system already provides for structured data.

2. The five fields are already known and stable. The backlog entry names them explicitly. The candidate documents (Series A, Approach 2; Series B, Approach 2) both implement them without controversy about what the fields should be. When fields are known, explicit optional fields are more correct than an open bag -- they catch typos, document intent, and do not require a migration from bag-path to field-path.

**Recommended revision:** Replace "consumer-first + two-tier when ready" with "explicit optional fields now + two-tier routing/enrichment split for the full engine (deferred to when coordinator-owned schemas are built)."

This means:
- Ship the runner-up (five explicit optional fields on the per-finding schema) as a small engine PR.
- Keep `.strict()` on the outer object -- only the per-finding sub-object gains the enrichment fields.
- Do not implement the `enrichment: Record<string, unknown>` envelope -- it solves a problem (arbitrary future fields) that does not exist given the known stable field set.
- When the extensible contract registration backlog item is built (coordinator-owned schemas), revisit the two-tier split at that time. That is the right moment for the full architectural seam, not before.

---

## Next Action

Open a GitHub issue for the runner-up: add `file?`, `startLine?`, `endLine?`, `causalLink?`, `remediation?` as optional fields to the per-finding sub-schema in `ReviewVerdictArtifactV1Schema`. Change the nested `.strict()` to `.passthrough()` only on the per-finding sub-object (not the outer schema). Update `getBlockedMessage()` to show the extended schema. Verify `artifact-contract-validator.ts` behavior is unchanged. This is a ~2-hour PR.

Do not implement `enrichment: Record<string, unknown>`. Do not build the two-tier routing/enrichment split until the extensible contract registration design (backlog item linked in the backlog entry) has a concrete plan.
