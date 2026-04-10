# Workflow Authoring Guide (v2)

WorkRail v2 authoring is **JSON-first** and is designed for **determinism**, **rewind-safety**, and **resumability**.

> **Status:** v2 authoring is design-locked but not necessarily shipped yet. This doc is a v2-only entry point.

## Canonical references (v2)

- **Authoring model + JSON examples:** `docs/design/workflow-authoring-v2.md`
- **Execution contract (token-based):** `docs/reference/workflow-execution-contract.md`
- **Core design locks (anti-drift):** `docs/design/v2-core-design-locks.md`

## v2 authoring principles (high level)

### Structured freedom over rigid scripts

WorkRail workflows should constrain **outcomes and invariants**, not micromanage cognition.

Material branching, pathing, loop continuation, and gating should live in the workflow/engine as declarative control flow whenever possible, not in implicit agent judgment hidden inside prompt prose.

Authors should aim for:

- **rigid on invariants**: required outputs, loop decisions, confidence disclosure, blocked vs never-stop behavior, final handoff structure
- **semi-structured on heuristics**: routing matrices, severity guidance, confidence combination rules, artifact vs context split
- **adaptive on reasoning**: exploration order, clue prioritization, synthesis, finding phrasing, and unusual-case handling

The goal is **structured freedom**:

- not "trust the model" vagueness
- not bureaucratic form-filling

The agent should usually determine and record the route-driving facts. The engine should usually decide what node, branch, or loop state comes next.

Prefer asking:

- what must be known before leaving this phase?
- what must be disclosed if it is not known?

over prescribing the exact internal thought sequence the agent must follow.

### Never-stop by default for enrichment and confidence gaps

For most workflows, missing enrichment sources or weak confidence should **degrade and disclose**, not block.

Typical examples:

- preferred capability unavailable
- missing ticket or supporting docs
- weak boundary confidence
- incomplete policy/context discovery

Blocking should be reserved for cases where:

- the review/task target is not meaningfully available
- a truly required capability is unavailable
- a required output contract is missing in blocking modes

### Confidence is multi-dimensional

Avoid a single vague "confidence" concept when different uncertainty sources matter differently.

Reusable confidence dimensions often include:

- boundary confidence
- context / intent confidence
- policy-context confidence
- evidence confidence
- validation confidence

Authors should explicitly decide:

- which confidence dimensions matter for this workflow
- which ones cap final conclusions
- which ones trigger follow-up loops versus just downgrade the final handoff

### Use structure only when it earns its place

A matrix, field, ledger, or classification should exist only if it does at least one of these:

- prevents a real recurring failure mode
- improves deterministic control flow or resumability
- improves user-visible honesty / explainability
- materially changes routing or rigor

If it does none of those, it should be removed or downgraded to advisory guidance.

Practical example:

- a `boundaryConfidence` field earns its place because it can cap conclusions and trigger follow-up
- a five-level taxonomy that never changes routing probably does not

### Anti-lazy wording

Structured freedom should not become vague permission for shallow work.

Be careful with wording like:

- `if appropriate`
- `minimal pass`
- `light scan`
- `you may`
- `smallest`
- `cheapest`

These phrases are often useful, but they should usually be paired with a clear floor for what still must be achieved.

Prefer wording like:

- "do the lightest pass that still surfaces the main approaches, hard constraints, and obvious contradictions"
- "if you do not delegate, record why solo execution is enough"
- "generate enough distinct options to support a real choice"

The goal is freedom in method, not softness in rigor.

### User-voice prose is a real option

For bundled and user-facing workflows, authors should consider prose that often sounds like the user is directly instructing the agent.

This is often better than detached framework narration for exploratory, advisory, or design-heavy workflows because it:

- keeps the workflow grounded in user intent
- reduces internal-boilerplate tone
- makes the workflow feel more like an expression of the user's will

Neutral/system-style prose is still appropriate for internal, infrastructural, or highly mechanical workflows. Choose deliberately.

### Auditor-first delegation is often the better default

When using subagents or routines, prefer bounded **audits** of the main agent's work over delegating broad task ownership.

Good auditor uses:

- context completeness audit
- depth audit
- adversarial challenge
- philosophy alignment review
- final verification

Executor-style delegation still makes sense for bounded independent work, but the parent workflow should usually remain the canonical synthesizer and decision-maker.

### JSON-first authoring

WorkRail v2 uses **JSON** as the canonical authoring format. DSL and YAML remain possible future input formats, but for v2 we optimize for determinism and straightforward validation.

Workflows are hashed based on their **compiled canonical model** (after templates/features/contracts are expanded), not raw text, so the hash remains stable and deterministic.

### Authoring primitives (v2)

WorkRail v2 introduces several primitives for expressive workflows:

- **Capabilities** (workflow-global): declare optional agent capabilities like `delegation` or `web_browsing` (required/preferred).
- **Features** (compiler middleware): mostly toggle IDs; a small subset supports typed config objects (`{id, config}`).
- **Templates**: reusable step sequences, called explicitly via `type: "template_call"`.
- **Contract packs**: WorkRail-owned output schemas for structured artifacts (e.g., `wr.contracts.capability_observation`).
- **PromptBlocks** (optional): structure step prompts as blocks (goal/constraints/procedure/outputRequired/verify) which compile to deterministic text.
- **AgentRole**: workflow and/or step-level stance/persona (not system prompt control).
- **Extension points**: named slots declared with `extensionPoints` and referenced via `{{wr.bindings.slotId}}` tokens; resolved at compile time from project `.workrail/bindings.json` overrides or workflow defaults. Enables project-overridable delegation seams without forking workflow JSON.
- **References**: workflow-declared pointers to external documents (schemas, specs, guides). Resolved at start time, delivered as a separate MCP content item. The agent reads the files itself if needed. See "Workflow references" section below.
- **Assessments**: workflow-declared assessment shapes (`assessments`) that steps can reference with one or more `assessmentRefs` and, in v1, use for one exact-match `require_followup` consequence via `assessmentConsequences` (fires if any dimension across any referenced assessment equals the trigger level).

For detailed JSON syntax and examples, see: `docs/design/workflow-authoring-v2.md`.

### Choosing the right authoring mechanism

Use different primitives for different jobs. A good rule of thumb is:

- **Different flow** → use `runCondition`
- **Same flow, different wording** → use `promptFragments`

| Mechanism | What it does | When it applies | Best for |
|---|---|---|---|
| **`features`** | Inject reusable guidance into `promptBlocks` sections | **Compile time** | Cross-cutting rules like memory or subagent discipline |
| **`promptFragments`** | Add small conditional prompt text to an existing step | **Render/runtime** | Context-sensitive nudges without branching the DAG |
| **`templateCall`** | Insert reusable step structure or step sequences inline | **Compile time** | Reusing standard routines or audits as first-class parent steps |
| **`extensionPoints`** | Resolve overridable bound routine/workflow IDs in prompt text | **Compile time** | Swapping delegated bounded seams without forking |
| **`runCondition`** | Decide whether a step runs | **Runtime** | Real branching, pathing, or routing |

Use these as the default choice rules:

- **Use `runCondition`** when the workflow should actually take a different path.
- **Use `promptFragments`** when the step stays the same but needs small context-sensitive additions.
- **Use `templateCall`** when you want reusable standard structure or routine injection.
- **Use `extensionPoints`** when you want a project-overridable delegated seam, not inline structure.
- **Use `features`** for workflow-wide repeated guidance.

#### References are for execution-time companion material, not authoring provenance

Use workflow `references` sparingly.

- **Good use**: documents the running workflow may genuinely need while doing its job, such as a shipped rubric, a target-system spec, or a project policy document.
- **Bad use**: authoring-only material about how the workflow was designed, including the workflow schema, authoring spec, or maintainer provenance, unless the workflow is itself about authoring or validating workflows.

Practical test:

- If the reference helps the agent perform the workflow's **runtime task**, keep it.
- If it only helps a maintainer justify or inspect the workflow's design, remove it from normal execution workflows.

#### Strong default: inject first, override only when delegation is intentional

When choosing between `templateCall` and `extensionPoints`, prefer this rule:

- **If the routine should be part of the parent workflow's visible step structure, use `templateCall`.**
- **If the routine should remain an opaque bounded implementation that the parent may delegate to, use delegation.**
- **If that delegated seam should be customizable per project, wrap that delegation seam in `extensionPoints`.**

Do **not** use `extensionPoints` as a generic substitute for routine injection.

Important implementation detail:

- `templateCall` expands routines into real steps during the compiler's template pass.
- `{{wr.bindings.*}}` tokens are resolved later, during binding resolution.
- Therefore, **extension points cannot currently choose which routine gets injected by a `templateCall`**.

### Baseline (Tier 0): notes-first

- **You can write workflows with no special authoring features.**
- The default durable output is a short recap in `output.notesMarkdown` (recorded by the agent when advancing or checkpointing).
- Structured artifacts are **optional** and must never be required for a workflow to be usable.

### Assessment-gate authoring (v1)

Assessment gates are now a shipped authoring/runtime feature, but the first slice is intentionally narrow.

Use them when:

- the workflow needs the agent to submit a bounded judgment explicitly
- that judgment should be durably recorded
- one specific result should keep the same step pending and require follow-up before retry

The v1 shape is:

- declare one or more workflow-level assessments in `assessments`
- reference them from a step with one or more `assessmentRefs` entries
- optionally declare one step-level `assessmentConsequences` rule
- if any dimension across any referenced assessment matches that rule, the engine returns a retryable same-step follow-up block

Important limits in v1:

- at least one `assessmentRefs` entry when `assessmentConsequences` is present; multiple refs are supported
- at most one `assessmentConsequences` entry per step
- one supported effect only: `require_followup`
- exact-match trigger only: one declared dimension equals one declared canonical level

Keep the responsibility split clean:

- **assessment definition** = reusable vocabulary (`dimensions`, allowed `levels`, purpose)
- **step usage** = local execution behavior (`assessmentRefs`, `assessmentConsequences`)

Do not put execution-policy meaning into the assessment definition itself.

Practical guidance:

- use assessments for **bounded judgment**, not generic scoring
- keep dimensions small and semantically meaningful
- use canonical level names authors and agents can understand easily
- write follow-up guidance as **same-step retry guidance**, not as a subflow or rewind instruction
- prefer one strong follow-up trigger over multiple weak ones

**Dimension design: orthogonality matters**

The value of multi-dimensional assessments is that each dimension independently blocks advancement for a different reason. A dimension that restates existing workflow state adds ceremony without structure.

Good dimensions are:
- **Orthogonal**: each captures a distinct failure mode the others don't catch
- **Independently checkable**: a `low` rating on one dimension alone justifies follow-up, regardless of the others
- **Specific**: about a concrete, observable thing -- not "is the overall result good"

Bad dimensions:
- A single `confidence` dimension that mirrors the workflow's existing `recommendationConfidenceBand` -- it just restates what the workflow already knows
- Multiple dimensions that all reduce to the same question phrased differently
- Dimensions so correlated that one being low always implies the others are low too

Example of orthogonal dimensions for an MR review handoff:
- `evidence_quality` -- are findings grounded in specific code locations? (catches: weak analysis)
- `coverage_completeness` -- are all relevant domains checked? (catches: blind spots)
- `contradiction_resolution` -- are competing interpretations resolved? (catches: premature synthesis)

Each catches a distinct failure mode. A review can have strong evidence but miss whole domains, or have good coverage with unresolved contradictions.

**Consequence trigger**: use `anyEqualsLevel` to specify which level should block. WorkRail checks all submitted dimensions and fires the consequence if any of them equals that level. For single-dimension assessments this works the same as an exact match.

```json
{
  "when": { "anyEqualsLevel": "low" },
  "effect": { "kind": "require_followup", "guidance": "..." }
}
```

**V1 limit**: at most one consequence per step.

Good fit:

- "Before handing off, assess whether the diagnosis is ready -- coverage is complete, evidence is grounded, and contradictions are resolved."
- "If evidence quality is low, require follow-up to anchor findings to specific code before retry."

Bad fit:

- generic five-level scores that never affect workflow behavior
- a single `confidence` dimension that mirrors a confidence band the workflow already tracks
- multiple interacting rule chains that really want a policy DSL
- subflow-style recovery sequences masquerading as a single follow-up consequence

### Rigor vs rigidity

Workflows should provide a **strong skeleton, not a straitjacket**.

- Be strict about the things that protect quality:
  - required outcomes
  - important decision points
  - evidence and uncertainty accounting
  - final validation or challenge passes
- Be flexible about the things LLMs are good at:
  - synthesis order
  - framing moves
  - idea generation
  - creative problem decomposition

Author for **what must be accomplished**, not for an exact internal choreography of thought.

### Anti-lazy wording

Adaptive workflows should leave room for judgment without creating easy escape hatches.

Be careful with wording like:

- `if appropriate`
- `minimal pass`
- `light scan`
- `you may`
- `smallest`
- `cheapest`

These phrases are often useful, but they become lazy when they are not paired with a quality floor.

Prefer wording like:

- "do the lightest pass that still surfaces the main approaches, hard constraints, and obvious contradictions"
- "choose the lighter path only if it still answers the real question"
- "if you do not delegate, record why solo execution is enough"

Good adaptive wording gives the agent freedom in method while still requiring it to **earn confidence**.

### User-voice prose

For bundled and user-facing workflows, prefer prose that often feels like **the user is directly instructing the agent**.

This usually works better than detached author or framework narration because it:

- keeps the workflow grounded in user intent
- makes prompts feel less like internal boilerplate
- encourages the agent to treat the workflow as an expression of the user's will

Neutral/system-style prose is still fine for internal or infrastructural workflows, but user-facing flows generally benefit from a clearer user voice.

### Builtins (no user-defined plugins)

WorkRail v2 provides **built-in** building blocks that workflows (including external workflows) can reference:

- **Templates**: pre-built steps (or step sequences) authors can “call” to speed up authoring and ensure consistency.
- **Features**: deterministic, closed-set “middleware” applied by WorkRail (e.g., tier-aware instructions, formatting, durable recap guidance).
- **Contract packs**: server-side definitions for allowed artifact kinds and small examples (no schema authoring required by workflow authors).

External workflows can reference these builtins, but cannot define arbitrary new plugin code.

### Where injections happen: templates as anchors

When something needs to be injected at a specific point (“run an audit here”, “insert a standard gate here”), **template references are the primary anchor**:

- Explicit at the callsite (less hidden magic).
- Deterministic and debuggable.
- Avoids tag-taxonomy sprawl.

If what you want is **team-overridable delegation**, use `extensionPoints` instead — but treat that as a different mechanism with different runtime behavior, not another form of injection.

Tags can still exist as optional **classification** metadata (for UI organization and search), but should not be the primary injection mechanism.

### Response supplements for start/resume-only instructions

Some instructions should **not** be mixed into the workflow-authored step prompt:

- short onboarding guidance
- authority/provenance framing for the WorkRail channel
- logistics that should appear only at workflow start or when resuming

For these, use **response supplements** at the MCP response boundary rather than editing workflow JSON prompts directly.

Current implementation lives in `src/mcp/response-supplements.ts`.

#### When to use a response supplement

Use a response supplement when all of the following are true:

- the instruction is **system-owned** or delivery-owned, not part of the workflow author's actual step text
- it should be shown only for specific lifecycle moments like **`start`** or **`rehydrate`**
- it should remain **structurally separate** from the main step prompt so agents do not confuse it with the user's core instruction

Do **not** use a response supplement for:

- normal step instructions that belong in the workflow prompt
- durable session state
- anything that must be remembered as part of the workflow's semantic execution state

#### Delivery modes

Response supplements support two delivery modes:

- **`per_lifecycle`**: emit on every eligible lifecycle (for example, every `rehydrate`)
- **`once_per_session`**: emit only on one designated lifecycle (for example, `start`) without persisting delivery state

In the current design, `once_per_session` is a **policy-level one-time instruction**, not a durable delivery record. It means:

- choose the single lifecycle where the supplement should appear
- render it there deterministically
- do **not** store "shown/not shown" in session state unless exact delivery history becomes a real execution requirement

This keeps presentation policy out of durable workflow state.

#### How to add a one-time instruction

1. Add a new supplement entry in `src/mcp/response-supplements.ts`
2. Give it a stable `kind` and explicit `order`
3. Choose the eligible `lifecycles`
4. Set `delivery` to:
   - `{ mode: 'per_lifecycle' }`, or
   - `{ mode: 'once_per_session', emitOn: '<lifecycle>' }`
5. Keep the text:
   - short
   - system-owned
   - clearly separate from the main authored prompt
6. Add or update:
   - unit tests in `tests/unit/mcp/response-supplements.test.ts`
   - integration tests if MCP boundary behavior matters

#### Authoring rule of thumb

Use the **workflow prompt** for what the user wants done.

Use a **response supplement** for small, boundary-owned instructions about how WorkRail should frame or deliver that step to the agent.

### Workflow references

Workflows can declare pointers to external documents that the agent should be aware of during execution. Unlike `metaGuidance` (short behavioral rules surfaced on start and resume), references point at external files without inlining their content.

```jsonc
"references": [
  {
    "id": "api-schema",
    "title": "API Schema",
    "source": "./spec/api-schema.json",
    "purpose": "Canonical API contract",
    "authoritative": true
  }
]
```

- **Delivered automatically** as a separate MCP content item on `start` (full details) and `rehydrate` (compact reminder). Not on `advance`.
- **Pointer-only**: WorkRail validates the path exists at start time but does not inline the file content. The agent reads files itself.
- **Surfaced in `inspect_workflow`** for discoverability before starting.
- **Included in `workflowHash`**: reference declarations (not file contents) are part of the hash.

For JSON syntax details, see: `docs/design/workflow-authoring-v2.md` → "References" section.

### Step identity and provenance

To keep authoring simple:

- Author step IDs remain the primary, stable identifiers (what agents see as `pending.stepId`).
- Template-expanded/internal step IDs are **reserved/internal** and carry provenance (what injected them, where, and why).
- By default, injected steps should be **collapsed** for agent UX; provenance exists for debugging/auditing and advanced views.

### Versioning and determinism

- The canonical pin is a **content hash** of the **fully expanded compiled workflow** (including template expansions, feature application, and contract pack selection), not a human-maintained `version` string.
- Human `version` fields may exist as labels, but should not be the source of truth for determinism.

### Workflow staleness

Workflows can drift out of sync with the authoring spec they were written against. WorkRail surfaces this as a `staleness` signal in `list_workflows` and `inspect_workflow` output.

**How it works:** Workflows carry an optional `validatedAgainstSpecVersion` field stamped by `workflow-for-workflows` after the quality gate passes. The engine compares this against the current `spec/authoring-spec.json` version at list/inspect time and returns:

- `none` — workflow was validated against the current spec version
- `likely` — spec was updated since the workflow was last reviewed
- `possible` — workflow has never been run through `workflow-for-workflows`

**Stamping a workflow:**

```bash
npm run stamp-workflow -- workflows/my-workflow.json
git add workflows/my-workflow.json && git commit -m "chore: stamp workflow"
```

The stamp must be committed to take effect. The `workflow-for-workflows` Phase 7 step includes a reminder to do this.

**Visibility:** By default, the staleness signal is only shown for user-owned/imported workflows (`personal`, `rooted_sharing`, `external`). Built-in and legacy_project workflows are excluded. Set `WORKRAIL_DEV=1` to see staleness for all categories (useful for catalog maintenance).

**In `validate:registry`:** The validator prints a non-blocking advisory listing unstamped and outdated workflows after each run. This is always visible regardless of the dev flag.

### Debugging and auditing

WorkRail v2 treats debugging/auditing as first-class:

- WorkRail should record a bounded “decision trace” (why a step was selected/skipped, loop decisions, fork detection) as durable data.
- Dashboards and exports can surface this trace for post-mortems without requiring the agent to carry debugging internals in chat.
- “Cognitive audits” (subagent auditor model) are supported via built-in templates/features, not bespoke author boilerplate.

### Forced self-audit over self-reported confidence

Agents will often take the easy way out:

- assume they already have enough context
- assume they already understand the boundary
- skip challenge or audit because it "probably isn't needed"

So when a workflow needs an honest self-check, do **not** rely on vibes-only fields like:

- `stillFuzzy = true|false`
- `contextAuditNeeded = true|false`
- optional challenge wording with no rubric or trigger

Prefer patterns that force the agent to confront uncertainty:

- score concrete dimensions instead of reporting confidence directly
- require a short evidence statement for each score
- derive the next action from the rubric or trigger rules

The workflow should prove to the agent that it may not know enough yet, instead of asking the agent whether it feels confident.
