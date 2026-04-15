# WorkRail User Interaction Model -- Design Candidates

> **Note:** This document is investigative material for the `wr.discovery` workflow, not a final decision document. It describes candidate answer framings for a landscape investigation, not design proposals for code changes.

---

## Problem Understanding

### Core Tensions

1. **Agent as proxy vs human as actor** -- WorkRail receives `goal` from the agent, not from the human directly. The agent translates human intent into a string. WorkRail validates the string (`z.string().min(1)`) but cannot validate fidelity to human intent.

2. **Real-time console vs eventually consistent events** -- The console reconstructs session state from an append-only event log (domain event sourcing). The human always sees a projection of past events, not instantaneous state. SSE and 5s polling minimize lag but cannot eliminate it.

3. **Completeness of investigation vs sufficient accuracy** -- `src/cli/` was not examined. The original questions are fully answered without it. The tension is between exhaustive audit and good-enough accuracy for the stated goal.

### Likely Seam

The real seam between human and WorkRail is the **natural language prompt** the user gives their agent. WorkRail's system boundary is at the `start_workflow` MCP tool call. The human->agent interaction is outside WorkRail's model entirely.

### What Makes This Hard to Understand

New contributors expect dashboards to be launchers. The `FullEmptyState` component in `WorkspaceView.tsx` (which tells users to prompt their agent instead of clicking) is the subtle signal that corrects this expectation. Without reading the console source, a user might assume the console is interactive.

---

## Philosophy Constraints

From AGENTS.md and system CLAUDE.md:

- **Surface information, don't hide it** -- any unexamined areas must be named explicitly as gaps, not glossed over
- **Validate at boundaries, trust inside** -- `goal` is validated at MCP boundary (`z.string().min(1)`); inside the engine it is trusted
- **Immutability by default** -- event log is append-only; this is why the console can only read, never write
- **YAGNI with discipline** -- console is intentionally minimal and read-only; interactive features are not built until needed
- **Errors are data** -- `neverthrow` ResultAsync used throughout; explains why all session operations return results, not exceptions

**No philosophy conflicts** found between stated principles and repo practice.

---

## Impact Surface

For a discovery investigation, "impact surface" means: what areas of the codebase describe the interaction model?

- `console/src/views/WorkspaceView.tsx` -- `FullEmptyState` component (the key human-facing onboarding signal)
- `src/mcp/v2/tools.ts` -- `V2StartWorkflowInput.goal` field definition
- `src/mcp/handlers/v2-execution/start.ts` -- `buildInitialEvents` (goal -> CONTEXT_SET event)
- `src/v2/usecases/console-service.ts` -- `TITLE_CONTEXT_KEYS` (goal -> session title)
- `docs/integrations/claude-code.md` -- user-facing setup documentation
- `AGENTS.md` -- explicit statement: "The console is early stage -- no authentication, read-only"

---

## Candidates

### Candidate 1: The Two-Surface Model is the Complete Picture

**Summary:** WorkRail has exactly two user-facing surfaces: the MCP server (agent-only) and the console UI (human read-only). No third surface exists for workflow creation or execution.

**Tensions resolved:** Answers all original questions. `goal` lifecycle fully explained. Console purpose clear.

**Tensions accepted:** Leaves `src/cli/` unexamined. A residual CLI uncertainty remains.

**Boundary solved at:** MCP tool call (`start_workflow`). This is the correct boundary -- it is where WorkRail first touches agent/human intent.

**Why that boundary is the best fit:** All evidence (console hooks, empty state, AGENTS.md description, README interaction diagram) converges here. The MCP boundary is where sessions are created; the console is where humans observe them.

**Failure mode:** If `src/cli/` contains a human-accessible session creation or workflow launch command, this candidate is incomplete.

**Repo-pattern relationship:** Follows AGENTS.md exactly ("console is read-only"). Consistent with README interaction diagram (User -> Agent -> WorkRail MCP).

**Gains:** Accurate, concise, well-supported by all examined evidence. Sufficient to answer the original questions.

**Gives up:** Exhaustiveness on the CLI question.

**Scope judgment:** Best-fit for the stated goal.

**Philosophy fit:** Honors 'surface don't hide it' (CLI gap named explicitly). Consistent with YAGNI (doesn't over-audit). Consistent with validate-at-boundaries (explains why `goal` is required at MCP boundary).

---

### Candidate 2: Two-Surface Model + CLI Audit

**Summary:** Extend Candidate 1 by examining `src/cli/` to verify there is no direct session creation or workflow launch path available to humans.

**Tensions resolved:** Eliminates the residual CLI uncertainty. Delivers a fully exhaustive answer.

**Tensions accepted:** Adds investigation scope beyond what is needed to answer the original questions.

**Boundary solved at:** Same as Candidate 1, plus the CLI entry point.

**Why that boundary fits:** Only warranted if the user needs an exhaustive audit (e.g., for documentation or security review), not for the stated goal of understanding the interaction model.

**Failure mode:** None -- strictly additive. Cannot make the answer worse.

**Repo-pattern relationship:** Follows 'surface information, don't hide it' more completely than Candidate 1.

**Gains:** Zero residual uncertainty.

**Gives up:** Time. The original questions are already answered by Candidate 1.

**Scope judgment:** Slightly too broad for the stated goal. Justified if exhaustiveness is required.

**Philosophy fit:** Fully consistent. Honors both 'surface don't hide it' and YAGNI (audit only what is needed to answer the question -- and Candidate 1 already answers it).

---

## Comparison and Recommendation

| Criterion | Candidate 1 | Candidate 2 |
|-----------|------------|------------|
| Answers original questions | Yes, fully | Yes, fully |
| CLI gap | Named as caveat | Eliminated |
| Scope judgment | Best-fit | Slightly too broad |
| Time cost | Zero (already complete) | Low (one directory scan) |
| Failure mode | CLI assumption wrong (low prob) | None |
| Philosophy alignment | Full | Full |

**Recommendation: Candidate 1.**

The original questions are fully answered. The CLI gap is named explicitly as a residual uncertainty -- this honors 'surface don't hide it' without over-auditing. Candidate 2 is only worth the additional investigation if the requester needs an exhaustive system audit.

---

## Self-Critique

**Strongest counter-argument:** `src/cli/` could contain a `workrail start` command that humans use directly. If it does, the two-surface model is a significant under-characterization of the system.

**Narrower option:** Just answer the `goal` parameter question and skip characterizing the console. Lost because the console is central to understanding what users see.

**Broader option justified by:** User explicitly asking for documentation-grade completeness, or a security review requiring all human-accessible entry points to be enumerated.

**Assumption, if wrong, that invalidates Candidate 1:** There is a human-accessible session creation path not discoverable from README, AGENTS.md, console source, or MCP tool schemas. Probability: low. Evidence: AGENTS.md says "console is read-only"; README shows no CLI workflow launcher in the Quick Start or any integration guide.

---

## Open Questions for the Main Agent

1. Should `src/cli/` be examined to eliminate the CLI uncertainty? The cost is low; the probability of finding a session-creation command is low but non-zero.
2. Is the investigation goal "understand the model" (Candidate 1 sufficient) or "produce exhaustive documentation" (Candidate 2 warranted)?
3. Is there a user-facing docs site (not just `docs/`) where the interaction model is described for end users? Not examined in this investigation.
