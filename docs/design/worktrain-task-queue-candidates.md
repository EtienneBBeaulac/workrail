# WorkTrain Task Queue: Design Candidates

_Raw investigative material for main agent synthesis. Not a final decision._

---

## Problem Understanding

### Core Tensions

**T1: Type safety vs. GitHub's stringly-typed surface**
The repo philosophy requires discriminated unions and exhaustive switches. GitHub issues are strings all the way down -- labels are strings, body is a string. The coordinator must parse and validate at the boundary, then work with typed values internally. The schema defines the valid value set (closed enum), not GitHub's type system.

**T2: Minimum required fields vs. routing ambiguity**
YAGNI says avoid speculative fields. But if the minimum schema (maturity only) is ambiguous in even one routing case (ready bug vs ready feature), it fails the primary success criterion. Adding `type` as a second required label resolves the ambiguity without speculative over-engineering.

**T3: Labels as transport vs. labels as schema**
Labels are the most natural routing mechanism (existing labelFilter infrastructure). But they can only carry enumerated values -- no URLs, no file paths. The schema needs two layers: labels for routing (read at dispatch time by coordinator) and body for enrichment (read at runtime by workflows). These are different contracts for different consumers.

**T4: Schema stability vs. coordinator evolution**
If the schema over-specifies coordinator behavior (e.g. `auto_merge: true` requires the coordinator to implement auto-merge), the schema becomes a coordinator implementation spec. The schema must define only issue observable properties, not coordinator behavior.

### The Real Seam

The seam is at the coordinator, not the trigger. The trigger dispatches "there is a worktrain issue." The coordinator reads the issue, parses maturity+type from labels, and decides the pipeline. The schema is a contract between the issue and the coordinator's parser -- not between the issue and the trigger.

### What Makes This Hard

The transport gap: the github poller does not fetch body content. All routing-time signals must come from labels. Body content requires a separate API call. This means the schema has two separate concerns:
1. Routing labels -- read by the coordinator at dispatch time, free from labels
2. Enrichment fields -- read by workflows at runtime, require a body fetch

A junior developer would treat these as one schema and put everything in labels or everything in the body. The right design separates them explicitly with different consumer contracts.

---

## Philosophy Constraints

From CLAUDE.md and observed repo patterns:
- **Exhaustiveness everywhere** -- maturity and type values must be closed enums; coordinator switch must be exhaustive
- **Make illegal states unrepresentable** -- validate maturity/type at the coordinator boundary; invalid values are routing errors, not silently ignored
- **YAGNI with discipline** -- only include fields the routing decision actually needs; no speculative coordinator fields
- **Validate at boundaries, trust inside** -- coordinator parses GitHub labels into typed values at entry; internal routing logic works with typed domain values
- **Immutability by default** -- routing table is a pure function of maturity+type; no mutable routing state

No conflicts between stated philosophy and observed patterns.

---

## Impact Surface

If the schema changes after coordinator implementation:
- `src/coordinators/pr-review.ts` pattern: the new issue coordinator will follow the same `CoordinatorDeps` injection pattern
- `src/trigger/adapters/github-poller.ts`: `GitHubIssue.labels` field is the only routing input at dispatch time; schema change must not require body fetch at routing time
- `src/trigger/types.ts` `GitHubPollingSource.labelFilter`: the label filter used in `triggers.yml` must match whatever label the coordinator uses to identify queue items
- `triggers.yml`: will need a new entry for the worktrain issue coordinator workflow

Nearby contracts that must stay consistent:
- The `worktrain` label is the queue membership signal -- must not be confused with lifecycle labels (`worktrain:in-progress`, `worktrain:done`)
- `maturity` label values must match the `taskMaturity` values in backlog.md (idea / rough / specced / ready) -- the coordinator bridges these two vocabularies

---

## Candidates

### Candidate A: Labels-only, maturity + type (minimum viable routing)

**Summary:** Three required labels (`worktrain` + `worktrain:maturity:<value>` + `worktrain:type:<value>`); all routing signals live in labels; body is free-form prose only; no body parsing at any point.

**Required labels:**
- `worktrain` -- marks issue as in the queue
- `worktrain:maturity:idea | rough | specced | ready` (closed enum)
- `worktrain:type:feature | bug | chore | refactor` (closed enum)

**Optional labels:**
- `worktrain:complexity:small | medium | large`
- `worktrain:auto-merge` (presence = true)

**Routing table (exhaustive):**
```
maturity=idea | rough    =>  wr.discovery -> wr.shaping -> wr.coding-task
maturity=specced         =>  wr.discovery -> wr.coding-task
maturity=ready           =>  wr.coding-task (Phase 0.5 searches for upstream spec at runtime)
```

Type refines within the coding workflow (bug => skip hypothesis, chore => skip design phases) but does not change pipeline selection.

**Tensions resolved:** T1 (labels are closed enums, coordinator validates at boundary), T2 (maturity+type removes ambiguity), T4 (schema carries no coordinator behavior)
**Tensions accepted:** T3 (no enrichment path for upstream_spec URL -- body is unstructured prose)

**Boundary solved at:** Labels only. Coordinator never touches body.

**Why this boundary:** Zero extra API calls at routing time. `github_issues_poll` already delivers labels in the GitHubIssue object. Coordinator can route synchronously from dispatch payload.

**Failure mode:** Human omits required label (no maturity or no type). Coordinator detects missing label, logs warning, skips issue or routes conservatively to full pipeline. Not a hard failure.

**Repo-pattern relationship:** Follows GitHubPollingSource.labelFilter + notLabels, discriminated union pattern from ReviewSeverity and PollingSource.

**Gains:** Minimum filing friction, zero extra API call, cleanest routing logic.
**Losses:** No standard location for upstream spec URL. Developers put it in prose body where it is machine-invisible unless Phase 0.5 finds it by search.

**Scope judgment:** Best-fit for MVP. Routing is correct and deterministic. Enrichment gap is real but manageable.

**Philosophy fit:** Honors YAGNI, validate-at-boundary, exhaustiveness, immutability. No conflicts.

---

### Candidate B: Hybrid -- labels for routing, structured body section for enrichment

**Summary:** Same three required labels as A for routing; an optional `## WorkTrain` key-value section in the issue body carries enrichment fields consumed lazily at runtime by workflows (not by the coordinator at routing time).

**Required labels (routing, same as A):**
- `worktrain`
- `worktrain:maturity:idea | rough | specced | ready`
- `worktrain:type:feature | bug | chore | refactor`

**Optional body section (enrichment, read at runtime by downstream workflows):**
```markdown
## WorkTrain
upstream_spec: https://docs.example.com/pitch-feature-x
affected_files: src/foo.ts src/bar.ts
```

**Routing mechanism:** Identical to A -- coordinator uses labels only. Body section is not read at routing time. Downstream workflows (wr.coding-task Phase 0.5, wr.shaping) call GitHub API to fetch body and parse the `## WorkTrain` section when they need enrichment.

**Tensions resolved:** T1, T2, T3 (two-layer schema: labels for routing, body for enrichment), T4
**Tensions accepted:** None materially -- the body section is optional and gracefully absent

**Boundary solved at:** Labels for routing contract, body for workflow enrichment contract. Two separate consumers, two separate read times.

**Why this boundary:** Keeps routing fast (no extra API call), provides a standard machine-readable location for upstream_spec, and stays within GitHub without external tools.

**Failure mode:** Malformed `## WorkTrain` section (typo in key name, missing value). Workflows fall back to Phase 0.5's format-agnostic search. Graceful degradation, not a routing failure.

**Repo-pattern relationship:** Labels routing follows existing pattern. Body section is a new convention -- no repo precedent, but consistent with the "validate at boundaries" principle (workflow parses at its own entry).

**Gains:** Routing as fast as A. Standard location for upstream_spec. Compatible with future grooming coordinator that sets enrichment fields automatically.

**Losses:** Small added ceremony (optional body section). Developers must know the section exists to use it. Slightly more complex documentation.

**Scope judgment:** Best-fit. The added body section has minimal cost and real benefit for the ~30% of issues that have upstream specs.

**Philosophy fit:** Honors YAGNI (section is optional), validate-at-boundary (each consumer validates its own inputs), exhaustiveness (routing is still label-driven). No conflicts.

---

### Candidate C: YAML frontmatter in body -- all metadata centralized

**Summary:** Issue body starts with a YAML frontmatter block containing all metadata including routing signals; labels used only for lifecycle state.

**Frontmatter (required fields: maturity, type):**
```yaml
---
maturity: specced
type: feature
complexity: medium
auto_merge: false
upstream_spec: https://...
affected_files:
  - src/foo.ts
  - src/bar.ts
---
```

**Lifecycle labels only:**
- `worktrain` (queue membership)
- `worktrain:in-progress` (being worked)
- `worktrain:done` (completed)

**Routing mechanism:** Coordinator calls `GET /repos/:owner/:repo/issues/:number` for every issue, parses YAML frontmatter, extracts maturity+type for pipeline selection.

**Tensions resolved:** T3 (single schema location), all metadata in one place
**Tensions accepted:** T2 (higher filing friction -- YAML format unfamiliar to most developers), routing-time API call adds latency

**Boundary solved at:** Body only.

**Failure mode (HIGH SEVERITY):** (1) Malformed YAML blocks routing entirely for that issue. (2) `labelFilter` cannot filter by maturity -- ALL worktrain issues are dispatched to the coordinator, even unready ones. (3) Mandatory body API call adds 1 HTTP round-trip per issue per poll cycle.

**Repo-pattern relationship:** Departs from existing labelFilter pattern. Does not follow the label-driven routing used by other trigger configurations.

**Gains:** Single source of truth for all metadata. No label taxonomy to maintain.
**Losses:** YAML is unusual in GitHub issues. Parse failures block routing. API call required always. `labelFilter` loses routing power.

**Scope judgment:** Too broad. Adds body-parsing requirement for ALL issues even when enrichment is not needed (bugs, chores).

**Philosophy fit:** Conflicts with YAGNI (always fetches body even for simple routing), validate-at-boundary (harder to validate YAML string than label enum), determinism (malformed YAML = routing failure).

---

### Candidate D: Three-trigger architecture (routing as trigger configuration)

**Summary:** Instead of a coordinator that routes, create three triggers with different `labelFilter` values -- one per pipeline path. Routing is implicit in which trigger fires.

**Proposed triggers:**
- `worktrain-coding` trigger: labelFilter=`worktrain:maturity:ready` => `wr.coding-task`
- `worktrain-discovery` trigger: labelFilter=`worktrain:maturity:specced` => `wr.discovery`
- `worktrain-full` trigger: labelFilter=`worktrain:maturity:idea` => `wr.discovery` (with full-pipeline flag)

**CRITICAL DEFECT:** GitHub's Issues API `labels=` parameter matches issues with ANY of the listed labels (OR semantics), not ALL (AND semantics). A trigger with `labelFilter: 'worktrain:maturity:ready'` would only work if `worktrain:maturity:ready` is the ONLY label filter. Confirmed from `github-poller.ts`: the `labels=` parameter is passed directly to the GitHub API without client-side AND enforcement. This means a `worktrain:maturity:idea` issue would also be dispatched by the `worktrain-coding` trigger if it happens to be in the same poll batch, because the API returns all issues with ANY matching label.

**Note:** This defect is architectural, not fixable by schema changes. The three-trigger approach is included as a reframe candidate to illustrate what would be needed if GitHub supported AND label filters (it does not).

**Tensions resolved:** T4 (routing logic in config, not code)
**Tensions accepted:** T1, T2 -- broken by GitHub API semantics

**Scope judgment:** Broken. Included to surface the reframe, not as a viable candidate.

---

## Comparison and Recommendation

### Matrix

| | A: Labels-only | B: Hybrid | C: Frontmatter | D: Three-trigger |
|---|---|---|---|---|
| Routing at dispatch time, no body fetch | Yes | Yes | No | Yes |
| Handles upstream_spec | No | Yes | Yes | No |
| Filing friction | Low | Low-medium | High | Low |
| Failure mode severity | Low | Low | High | Critical (broken) |
| Follows repo patterns | Yes | Yes+new | No | Broken |
| YAGNI | Best | Good | Poor | N/A |
| Schema stability | Best | Good | Poor | N/A |

### Recommendation: Candidate B (Hybrid)

A is minimal and correct for routing. B is everything A is, plus a standard location for `upstream_spec`. The cost is an optional body section that ~70-80% of issues won't use. But the benefit -- a machine-readable upstream spec location for the ~20-30% that have one -- is real and immediate (Phase 0.5 of the coding workflow already consumes it).

The routing path in B is identical to A: label-only, no body fetch, fast. The body section is consumed lazily by downstream workflows, not by the routing coordinator. This keeps the two contracts separate and the routing cost identical to A.

---

## Self-Critique

**Strongest counter-argument against B:** Most issues (bugs, chores, rough ideas) will never have a `## WorkTrain` section. Defining a convention that 80% of issues ignore adds documentation weight without value to those issues. A is simpler to explain and equally correct.

**Narrower option (A) that lost:** A loses because `upstream_spec` is a first-class concept in the Three-Workflow Pipeline ADR and Phase 0.5 of the coding workflow. Omitting a standard location forces developers to put it in prose where it may or may not be found by the workflow's format-agnostic search. The cost of defining the optional section is documentation-only; the cost of omitting it is that Phase 0.5's search quality degrades on issues that have specs.

**Pivot condition:** If the coordinator is built and `upstream_spec` is consistently found by Phase 0.5's format-agnostic search regardless of body format (i.e. developers naturally put the URL in the issue title or first paragraph), then the `## WorkTrain` section can be removed from the schema. A becomes correct. This is an empirical question that can only be answered after some usage.

**Assumption that if wrong would invalidate B:** `upstream_spec` is optional enrichment, not a routing gate. If the coordinator needs to know whether an upstream spec exists BEFORE selecting a pipeline (e.g. `maturity=ready + no upstream spec => run wr.discovery first`), then the body must be fetched at routing time and B's routing-vs-enrichment split breaks. Current evidence (Phase 0.5 runs inside the coding workflow, after pipeline selection) suggests this is not the case.

---

## Open Questions for Main Agent

1. Should `type` be required or optional? If all `ready` issues always go to coding-only regardless of type, then type is optional enrichment. If type affects which phases run inside the coding workflow (e.g. `bug` skips hypothesis), is that different enough to be optional?

2. What is the lifecycle label model? When the coordinator picks up an issue, what label does it add (in-progress)? When the workflow completes, what label? Is `worktrain:done` added to the issue, or is the issue closed?

3. Backlog promotion: does the coordinator automatically add `worktrain:maturity:ready` to a `worktrain:maturity:specced` issue after running `wr.discovery`? Or is promotion always manual?

4. Should `complexity` be a routing signal or just workflow enrichment? If `complexity:small` maps to a QUICK rigor path inside the coding workflow, it affects workflow behavior but not pipeline selection -- which makes it optional enrichment, not a required routing label.
