# WorkTrain Task Queue: GitHub Issue Schema Design

## Artifact Strategy

This document is a human-readable design record. It is NOT execution memory -- the WorkRail workflow session notes and context variables are the durable execution truth. If a rewind occurs, the session notes survive; this file may not. Treat this file as a readable summary of decisions made, not a source of truth for the workflow.

---

## Context / Ask

**Stated goal:** Design the GitHub issue schema for the WorkTrain task queue -- what fields an issue needs so a future adaptive coordinator can route it correctly, without assuming the coordinator's internal design is settled.

**Reframed problem:** A WorkTrain coordinator cannot deterministically route a GitHub issue to the right pipeline (full shaping+discovery+coding, discovery+coding, or coding-only) because no issue carries the signals needed to distinguish these cases.

**Note:** The stated goal is a solution statement. The reframed problem is the actual constraint we are designing against.

---

## Path Recommendation

**Path: design_first**

The dominant risk here is defining the wrong schema -- one that is either over-specified (encoding coordinator internals in the issue) or under-specified (leaving routing ambiguous). The stated solution (YAML frontmatter + labels) is a reasonable implementation direction, but the schema contract -- which fields are required, what they mean, and how they map to pipeline decisions -- needs to be reasoned through before any format is chosen.

The Three-Workflow Pipeline and taskMaturity spectrum are already partially defined in backlog.md (Apr 15, Apr 18). The schema must align with these, not contradict them.

---

## Constraints / Anti-goals

**Constraints:**
- Must be readable by the existing `github_issues_poll` TriggerDefinition (via `labelFilter` / `notLabels`)
- Must support deterministic pipeline routing without an LLM call
- Human must be able to file a valid issue in under 2 minutes
- Schema must be stable even if the coordinator's internal implementation changes

**Anti-goals:**
- Not a full project management system (no sprint planning, estimation, assignee tracking)
- Not a replacement for docs/tickets/next-up.md for near-term groomed work
- Not a schema that encodes coordinator internals (keep routing signals on the issue side of the contract)

---

## Landscape Packet

### Current State

**Task queue today:** No automated task queue exists. Near-term work is tracked in `docs/tickets/next-up.md` as prose tickets (goal + blocked-on + design reference). This is a human-curated, unstructured format with no machine-readable fields.

**Transport layer (github_issues_poll):** Fully implemented and wired in `src/trigger/`. The `GitHubPollingSource` supports `labelFilter` (server-side, passed as `labels=` query param) and `notLabels` (client-side drop). The adapter (`src/trigger/adapters/github-poller.ts`) fetches `GitHubIssue` objects with: `id`, `number`, `title`, `html_url`, `updated_at`, `state`, `user.login`, `labels[].name`. **Confirmed from source: no `body` field in `GitHubIssue`.** The poller has zero awareness of issue body content. Any body-based routing requires the coordinator to make a separate `GET /repos/:owner/:repo/issues/:number` API call.

**Coordinator today:** Only `src/coordinators/pr-review.ts` exists. It dispatches MR review sessions, classifies findings, and routes by severity. It does NOT read issue bodies or maturity fields. No routing by issue content exists yet.

**Routing signals defined in backlog (not yet implemented):**
- `taskMaturity`: idea / rough / specced / ready / code-complete (backlog Apr 15)
- `existingArtifacts`: brd / designs / arch-decision / acceptance-criteria / ticket / implementation
- Three-Workflow Pipeline: `wr.discovery` (optional) -> `wr.shaping` (optional) -> `wr.coding-task` (Apr 18)

**TriggerDefinition routing fields:** `workflowId` is static per trigger. To dispatch different workflows from the same trigger, the routing must happen either in a coordinator script (reads issue, decides workflowId) or via multiple triggers with different `labelFilter` values.

### Hard Constraints

1. The `github-poller.ts` fetches issue labels but NOT the issue body. A coordinator spawned by the trigger receives the `goalTemplate` context and labels, but not body content unless it makes a separate GitHub API call.
2. `labelFilter` is server-side (passed to GitHub API), `notLabels` is client-side. Labels are the primary dispatch-gating mechanism today.
3. A single trigger fires one fixed `workflowId`. Multi-pipeline routing requires either: (a) a coordinator workflow that reads the issue and spawns the right child, or (b) multiple triggers with different labels.

### Main Existing Approaches (Precedents)

- **Labels-only routing** (Dependabot, GitHub Actions): uses label taxonomies like `priority:high`, `type:bug`. Lightweight, native to GitHub UI, no body parsing.
- **YAML frontmatter in issue body** (Linear-style, some internal tools): structured metadata at the top of the body. Requires the coordinator to call `GET /repos/:owner/:repo/issues/:number` to fetch the body, then parse YAML.
- **Structured section** (e.g. `## Metadata` with `key: value` lines): same parsing cost as frontmatter, less standard, harder to validate.
- **Hybrid** (labels for routing dimensions + body for prose context): labels carry machine-readable fields, body carries human-readable description and upstream links.

### Obvious Contradictions

1. The poller does not fetch issue body content -- but the goal says routing signals could include `upstream_spec` (a URL/path) and `affected_files`. These cannot come from labels alone. Contradiction: if routing needs these fields, a separate API call is required.
2. The goal says "design the schema as if the coordinator's routing interface doesn't yet exist" -- but the backlog has a partially-settled routing interface (taskMaturity, Three-Workflow Pipeline). The schema should align with this, not ignore it.

### Evidence Gaps

- No coordinator script for issue-based routing exists yet. The schema will be designed before its primary consumer is implemented.
- No sample GitHub issue with WorkTrain metadata exists in the repo. The sample will be the first instance.
- It is unknown whether the coordinator will need body content or labels alone for routing. This is the primary uncertainty to resolve in design.

---

## Problem Frame Packet

**Goal type:** `solution_statement` -- the stated goal prescribes a specific artifact (issue schema) rather than the underlying problem.

**Reframed problem:** A coordinator dispatching GitHub issues to the three-workflow pipeline has no reliable machine-readable signal in an issue to deterministically choose which pipeline to run, so it either over-fetches context at runtime or makes wrong routing decisions.

**Alternative approaches (not pursued):**
- Coordinator classifies at dispatch via LLM from prose body -- no schema required, but non-deterministic
- GitHub labels only -- native to GitHub UI, no body parsing, but limited to flat single-dimension taxonomy
- External task queue (Linear, Jira) with native structured fields synced to GitHub -- richer querying but external dependency

**Why in-body schema is best match:** deterministic routing without LLM calls at routing time, stays within GitHub, forward-compatible with richer coordinator logic.

### Stakeholders

| Stakeholder | Job / Outcome | Pain Today |
|-------------|---------------|------------|
| WorkTrain coordinator script | Read next task, decide which pipeline to run, dispatch the right workflow | No structured queue. next-up.md is prose-only; coordinator cannot read it programmatically without LLM parsing. |
| Human developer filing issues | Communicate "here's what needs to be done" quickly, minimal ceremony | No schema. Today: write prose in next-up.md or file raw GitHub issues. |
| github_issues_poll trigger | Dispatch issues with label `worktrain` to the right workflow | Labels are the only filterable field. Single trigger fires one static workflowId -- cannot vary by issue content. |
| Future grooming coordinator | Promote backlog items to GitHub issues, set maturity/type labels | No schema to populate; no promotion criteria defined. |

### Tensions

**T1: Richness vs. filing cost** -- A schema rich enough to route unambiguously requires 5+ fields. Every required field is a filing barrier. The minimum for routing may be just `maturity` (one field maps to three-pipeline decision). Everything else is optional enrichment.

**T2: Labels vs. body schema** -- Labels are free for the trigger (no extra API call), machine-readable, native to GitHub UI. But they can only carry enumerated values -- no URLs, no file paths. `upstream_spec` (a URL) can only live in the body. If the coordinator needs it for routing, a separate API call is required. If it only needs it at runtime (not routing), body is fine and fetched lazily by the workflow.

**T3: Schema stability vs. coordinator evolution** -- If the schema anticipates future coordinator fields (e.g. `complexity`, `auto_merge`), it encodes assumptions that may be wrong when the coordinator is built. Safer default: only include fields needed for the settled routing decision (three-pipeline choice), leave everything else unspecified.

**T4: Machine-readable vs. human-natural** -- YAML frontmatter is parseable but unusual in GitHub issues. A `## WorkTrain` metadata section is more readable but requires a custom parser. Labels are native to GitHub and require no body parsing.

### Success Criteria (refined)

1. Coordinator picks pipeline deterministically from issue metadata alone -- no LLM call at routing time
2. Developer can file a valid WorkTrain issue in under 2 minutes with only one truly required field
3. Label taxonomy covers full task lifecycle: queued -> in-progress -> done / blocked
4. An upstream spec URL can be expressed in the issue and found by the coding workflow's Phase 0.5 context-gather step
5. The design document is self-contained: a developer can file a correct issue without reading backlog.md

### HMW Questions

- **HMW make routing work with labels alone for the common case**, while supporting body-carried fields like `upstream_spec` only for the cases that need them?
- **HMW keep the schema minimal today** while leaving room for grooming automation to enrich issues without a schema revision?

### Primary Framing Risk

**If `upstream_spec` presence/absence is itself a routing signal (not just runtime enrichment), then body content is required for every issue at routing time, and the "labels primary, body optional" assumption is broken.**

Mitigating evidence: the Three-Workflow Pipeline ADR (Apr 18) says Phase 0.5 in the coding workflow detects the upstream spec at runtime. If Phase 0.5 detects it at runtime, it is not a routing input -- the pipeline selection happens before Phase 0.5 runs. This suggests `upstream_spec` is runtime enrichment, not a routing gate, which means labels-only pipeline selection is viable.

**Challenged assumptions:**

1. **Labels alone are sufficient** -- flat label set cannot express multi-dimensional routing (maturity x type x complexity = 12+ combinations). Coordinator could classify from prose via LLM, but that is non-deterministic. *Evidence:* `GitHubPollingSource.labelFilter` handles single-dimension routing only.

2. **YAML frontmatter is the right representation** -- GitHub gives frontmatter no special treatment; it renders as raw text. A `## Metadata` section is equally parseable and more legible. *Evidence:* `github-poller.ts` does not fetch issue body regardless of format.

3. **All 5 proposed fields are routing gates at MVP** -- The Three-Workflow Pipeline ADR identifies a single routing hinge: "small, concrete, clearly scoped" task skips discovery+shaping. The routing signal may be binary at MVP. Fields like `type`, `complexity`, and `auto_merge` are context enrichment, not pipeline-selection gates. *Evidence:* backlog.md coordinator pipeline templates derive `taskComplexity`/`riskLevel` as workflow outputs during classification, not as pre-set issue fields.

---

## Candidate Directions

### Generation Expectations (design_first + THOROUGH)

The candidate set must:
1. Include at least one direction that **meaningfully reframes** the problem rather than only packaging obvious solutions (e.g. "what if routing is implicit in the trigger structure, not the issue?")
2. Span the full format space: labels-only, body-only (frontmatter), body-only (structured section), hybrid -- each as a distinct candidate
3. Include at least one candidate that is the minimum viable schema (smallest possible required field set)
4. Cover the riskiest assumption: at least one candidate that shows what changes if `type` is required alongside `maturity`
5. Each candidate must explicitly state its routing mechanism (how the coordinator reads it), its required vs optional fields, and its failure mode

**Key insight (added Apr 19):** Binary routing (ready vs. not-ready) is insufficient. The coordinator needs to distinguish `idea` (full discovery+shaping+coding), `specced` (shaping+coding), and `ready` (coding only). This is three labels, not one. At least one candidate must use this three-value maturity signal.

**Risky assumption to test:** `upstream_spec` is runtime enrichment, not a routing gate. At least one candidate should show what changes if this assumption is wrong.

---

### Candidate A: Labels-only routing (minimum viable schema)

**One-sentence summary:** The issue carries one required label from a closed three-value maturity enum (`worktrain:idea`, `worktrain:specced`, `worktrain:ready`) plus the base `worktrain` queue label; all other routing fields are inferred or omitted.

**Tensions resolved / accepted:**
- Resolves T2 (labels free at routing -- no body API call needed)
- Resolves T3 (schema stability -- only the settled routing signal is in the issue)
- Accepts T1 (filing cost is minimal: one required label)
- Accepts T4 (partial: GitHub label UI is native; no custom parsing needed)

**Boundary:** the trigger's `labelFilter` catches `worktrain` issues; the coordinator reads `issue.labels[].name`, maps to `TaskMaturity = 'idea' | 'specced' | 'ready'`, dispatches pipeline. Same pattern as `ReviewSeverity` in `pr-review.ts` -- a typed discriminant derived from a raw signal.

**Failure mode:** human files an issue with no maturity label (just `worktrain`). Coordinator returns `Result<TaskMaturity, 'missing_maturity'>` -- issue is held in queue unrouted until labeled. Must be documented as required field.

**Relation to repo patterns:** follows `ReviewSeverity` / `pr-review.ts` exactly. Labels -> typed discriminant -> exhaustive switch.

**Gain:** no body API call, deterministic routing, zero coordinator complexity for body parsing, label UI is native to GitHub.

**Give up:** no machine-readable `upstream_spec` URL (must be in body prose, found by Phase 0.5 at runtime), no `type` or `complexity` signals at routing time.

**Impact surface:** coordinator implementation is simple (label lookup only). Phase 0.5 in the coding workflow already does runtime spec discovery -- `upstream_spec` does not need to be a routing input.

**Scope judgment:** best-fit. Resolves the core routing problem with the minimum machinery.

**Philosophy alignment:**
- Honors: Make illegal states unrepresentable (closed three-value enum), Exhaustiveness everywhere (switch on TaskMaturity), YAGNI with discipline
- Conflicts with: none -- this is the lean path

**Label taxonomy:**
```
worktrain              -- in queue (required on all WorkTrain issues)
worktrain:idea         -- needs discovery + shaping + coding
worktrain:specced      -- needs shaping + coding
worktrain:ready        -- coding only
worktrain:in-progress  -- coordinator has dispatched a pipeline for this issue
worktrain:done         -- pipeline completed successfully
worktrain:blocked      -- pipeline failed or requires human attention
```

**Issue body:** free-form prose. No structured metadata required. Phase 0.5 detects `upstream_spec` from body text at runtime.

---

### Candidate B: Hybrid (maturity labels + body `## WorkTrain` section)

**One-sentence summary:** Maturity labels drive routing (same three-value enum as A); the issue body optionally carries a `## WorkTrain` metadata section with `upstream_spec`, `type`, and `complexity` fields for enriching the workflow context -- not for routing.

**Tensions resolved / accepted:**
- Resolves T1 (richness is possible via optional body fields without increasing required fields)
- Resolves T2 (routing still uses labels; body is fetched lazily only when workflow starts, not at dispatch time)
- Resolves T4 (body section is more readable than YAML frontmatter; parsing is straightforward `key: value` lines)
- Accepts T3 partial: the optional body fields are enrichment-only -- adding new fields does not break the routing contract

**Boundary:** coordinator reads labels for routing; workflow reads body section at Phase 0.5 for context enrichment. Two distinct read times and two distinct read paths.

**Failure mode:** body section present but malformed (missing colon, extra whitespace). Coordinator must treat body parsing as best-effort: `Result<Partial<IssueMetadata>, never>` (always succeeds; missing fields are `undefined`). No routing decisions can depend on body fields being well-formed.

**Relation to repo patterns:** adapts existing pattern. `contextMapping` in `TriggerDefinition` already supports dot-path extraction from webhook payload -- the body `## WorkTrain` section is analogous but requires a separate API call. Follows the 'validate at boundaries, trust inside' principle: coordinator validates label at dispatch; body fields are trusted if present.

**Gain:** human can express `upstream_spec` in the issue without embedding it in prose. `type` and `complexity` are available as context hints to the workflow. Future grooming coordinator can populate these fields programmatically.

**Give up:** body API call required before Phase 0.5 runs (coordinator or workflow must fetch body). Body parsing adds a code path that must handle malformed input. The optional fields create an implicit contract that may drift as coordinator evolves.

**Impact surface:** Phase 0.5 `context-gather` step (proposed in backlog Apr 19) would benefit from a structured `upstream_spec` field -- this candidate aligns with that spec.

**Body metadata format:**
```markdown
## WorkTrain

upstream_spec: https://docs.example.com/pitch/feature-x
type: feature
complexity: Small
auto_merge: false
```

**Scope judgment:** best-fit for teams that want to express spec URLs in a machine-readable way without external tooling. Too broad if routing never needs body fields -- then the section is dead weight.

**Philosophy alignment:**
- Honors: Validate at boundaries (label validation at dispatch), Prefer explicit domain types (structured section over prose hunting)
- Conflicts with: YAGNI with discipline -- `type`/`complexity`/`auto_merge` have no concrete coordinator use case yet

---

### Candidate C: Coordinator-inferred maturity (reframe -- no required human-set fields)

**One-sentence summary:** The issue carries only `worktrain` (queue signal); the coordinator infers maturity from the issue title, body prose, and the presence/absence of linked artifacts (PR, pitch file, spec URL) -- no maturity label required from the human filer.

**Tensions resolved / accepted:**
- Resolves T1 fully (zero required fields beyond `worktrain` label -- lowest possible filing cost)
- Accepts T2 (coordinator must fetch issue body to infer maturity -- API call required)
- Accepts T4 (inference is probabilistic, not deterministic -- violates 'no LLM call at routing time' criterion)

**Boundary:** coordinator fetches body, makes an LLM call to classify `TaskMaturity`, then dispatches. Similar to how `parseFindingsFromNotes()` falls back to keyword scan -- but for routing, not just severity.

**Failure mode:** LLM misclassifies maturity. An `idea` is routed to coding-only because the issue title says 'implement X' even though no spec exists. The failure mode is silent and hard to detect -- the workflow runs but produces wrong output.

**Relation to repo patterns:** departs from the established pattern. `ReviewSeverity` uses structured artifacts (preferred) or keyword scan (fallback) but NEVER routes to a different workflow based on a probabilistic classification. Using LLM inference for routing would be a new and riskier pattern.

**Gain:** lowest friction for humans filing issues. No schema to learn or enforce.

**Give up:** deterministic routing (success criterion #1). Coordinator complexity increases significantly. Testing requires mocking LLM calls. Routing behavior is unpredictable.

**Scope judgment:** too broad for MVP. May be appropriate as a fallback path (if maturity label is missing, coordinator tries to infer), but should NOT be the primary routing path.

**Philosophy alignment:**
- Honors: YAGNI with discipline (from the human's perspective -- no required fields)
- Conflicts with: Determinism over cleverness (routing depends on hidden LLM state), Make illegal states unrepresentable (maturity is inferred, not declared)

**Verdict:** viable only as a fallback path, not as the primary routing mechanism. Candidate A or B should be the primary path; C could handle the missing-label case with an LLM inference step and explicit 'routing-uncertain' log output.

*(Candidates populated below)*

See docs/design/worktrain-task-queue-candidates.md for full candidate details and tradeoff analysis.

### Summary: Candidate B (Hybrid) recommended

- **A: Labels-only** -- 3 required labels (worktrain, maturity, type), no body read, minimum viable. Routing correct. No standard location for upstream_spec.
- **B: Hybrid** -- same labels as A for routing + optional ## WorkTrain section in body for enrichment (upstream_spec, affected_files). Routing identical to A. Body read lazily by workflows at runtime, not by coordinator.
- **C: YAML frontmatter** -- all metadata in body frontmatter. Rejected: body fetch required at routing time; YAML parse failure blocks routing.
- **D: Three-trigger** -- one trigger per pipeline path. Rejected: GitHub Issues API labels= uses OR semantics, not AND.

**B is recommended** because routing is identical to A (label-only, no extra dispatch-time API call), but B adds a standard machine-readable location for upstream_spec consumed by Phase 0.5 of the coding workflow. The section is optional.

---

## Challenge Notes

### Challenge 1: The body section is optional but documentation will make it de-facto required

Once in the sample issue, developers will copy-paste the `## WorkTrain` section into every issue. The 'optional' label will not prevent this. A future coordinator expecting structured metadata may treat issues without the section as malformed. **Verdict:** real risk. Mitigation: sample issue must explicitly demonstrate that a label-only issue (no body section) is a valid, complete WorkTrain issue.

### Challenge 2: Convergence between two independent sessions could be group-think

Both analysis sessions recommended Candidate B. Is this genuine signal or confirmation bias from the shared design doc context? **Probe:** the prior session independently identified Candidate D (three-trigger architecture) which this session missed, and made `type` a required label rather than optional. Material differences exist between the sessions despite converging on B. **Verdict:** genuine convergence across genuinely different analyses.

### Challenge 3: Is `type` required or optional?

The prior candidates file made `type` a required label. This session classified it as optional enrichment. **Resolution:** `type` changes which phases run inside the coding workflow but does NOT change pipeline selection (maturity drives the three-pipeline decision). The coordinator does not need `type` to select a pipeline. `type` is optional enrichment. **Verdict:** prior file was slightly over-specified. `type` labels are excluded from the initial taxonomy.

### Challenge 4: Does the `## WorkTrain` section actually improve over prose?

Phase 0.5 `context-gather` already extracts any URL from the task description. If the URL is in the first line of the prose body, Phase 0.5 finds it. **Verdict:** weak benefit, but real. A consistent structured location reduces false positives from URL extraction (e.g. GitHub issue links in body that are not the upstream spec).

### Challenge 5: Should `type` labels exist at all in the initial taxonomy?

If `type` is optional and the coordinator doesn't read it, creating `worktrain:type:*` labels in GitHub adds clutter with no consumer. **Resolution:** do not create `type` labels initially. Document the convention for future use. Labels are created when the coding workflow confirms it reads them.

---

## Resolution Notes

**Selected direction: Candidate B (Hybrid)**

**Adjustments from challenge:**

1. `type` label: removed from required fields and initial label taxonomy. Document as future convention only.
2. Sample issue body must show a label-only issue (no `## WorkTrain` section) as a valid, complete WorkTrain issue.
3. Multi-label conflict resolution: if an issue has multiple maturity labels (e.g. both `worktrain:idea` and `worktrain:ready`), the lowest maturity wins (idea > specced > ready). Must be documented explicitly.
4. `worktrain:blocked` is coordinator-set only. Humans do not set this label. Prevents the coordinator from re-picking up a blocked issue.
5. `upstream_spec` is the only documented optional body field in the initial schema. All other body fields (`type`, `complexity`, `auto_merge`) are excluded until a concrete coordinator use case confirms them.

**Decision criteria satisfied:**

1. Routing is deterministic (labels only, no LLM call) -- Yes
2. One required field maximum (filing cost < 2 minutes) -- Yes: `worktrain` + one maturity label is all that is required
3. Label taxonomy covers full lifecycle without combinatorial explosion -- Yes: 7 labels total
4. upstream_spec expressible and findable at runtime -- Yes: via optional `## WorkTrain` section
5. Schema stable under coordinator evolution -- Yes: routing contract is three label values; body section is optional enrichment

---

## Decision Log

### Selected direction: Candidate B (Hybrid)

**Why B won:** Routing is identical to Candidate A (label-only, no extra API call at dispatch time). B adds a standard machine-readable location (## WorkTrain section in body) for upstream_spec -- a first-class concept in the Three-Workflow Pipeline ADR. The section is optional; issues without an upstream spec omit it.

**Why A lost:** No standard location for upstream_spec. Developers with a spec put the URL in prose where Phase 0.5 must LLM-search for it. The ## WorkTrain section provides a deterministic, parseable location for the coordinator-injection use case.

**Challenges that failed to overturn B:**
1. Section formatting drift -- mitigated by optional nature and single-field simplicity
2. Type is over-required for ready issues -- valid but not blocking; uniform contract simplifies docs
3. Phase 0.5 already finds specs without the section -- resolved by the coordinator-injection use case that needs deterministic extraction

**Accepted tradeoffs:**
- Optional body section adds documentation weight; ~10-15% of issues will use it
- Body content fetched by workflows at runtime, not at routing time

**Identified failure modes:**
- Human omits required label: coordinator logs warning, skips or falls back to full pipeline
- Malformed ## WorkTrain section: Phase 0.5 falls back to format-agnostic search
- upstream_spec is a routing signal (not enrichment): would require schema revision

**Switch trigger:** If coordinator telemetry shows Phase 0.5 reliably finds upstream specs without the section, simplify to Candidate A.

---

## Final Summary

### Recommendation: Candidate B (Hybrid schema)

**Confidence band: high**

**Direction:** GitHub issues in the WorkTrain queue use labels for routing and an optional `## WorkTrain` body section for enrichment. Routing is deterministic (no LLM call). The body section is optional and never a routing gate.

### Minimum viable schema

**Required labels (routing signals):**
- `worktrain` -- marks issue as in the WorkTrain queue
- `worktrain:idea` OR `worktrain:specced` OR `worktrain:ready` -- maturity signal (exactly one required)

**Lifecycle labels (coordinator-managed):**
- `worktrain:in-progress` -- coordinator has dispatched a pipeline
- `worktrain:done` -- pipeline completed successfully
- `worktrain:blocked` -- pipeline failed or requires human attention (coordinator-set only)
- `worktrain:needs-labels` -- required maturity label is missing (coordinator-set; issue is not dispatched)

**Extension label (documented for future use):**
- `worktrain:has-spec` -- an upstream spec exists in the issue body (escape valve if spec presence/absence ever becomes a routing signal)

**Optional body section (enrichment, not routing):**
```markdown
## WorkTrain

upstream_spec: https://docs.example.com/pitch-feature-x
```

The `## WorkTrain` section header is frozen after v1. `upstream_spec` must be a valid http/https URL. Issues without the section are fully valid WorkTrain issues.

### Routing table

| Maturity label | Pipeline |
|----------------|----------|
| `worktrain:idea` | `wr.discovery` -> `wr.shaping` -> `wr.coding-task` |
| `worktrain:specced` | `wr.shaping` -> `wr.coding-task` |
| `worktrain:ready` | `wr.coding-task` (Phase 0.5 searches for upstream spec at runtime) |
| (no maturity label) | Add `worktrain:needs-labels`, skip dispatch, emit structured log entry |

**Multi-label conflict rule:** if multiple maturity labels are present (e.g. both `worktrain:idea` and `worktrain:ready`), the lowest maturity wins (idea > specced > ready). Coordinator logs a warning.

### Coordinator behavior on missing required label

If the maturity label is absent: coordinator adds `worktrain:needs-labels` label to the issue, skips dispatch, and emits a structured log entry. No silent failure. No default routing.

### Sample issue body

```markdown
<!-- A complete WorkTrain issue with only a title and maturity label is valid.
     The ## WorkTrain section below is optional. Use it when you have an external spec URL. -->

Implement rate limiting for the daemon polling scheduler

The scheduler currently has no back-off on API errors. When GitHub returns 429,
the scheduler should implement exponential back-off with a maximum delay of 5 minutes.

## WorkTrain

upstream_spec: https://docs.internal.example.com/specs/daemon-rate-limiting
```

Labels on this issue: `worktrain`, `worktrain:ready`

A label-only version (no body section) is equally valid:
```
Labels: worktrain, worktrain:specced
Body: <prose description only, no ## WorkTrain section>
```

### Residual risks

1. **Coordinator does not yet exist.** The schema is designed before its primary consumer. Maturity values may need more nuance when a real coordinator is built. If a new maturity value is needed (e.g. `groomed`), adding a label is backward-compatible for existing issues.

2. **`worktrain:` namespace is informal.** This design doc is the authoritative registry for `worktrain:` labels. Do not create labels with this prefix for other purposes.

3. **upstream_spec as a routing gate.** If the product team later decides 'ready without an upstream spec => run wr.shaping first', the coordinator must start fetching the body at routing time. The `worktrain:has-spec` label is the escape valve: set it at filing time or by a grooming coordinator, avoiding the body fetch at routing time.

### Switch to Candidate A condition

If coordinator telemetry shows Phase 0.5 reliably finds upstream specs via format-agnostic prose search (i.e. the `## WorkTrain` section is never used), simplify to Candidate A (labels-only): remove the body section from the schema documentation and sample.
