# Design Candidates: exploration-workflow.json Gap

*Human-facing artifact only. Durable truth is in workflow step notes and context variables.*

*This document is raw investigative material for the main agent's synthesis — not a final decision.*

---

## Problem Understanding

### Core Tensions

**T1: Naming backward-compatibility vs. canonical taxonomy**
`start_workflow exploration-workflow` throws `WorkflowNotFoundError` (-32001, hard error). The storage layer (`file-workflow-storage.ts:254`) does exact-ID lookup via `sanitizeId()` — no fuzzy match, no redirect. `spec/workflow.schema.json` has `additionalProperties: false` and no `aliases` field — aliases cannot be added to workflow files without a schema change. The only in-bundle fix that requires no schema/engine change is adding a workflow file with `id: "exploration-workflow"`.

**T2: Planning doc currency vs. housekeeping cost**
Three planning docs (`docs/roadmap/now-next-later.md`, `docs/roadmap/open-work-inventory.md`, `docs/tickets/next-up.md`) list `exploration-workflow.json` as the #1 modernization priority — a workflow that was intentionally deleted 7 months ago. The docs were never updated because the consolidation (commit `a0ddaaac`) was not followed by a completion-update pass.

**T3: YAGNI vs. discoverability pain**
YAGNI says don't build a general alias mechanism for one case. But the naming gap causes a hard error that the trigger system (`trigger-listener.ts:293`) explicitly treats as serious — it validates workflow IDs at startup to prevent silent `workflow_not_found` failures. These pull in opposite directions.

### Likely Seam

Three simultaneous seams: (1) workflow bundle — `exploration-workflow.json` is gone, `wr.discovery.json` doesn't resolve to the old ID; (2) planning docs — three files with stale references; (3) schema — no alias support exists. The minimum-surface fix uses only seam (1). The architectural fix uses seam (3) and requires a storage layer change.

### What Makes This Hard

The naive fix (update planning docs) doesn't fix the hard error. The clean fix (engine aliases) requires touching the schema and storage layer. The middle path (stub file) is a patch that introduces a non-workflow workflow file into the bundle. A junior developer would update the docs and miss the live error path.

---

## Philosophy Constraints

| Principle | Tension with this problem |
|---|---|
| **Structure earns its place** | A fix that prevents a real recurring failure mode earns its keep. A redirect stub and an alias mechanism both qualify. |
| **YAGNI with discipline** | Don't build a general alias mechanism for one confirmed rename. Stub is the YAGNI-compatible fix; engine alias is premature generalization. |
| **Architectural fixes over patches** | Alias mechanism is the architecturally correct fix. Stub is an explicit patch. This principle and YAGNI are in direct conflict here. |
| **Errors are data** | `WorkflowNotFoundError` is a hard -32001 error. Leaving it live is accepting a known broken path. |
| **Validate at boundaries, trust inside** | The trigger system validates workflow IDs at startup for this reason. The `start_workflow` call is a boundary — errors there should be informative, not hard failures with no guidance. |

**Resolution:** YAGNI wins over "architectural fixes over patches" when one case is confirmed and the general case is speculative. Stub (Candidate B) is the right call for current evidence. Architectural fix (Candidate C) is right when a second rename is confirmed.

---

## Impact Surface

**What must stay consistent if the boundary changes:**

- `bundled-workflow-smoke.test.ts` auto-walks all files in `workflows/` — a stub will be picked up and smoke-tested. It must pass schema validation and produce a valid first-step response.
- `validate:registry` script checks all bundled workflows. The stub must have a valid `id`, `name`, `version`, and `steps[1+]`.
- `list_workflows` MCP tool will surface the stub alongside real workflows. The stub name must clearly signal deprecation to avoid confusion.
- `docs/roadmap/open-work-inventory.md` references `exploration-workflow.json` in the modernization list — must be updated consistently with `now-next-later.md` and `tickets/next-up.md` to avoid contradictory state.
- Any daemon session that reads the roadmap before starting work will no longer be misled into trying to modernize a deleted file.

---

## Candidates

### Candidate A: Update planning docs only

**Summary:** Update 3 stale planning docs; open 2 new GitHub issues (naming gap, codebase archaeology). No workflow files or source changes.

**Tensions resolved / accepted:**
- Resolves: T2 (planning docs)
- Accepts: T1 (hard `WorkflowNotFoundError` stays live), T3 (discoverability pain deferred)

**Boundary:** `docs/roadmap/` and `docs/tickets/` only.

**Why that boundary:** Minimal. Matches the completion-update pattern from AGENTS.md.

**Failure mode:** New issues never prioritized. Hard error persists indefinitely. Agents that read trigger system pattern (`trigger-listener.ts:293`) hit `WorkflowNotFoundError` with no guidance.

**Repo pattern:** Directly follows AGENTS.md completion-update pattern.

**Gains / losses:** Gain: zero blast radius, fast. Loss: hard `WorkflowNotFoundError` stays live; no fix for the error path.

**Scope judgment: Too narrow.** Team's own philosophy treats `workflow_not_found` as a serious failure mode (trigger system, error-handler.ts). Leaving it live while calling the work "done" contradicts that.

**Philosophy fit:** Honors YAGNI. Conflicts with "structure earns its place" and "errors are data."

---

### Candidate B: Thin redirect stub + planning doc updates + new codebase-archaeology issue

**Summary:** Create `workflows/exploration-workflow.json` as a single-step redirect stub. Update 3 planning docs. Open one GitHub issue for codebase-archaeology scope.

**Stub specification:**
```json
{
  "id": "exploration-workflow",
  "name": "Exploration Workflow [deprecated — use wr.discovery]",
  "version": "3.0.0",
  "description": "This workflow ID has moved to wr.discovery. Start a new session with start_workflow wr.discovery instead.",
  "steps": [{
    "id": "redirect",
    "prompt": "This workflow has been renamed. Please start a new session using start_workflow with id 'wr.discovery'. That workflow is the canonical successor to the exploration and design-thinking workflows and covers all the same use cases."
  }]
}
```

Uses only schema-declared fields (`id`, `name`, `version`, `description`, `steps`). No new fields. `additionalProperties: false` is satisfied. Single step satisfies `steps: { minItems: 1 }`.

**Tensions resolved / accepted:**
- Resolves: T1 (hard error fixed — `exploration-workflow` resolves to stub, step tells user to use `wr.discovery`)
- Resolves: T2 (planning docs updated)
- Accepts: T3 partially (codebase-archaeology deferred, but explicitly tracked as new issue)

**Boundary:** Workflow file layer — the minimum-surface boundary. Storage layer does file-based dispatch; adding a file is the natural extension point for this layer.

**Why that boundary is best fit:** Zero engine, zero schema, zero source changes. The problem lives at the workflow-ID resolution boundary; the fix lives at the same boundary.

**Failure mode:** Stub appears in `list_workflows` output alongside real workflows. Users may be confused about two discovery-related entries. The stub's name and description must be explicit enough to avoid this. If `bundled-workflow-smoke.test.ts` runs the stub and checks for substantive output, it may fail quality gates.

**Repo pattern:** Adapts existing pattern (thin-purpose workflow files like `test-session-persistence.json` already exist in the bundle). Redirect-only is a new usage but not architecturally alien.

**Gains / losses:** Gain: hard `WorkflowNotFoundError` fixed immediately; zero source changes; stub is reversible in one commit when engine aliases ship. Loss: non-workflow file in the workflow bundle; potential `list_workflows` confusion; stub accumulates debt if not eventually replaced.

**Scope judgment: Best-fit.** Fixes the real failure mode (hard error) at the minimum surface. Remaining open question explicitly scoped.

**Philosophy fit:** Honors "structure earns its place" (prevents real recurring failure), YAGNI (minimal stub only), "validate at boundaries" (error caught at `start_workflow` boundary). Explicit conflict: "architectural fixes over patches" — the stub is a patch. Accepted tradeoff.

---

### Candidate C: Engine alias feature

**Summary:** Add `aliases?: readonly string[]` to `spec/workflow.schema.json`; extend `getWorkflowById` in `src/infrastructure/storage/file-workflow-storage.ts` to build an alias-to-canonical-id map during index construction and try secondary alias lookup on not-found; populate `wr.discovery.json` with `aliases: ["exploration-workflow", "design-thinking-workflow"]`. Update 3 planning docs.

**Feature specification:**
- Schema change: `"aliases": { "type": "array", "items": { "type": "string" }, "uniqueItems": true }` added to `spec/workflow.schema.json` as an optional property.
- Storage change: In `getWorkflowIndex()` (`file-workflow-storage.ts`), two-pass index build: first pass builds primary-id index, second pass adds `aliasId → canonicalId` mappings. In `getWorkflowById`, when `index.get(safeId)` returns null, try `aliasIndex.get(safeId)` to get the canonical ID, then retry.
- Alias uniqueness enforcement: Schema validator rejects workflows where an alias collides with any other workflow's primary ID or alias.
- Workflow file change: `wr.discovery.json` declares `"aliases": ["exploration-workflow", "design-thinking-workflow"]`.
- No `src/v2/durable-core/` changes required — alias resolution happens at the storage/registry layer.

**Tensions resolved / accepted:**
- Resolves: T1 (naming hard error fixed architecturally)
- Resolves: T3 (YAGNI pressure partially — alias mechanism is general, handles future renames)
- Resolves: T2 (planning docs updated)
- Accepts: T3 partially — codebase-archaeology still a separate open question

**Boundary:** Schema + storage layer. Additive change to both. No protected `src/v2/durable-core/` code touched.

**Why that boundary:** Architecturally correct. The alias mechanism belongs at the workflow registry/storage layer, not as a workflow file. This is where ID resolution happens.

**Failure mode:** Alias cycles (workflow A aliases to workflow B which aliases back to A) cause infinite loops or index build errors. Duplicate aliases across workflows create ambiguous resolution. Secondary-lookup latency adds to every not-found call. All addressable with defensive implementation — but requires more engineering discipline.

**Repo pattern:** Departs from existing patterns. No alias mechanism exists today. New tests needed. Schema validator must be extended.

**Gains / losses:** Gain: architecturally correct; no stub debt; `wr.discovery` self-documents its predecessors; generalizes to future renames. Loss: substantially larger scope; schema + storage + tests; requires new validator logic; slower to ship.

**Scope judgment: Too broad** for current evidence. One confirmed rename. No second rename in the backlog. YAGNI says don't build for a case that isn't confirmed.

**Philosophy fit:** Honors "architectural fixes over patches." Honors "structure earns its place." Conflicts with YAGNI — general feature for one case.

---

## Comparison and Recommendation

### Tensions vs. candidates matrix

| Tension | A | B | C |
|---|---|---|---|
| T1: Naming hard error | ✗ | ✓ | ✓ |
| T2: Planning doc currency | ✓ | ✓ | ✓ |
| T3: YAGNI vs. discoverability | ✓ | ~ | ✗ |

### Decision criteria verdict

| Criterion | A | B | C |
|---|---|---|---|
| Resolve roadmap item without losing intent | ✓ | ✓ | ✓ |
| Address naming/discoverability gap | ✗ | ✓ | ✓ |
| Scope new work distinctly | ~ | ✓ | ~ |
| Actionable without unavailable session analytics | ✓ | ✓ | ✓ |

### Recommendation: **Candidate B**

B is the only candidate that satisfies all 4 decision criteria. A is strictly dominated by B (same doc fix, doesn't fix hard error). C is premature generalization for one confirmed case.

**Core rationale:** One deleted workflow causing one hard error. Fix: one file. The storage layer's file-based dispatch makes "add a file" the natural, minimum extension point. Zero engine changes. The stub is reversible in one commit when Candidate C is eventually justified.

---

## Self-Critique

**Strongest argument against Candidate B:** The stub is explicit technical debt. `list_workflows` will return two discovery-related entries and users may be confused. The stub's step prompt tells users to restart their session entirely — a friction point. "Architectural fixes over patches" is a stated first-class principle, and a stub is an explicit patch.

**Why Candidate A lost:** Strictly dominated by B. Same planning doc fix, doesn't fix the hard error. The additional work for B is one stub file. No scenario where A is better than B.

**What would justify Candidate C:** (1) A second workflow consolidation creates another `WorkflowNotFoundError`; OR (2) the project owner explicitly decides alias support is a product feature worth shipping; OR (3) the stub causes confirmed user confusion in `list_workflows` and a `hidden`/`deprecated` schema field would be needed anyway (at which point the schema is already being changed, so adding `aliases` is marginal cost).

**Assumption that invalidates Candidate B:** If `bundled-workflow-smoke.test.ts` enforces that all workflow files must produce substantive exploration outputs (not redirect-only prompts), the stub fails quality gates. The smoke test auto-walks all files in `workflows/`. If it checks output quality, not just schema validity, the stub fails. Risk assessment: low — the smoke test is a structural validation test, not an output-quality test — but verify before shipping.

---

## Open Questions for the Main Agent

1. **Smoke test compatibility:** Does `tests/lifecycle/bundled-workflow-smoke.test.ts` check only schema validity and step reachability, or does it also assert on output quality? The stub passes the former; may fail the latter.

2. **list_workflows filtering:** Is there any existing mechanism to mark a workflow as deprecated or hidden from `list_workflows` output? If not, is the stub's explicit `[deprecated]` naming suffix sufficient?

3. **Project owner intent:** The consolidation commit (`a0ddaaac`) was AI-authored (Firebender co-author). The metaGuidance "canonical successor" claim was written by the same session. Does the project owner independently confirm that wr.discovery fully covers the exploration use case, or should a human review be requested before closing this item?

4. **Codebase-archaeology gap:** Is there evidence in session history that users invoke wr.discovery for "explore this codebase" tasks and find it mis-shaped? This would change the recommendation from "open a new issue" to "create `wr.explore.json` now."
