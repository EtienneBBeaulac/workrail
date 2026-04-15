# Design Candidates: Workspace Context UX

*Raw investigative material for main-agent synthesis. Not a final decision.*

---

## Problem Understanding

### Core tensions

1. **Optional adoption vs guaranteed coverage.** `goal` is optional on
   `start_workflow` = clean API, zero guarantee agents use it. Required =
   breaks existing callers. Cannot be resolved at schema level.

2. **Session unit vs branch unit.** WorkRail's data model is session-centric.
   Branch is a grouping key, not a first-class entity. Branch-level context
   requires an out-of-band mechanism (git description) or a new domain concept.

3. **Platform fix vs workflow fix.** `start_workflow.goal` covers all workflows
   with zero changes. Workflow intake prompts cover it more explicitly but
   require per-workflow maintenance.

4. **Closed anchor union vs extensibility.** `WorkspaceAnchor` is intentionally
   closed. Adding `task_description` to it weakens the invariant without adding
   value over `goal` on `start_workflow` (same outcome, more complexity).

### Where the real seam is

`buildInitialEvents()` in `start.ts` and `V2StartWorkflowInput` schema.
NOT the workspace anchor system -- wrong layer for freetext context.

### What makes this hard

Not the implementation (trivial, ~30 lines). What's hard is the adoption
problem: optional fields have low adoption when agents follow workflow prompts
that don't mention them. The implementation is 30 lines; norm enforcement is
the real work.

---

## Philosophy Constraints

- **YAGNI with discipline**: `task_description` anchor fails YAGNI (same outcome,
  more complexity). Git branch description passes (zero-cost when absent).
- **Architectural fixes over patches**: `start_workflow.goal` is the correct
  seam -- input boundary, reuses existing event model.
- **Make illegal states unrepresentable**: `WorkspaceAnchor` closed union
  protects against ad-hoc leakage -- don't open it without reason.
- **Validate at boundaries**: `goal` is a boundary input; optional is correct.

---

## Impact Surface

- `V2StartWorkflowInput` schema -- agents, tests, documentation
- `buildInitialEvents()` -- event ordering (context_set emitted as index 4)
- `ConsoleWorktreeSummary` type -- frontend types.ts mirror
- `worktree-service.ts` -- adds one git command to 30s refresh cycle
- `FeaturedCard` in WorkspaceView.tsx -- new subtitle slot

---

## Candidates

### A -- Minimal: `goal` on `start_workflow` only

Add `goal?: string` to `V2StartWorkflowInput`. Emit `context_set:initial`
event in `buildInitialEvents()`.

- **Tensions resolved**: Session start gap
- **Tensions accepted**: Adoption (optional), branch-level gap
- **Boundary**: `V2StartWorkflowInput` + `buildInitialEvents()`
- **Failure mode**: Agents skip `goal`; gap persists for those sessions
- **Repo pattern**: Follows -- extends existing event list; reuses `context_set`
- **Gain/Lose**: Zero workflow changes / adoption uncertain
- **Scope**: Best-fit for session start gap alone
- **Philosophy**: YAGNI satisfied, correct seam, no new storage

---

### B -- Recommended: A + git branch description (RECOMMENDED)

A + read `git config branch.<name>.description` in `enrichWorktree()`.
Add `description?: string` to `ConsoleWorktreeSummary`. Display in
`FeaturedCard` as subtitle.

- **Tensions resolved**: Session start gap + branch-level context when set
- **Tensions accepted**: Git description adoption is developer-manual, low
- **Boundary**: `worktree-service.ts` + `ConsoleWorktreeSummary` + `FeaturedCard`
- **Failure mode**: Nobody sets git descriptions; subtitle is always absent
- **Repo pattern**: Follows -- same `Promise.all` in `enrichWorktree()` for
  commit/status/ahead
- **Gain/Lose**: Branch context without new storage; free when unused / git
  description rarely set
- **Scope**: Best-fit
- **Philosophy**: YAGNI slight tension (feature likely unused) -- justified by
  near-zero cost when absent

---

### C -- Norm-enforced: A + workflow intake prompts

A + update `coding-task-workflow-agentic.v2.json` Phase 0 to require `goal`
in first `contextVariables`. Same for `mr-review` (mrTitle), `wr.discovery`.

- **Tensions resolved**: Adoption tension for updated workflows
- **Tensions accepted**: Branch-level gap; workflow maintenance overhead
- **Boundary**: Workflow JSON files (platform-agnostic)
- **Failure mode**: New workflows added without `goal` prompt; norm drifts
- **Repo pattern**: Adapts -- mr-review already sets `mrTitle`, `mrPurpose`
- **Gain/Lose**: Strong adoption for updated workflows / per-workflow maintenance
- **Scope**: Best-fit as Phase 2; too narrow as standalone

---

### D -- Full: B + C

- Resolves all tensions
- B is shippable now; C is a follow-up
- Best long-term outcome
- Scope: correct but C is not blocking

---

## Comparison and Recommendation

**Selected: B ships as Phase 1; C as Phase 2**

B resolves the primary pain (session start gap) with minimal code. The git
branch description addition is near-zero cost and provides genuine value for
users who annotate branches. Both changes are additive and non-breaking.

A loses to B by cost/benefit: 25 lines for git description reading with
zero downside when unused. YAGNI tension is acceptable at this cost.

C is correct but a follow-up. The tool description can strongly recommend
`goal` without requiring workflow changes to ship.

D = B + C sequenced correctly.

---

## Self-Critique

**Strongest case against B**: Git descriptions are so rarely used the feature
is dead code for most users. 25 lines + type extension for near-zero adoption.

**Counter**: Power users who set descriptions will see them. Zero noise for
others. The slot is natural (FeaturedCard already shows headMessage as fallback
in the same visual position).

**Pivot conditions:**
- If git description is not readable from linked worktrees (unlikely -- stored
  in main repo git config, accessible from any worktree path)
- If nobody sets descriptions after 3 months -- remove the feature
- If adoption of `goal` on `start_workflow` is near-zero -- escalate to
  required + migration for existing callers

---

## Open Questions for Main Agent

1. Should `goal` be renamed to match a more specific key? (`taskDescription`
   is already in TITLE_CONTEXT_KEYS -- using `goal` is consistent with the
   existing priority order which has `goal` first.)
2. Should the `start_workflow` tool description add a strong recommendation
   for `goal`, or is a gentle "optional" sufficient?
3. Phase 2 workflow updates: should `goal` be added to ALL workflows, or only
   the major ones (coding-task, mr-review, discovery)?
4. Should the `FeaturedCard` also show the branch description for CompactRow?
   (Currently only FeaturedCard is in scope -- the description is not critical
   enough for the compact list.)
