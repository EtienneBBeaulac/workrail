# Living Work Context

## Problem

When a WorkTrain pipeline phase agent -- shaping, coding, or review -- starts a session, it needs to understand what prior phases decided, why they decided it, and what constraints they established for downstream phases. Today it receives almost nothing: the shaping agent gets only a pitch file path, the coding agent gets only a pitch file path, the review agent gets only a PR URL. So the shaping agent re-investigates what discovery already resolved. The coding agent violates constraints shaping already identified as rabbit holes. The review agent flags decisions the coding agent made deliberately as bugs, because it has no context for why those decisions were made. The result is rework, rejected PRs, and re-runs -- waste that compounds across every pipeline run.

## Appetite

L (1-2 weeks).

## Solution

Each phase emits a structured handoff when it completes; the coordinator accumulates those handoffs in a durable per-run file; each subsequent phase receives exactly the context it needs -- no more, no less -- injected at session start.

**Breadboard:**

**Phase Completion → Coordinator Context Store** when agent session ends
- Agent submits: constraints downstream phases must respect, decisions made and why, things explicitly ruled out, acceptance criteria that must be satisfied

**Coordinator Context Store** (PipelineRunContext per-run file)
- Coordinator reads prior phase results before spawning next phase
- Coordinator writes completed phase record after each phase ends
- Coordinator reads quality signal to route (proceed/retry/escalate) without LLM
- Store → Phase Session Start when next phase spawns
- Store → Console Run View (foundation for future operator inspection)

**Phase Session Start → Phase Completion**
- Agent receives prior-phase context targeted to its role: shaping gets discovery constraints; coding additionally gets shaping constraints and rabbit holes; review additionally gets coding decisions and acceptance criteria

**Coordinator Routing → Phase Session Start or Escalation**
- Reads typed quality signal (full structured output / partial notes / nothing) from each phase
- Routes deterministically -- no LLM reasoning

**Elements:**

- **Phase Handoff** [Interface]: When a phase completes, it submits a structured record of what it decided, what constraints apply to downstream phases, what was explicitly ruled out, and what acceptance criteria must be satisfied.
- **Prior Context Injection** [Interface]: When a phase session starts, the agent automatically receives the accumulated decisions and constraints from all prior phases, targeted to what that specific phase needs.
- **No agent behavioral changes** [Interface]: Phase agents only emit a structured record at session end and receive structured context at session start. No changes to how they reason or execute.
- **Context is always targeted, never a full dump** [Invariant]: Shaping receives discovery constraints and rejected directions. Coding additionally receives shaping constraints and rabbit holes. Review additionally receives coding decisions and acceptance criteria. No phase receives context irrelevant to its job.
- **Hard constraints always survive budget trimming** [Invariant]: When context exceeds the injection budget, hard constraints are always included. Orientation aids drop first. Nothing is ever truncated mid-item.
- **Phase quality is machine-readable** [Invariant]: The coordinator knows whether a phase produced full structured output, partial notes, or nothing -- and routes accordingly without asking an LLM.
- **Coordinator routing requires no LLM turns** [Invariant]: Proceed, retry, and escalate decisions read typed signals -- never an LLM prompt.
- **Crash recovery preserves prior phase context** [Invariant]: A restart after a mid-pipeline crash restores prior phase context without re-running earlier phases.
- **Corrections are recorded** [Invariant]: When a fix agent corrects something the coding agent got wrong, the correction (what was believed vs what was actually true) is recorded so the next session starts with accurate context.
- **Not a global memory system** [Exclusion]: Scoped to one pipeline run. Does not accumulate across runs or workspaces.
- **Not a pitch file replacement** [Exclusion]: current-pitch.md continues to exist as the primary human-readable design artifact.
- **No buildSystemPrompt redesign** [Exclusion]: Named semantic slots are a follow-on. This feature uses the existing single-string injection.

## Rabbit Holes

1. **[Critical] New engine contracts must be registered before workflow changes land.** The workflow output contracts (`contractRef: "wr.contracts.shaping_handoff"` and `"wr.contracts.coding_handoff"`) reference engine-registered IDs that don't exist yet. If workflow changes land first, the engine returns `UNKNOWN_CONTRACT_REF` at `complete_step` time, which blocks MCP sessions at the final step of wr.shaping and wr.coding-task. This is the same pattern as `wr.contracts.review_verdict` and `wr.contracts.discovery_handoff`. Mitigation: add the new contracts to `ARTIFACT_CONTRACT_REFS`, implement validators in `artifact-contract-validator.ts`, and add Zod schemas before or in the same PR as the workflow changes.

2. **[Critical] Workflow authoring changes are prerequisites -- silent fallback if missing.** Four workflows (wr.discovery, wr.shaping, wr.coding-task, mr-review) must emit structured handoff artifacts. Any missing update silently falls back to recapMarkdown with no error. Mitigation: ship coordinator and workflow changes together in the same PR, gated by lifecycle integration tests asserting each workflow emits the expected artifact at its final step.

3. **[Critical] buildContextSummary() selection logic is silent when wrong.** Which fields go to which target phase is the key correctness surface. Wrong selections produce no type error -- agents receive irrelevant context or miss constraints. Mitigation: per-phase unit tests asserting specific field presence and absence, plus a priority-ordered trimming invariant (complete section or omit, never truncate mid-item).

4. **[Medium] PhaseResult<T> Zod serialization is complex.** Implementing a generic Zod schema directly is error-prone. Mitigation: implement concrete per-phase Zod schemas (DiscoveryPhaseRecordSchema etc.) that instantiate the generic rather than expressing it generically in Zod.

5. **[Low] PipelineRunContext files will create console visualization expectations.** Mitigation: name console display explicitly as a follow-on; the file structure is designed to support it.

## No-Gos

- No redesign of buildSystemPrompt() -- named semantic slots are a follow-on
- No cross-run context accumulation -- scoped to one pipeline run only
- No coordinator retry logic -- PhaseResult.kind enables retry but policy is a separate feature
- No epic-mode task graph -- PipelineRunContext.phases remains linear
- No console visualization of inter-phase context flow -- foundation only
- No changes to agent reasoning or internal behavior
- No extensible contract registration mechanism -- contracts added to engine registry directly, same pattern as review_verdict and discovery_handoff (extensible registration is a separate backlog item)
