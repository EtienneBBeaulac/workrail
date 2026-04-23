# Design Review Findings: exploration-workflow.json Gap

*Human-facing artifact. Durable truth is in step notes and context variables.*

*Optimized for main-agent synthesis — concise and actionable.*

---

## Selected Direction

**Candidate B (hybrid variant):** Thin redirect stub at `workflows/exploration-workflow.json` + update `wr.discovery.json` description to name predecessors + update 3 planning docs + open 1 GitHub issue for codebase-archaeology scope.

---

## Tradeoff Review

| Tradeoff | Status | Condition for failure |
|---|---|---|
| Stub is a patch not an architectural fix | Acceptable | Escalate to engine alias (Candidate C) on second workflow rename |
| Stub appears in list_workflows alongside wr.discovery | Acceptable | Monitor for user confusion; fix by name if needed |
| Codebase-archaeology gap deferred to GitHub issue | Acceptable conditional | Stub prompt MUST explicitly distinguish problem-space exploration from codebase archaeology |

All three tradeoffs are acceptable under current conditions. No invariant is violated.

---

## Failure Mode Review

| Failure Mode | Severity | Coverage | Missing Mitigation |
|---|---|---|---|
| Stub accumulates indefinitely, alias feature never ships | LOW-MEDIUM | Partially handled | Add technical debt note to stub `description`; GitHub issue should note Candidate C pivot condition |
| Stub prompt too vague, misleads agents about codebase-archaeology scope | **MEDIUM — HIGHEST RISK** | Handled only if prompt written as specified | None beyond correct prompt authoring |
| list_workflows confusion between stub and wr.discovery | LOW | Handled by stub name with `[deprecated]` | None required without evidence |

**Most dangerous:** FM2 (vague prompt). Only silent failure mode — agents won't error, they'll silently use wr.discovery for the wrong job. The required stub prompt is the mitigation; it is non-optional.

---

## Runner-Up / Simpler Alternative Review

**Runner-up (Candidate C — engine alias):** One element worth borrowing: update `wr.discovery.json`'s description to name predecessor IDs. Zero schema changes. One sentence. Survives stub deletion. Adopted into the hybrid.

**Simpler variant (no stub file):** Fails decision criterion 2. `WorkflowNotFoundError` fires before any description is visible. The stub is required.

**Hybrid verdict:** Stub + wr.discovery description update is strictly better than stub alone. Adopted.

---

## Philosophy Alignment

| Principle | Status |
|---|---|
| Structure earns its place | ✓ Satisfied — stub prevents real recurring failure |
| YAGNI with discipline | ✓ Satisfied — no speculative abstractions |
| Errors are data | ✓ Satisfied — hard error path actively fixed |
| Observability as a constraint | ✓ Satisfied — three visibility improvements |
| Document "why" not "what" | ✓ Satisfied — stub prompt and description document rationale |
| Architectural fixes over patches | ~ Tension — stub is a patch; accepted because YAGNI counterbalances for one case |
| Make illegal states unrepresentable | ~ Informational — `deprecated: true` field would be cleaner but requires schema change; name-based convention is sufficient |

No principle is violated in a way that creates correctness or reliability risk.

---

## Findings

### ORANGE: Stub spec was missing required `title` field on step

**Discovery:** `standardStep` schema requires `id` AND `title` (not just `id`). The spec in `design-candidates.md` omitted `title` on the step definition. A stub built from that spec would fail schema validation and the smoke test.

**Resolution:** Corrected spec (see Recommended Revisions). Add `"title": "This workflow has moved"` to the step. Verified against schema.

---

### ORANGE: Stub prompt content is non-optional — vague prompt creates silent misleading guidance

**Discovery:** If the stub's step prompt is simplified to "use wr.discovery instead," it encodes a false assumption: that wr.discovery covers codebase archaeology. This is the highest-risk failure mode.

**Resolution:** The stub's step prompt is a hard deliverable requirement. See Recommended Revisions for exact required wording.

---

### YELLOW: Candidate C pivot condition must be explicitly tracked

**Discovery:** The stub creates technical debt that should trigger Candidate C (engine alias feature) when a second workflow rename is confirmed. Without an explicit tracking mechanism, the debt persists invisibly.

**Resolution:** (1) Add a note to stub's `description` field. (2) Include Candidate C pivot condition in the GitHub issue for codebase-archaeology scope.

---

### YELLOW: wr.discovery description update not yet applied

**Discovery:** The hybrid design requires updating `wr.discovery.json`'s description to name predecessor IDs. This was added in the hybrid review but is not yet reflected in any existing doc.

**Resolution:** See Recommended Revisions.

---

## Recommended Revisions

### Revision 1 — Corrected stub specification (REQUIRED)

```json
{
  "id": "exploration-workflow",
  "name": "Exploration Workflow [deprecated — use wr.discovery]",
  "version": "3.0.0",
  "description": "This workflow ID has moved. The exploration and design-thinking workflows were consolidated into wr.discovery (Discovery Workflow) in March 2026. Temporary redirect stub — replace with engine-level alias support if a second workflow rename creates another WorkflowNotFoundError.",
  "steps": [
    {
      "id": "redirect",
      "title": "This workflow has moved",
      "prompt": "This workflow has been renamed and restructured as 'wr.discovery' (Discovery Workflow).\n\nFor problem-space exploration, decision-making, design thinking, or comparing approaches to an ambiguous problem: start a new session with start_workflow using id 'wr.discovery'.\n\nImportant distinction: if your goal is to systematically map or understand an unfamiliar codebase — tracing architecture, call stacks, data flows, or module structure — that is a different job from problem-space exploration. No dedicated bundled workflow covers it yet. Use your standard code investigation tools (Grep, Read, Bash) directly for that task."
    }
  ]
}
```

All required fields satisfied: `id` (≥3 chars), `name` (≥1), `description` (≥1), `version`, `steps` (minItems: 1). Step has `id` and `title`. Prompt ≤8192 chars.

---

### Revision 2 — wr.discovery description update (REQUIRED for hybrid)

Current `description`: `"Use this to explore and think through a problem end-to-end. Moves between landscape exploration, problem framing, candidate generation, adversarial challenge, and uncertainty resolution."`

Proposed: `"Use this to explore and think through a problem end-to-end. Moves between landscape exploration, problem framing, candidate generation, adversarial challenge, and uncertainty resolution. This is the canonical successor to exploration-workflow and design-thinking-workflow — if you are looking for either of those by name, this is the right workflow."`

---

### Revision 3 — Planning doc updates (REQUIRED)

Three files need updating:

**`docs/roadmap/now-next-later.md` (Next section):**
Remove: `exploration-workflow.json is the highest-priority candidate.`
Replace with: `exploration-workflow.json was superseded by wr.discovery (see open-work-inventory.md). The remaining open question is whether a codebase-archaeology workflow (wr.explore or equivalent) is warranted — tracked as a separate GitHub issue.`

**`docs/roadmap/open-work-inventory.md` (Legacy workflow modernization section):**
Update status to: complete for exploration-workflow (superseded by wr.discovery v3.2.0, redirect stub added). Open: mr-review-workflow.json, bug-investigation.json remain on the modernization list.

**`docs/tickets/next-up.md` (Ticket 2):**
Replace "Legacy workflow modernization -- exploration-workflow.json" with a note: superseded. Point to the new GitHub issue for codebase-archaeology scope.

---

### Revision 4 — New GitHub issue (REQUIRED)

Title: `feat(workflows): decide whether codebase-archaeology exploration warrants a new wr.explore workflow`

Body should include:
- Problem: wr.discovery is shaped for problem-space exploration and strategic decision-making. Systematic codebase mapping (architecture understanding, call stack tracing) is a different job with different tools.
- Evidence gap: no session data confirming this gap is real vs. hypothetical.
- Acceptance criteria: investigate whether wr.discovery is being used for codebase-archaeology tasks and producing mis-shaped outputs; if confirmed, create wr.explore.json with explicit scope.
- Pivot condition for Candidate C: if a second workflow rename creates another WorkflowNotFoundError, escalate this issue to include engine alias support (adds `aliases` field to schema and secondary lookup to file-workflow-storage.ts).
- Labels: `feature`, `next`

---

## Residual Concerns

1. **The consolidation commit was AI-authored (Firebender).** The metaGuidance "canonical successor" claim was written by an AI session, not explicitly confirmed by the project owner. Before closing the roadmap item, it would be good to have the project owner verify that wr.discovery fully covers their intended exploration use case. This is a human-gate, not a technical concern.

2. **Codebase-archaeology use case is unverified.** No session data is available to confirm whether this gap causes real-world pain. The GitHub issue captures it, but without evidence it may never be prioritized. Acceptable — it's explicitly tracked rather than silently ignored.

3. **Stub name contains square brackets.** `[deprecated — use wr.discovery]` in the workflow name is a convention, not a schema-enforced status. If the project later adds a `deprecated: boolean` field to the schema, this convention should be replaced. Low priority.
