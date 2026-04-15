# Design Review: wf.retro (v1 Hybrid)

_Review for selected direction: Candidate A (`wf.retro` filesystem learning loop), v1 hybrid shape._

## Tradeoff Review

| Tradeoff | Acceptable? | Condition for Failure | Hidden Assumption |
|----------|-------------|----------------------|-------------------|
| Local-only knowledge (no cross-user sharing) | YES | WorkRail reaches user base where community patterns matter | Primary value is per-user improvement, not community sharing |
| Quality depends on agent synthesis judgment | CONDITIONAL | Requires note quality pre-check in v1 to prevent silent value failure | Agents produce substantive notes; WorkRail enforces minimum but not quality |
| Outcome signals deferred to backlog | YES | Enterprise buyers require quantitative metrics before adopting | Current user base is solo devs + small teams, not enterprise |

## Failure Mode Review

| Failure Mode | Design Handles It? | Missing Mitigation | Danger Level |
|---|---|---|---|
| Thin session notes produce useless retro | Partially | Note quality scan step REQUIRED in v1 | HIGH -- silent value failure |
| Sycophantic learning extraction | Not directly | Explicit anti-sycophancy instructions in workflow prompts | MEDIUM -- noise without improvement |
| Convergence risk (nexus + WorkRail targeting same users) | Partially (learning loop deepens moat) | Monitoring; no design change needed now | HIGH long-term, LOW in 12-18 months |

**Highest-risk failure mode:** Thin notes producing silent value failure. Must be addressed in v1.

## Runner-Up / Simpler Alternative Review

**From runner-up (Candidate B):** Extraction confidence disclosure (`low | medium | high` based on session quality and quantity) is worth borrowing. Implemented as workflow output formatting, not schema change.

**Simpler alternative:** `wf.retro` v1 outputs a markdown summary report only (no git-committed workflow patches). Satisfies all acceptance criteria. Patch proposal mechanic is v2.

**Hybrid selected:** Simple markdown report + note quality scan + extraction confidence disclosure. No schema changes, no new storage, workflow authoring only.

## Philosophy Alignment

| Principle | Status | Notes |
|-----------|--------|-------|
| YAGNI with discipline | SATISFIED | Workflow file only; no infrastructure |
| Use structure only when it earns its place | SATISFIED | Quality scan and confidence disclosure both prevent real failure modes |
| Never-stop by default (degrade and disclose) | SATISFIED | Retro runs with thin notes but surfaces quality gap prominently |
| Functional/declarative over imperative | SATISFIED | Workflow constrains invariants, not cognition |
| Validate at boundaries, trust inside | MILD TENSION | Quality scan is the boundary check; acceptable at workflow level |
| Make illegal states unrepresentable | MILD TENSION | 'Thin notes' handled at workflow level, not type level; acceptable |

## Findings

**Yellow (Watch):**
- Note quality enforcement at the workflow level is weaker than at the schema/engine level. If agents routinely provide thin notes despite the existing minimum, v1's quality scan will flag this but not fix it. A future schema enhancement (quality scoring in the session schema) would be more robust.

**Yellow (Watch):**
- Extraction confidence disclosure must be prominent and calibrated. If the workflow discloses 'low confidence' in a way that users ignore or dismiss, the disclosure fails its purpose. Workflow authoring must make the confidence signal decision-relevant (e.g., 'At low confidence, consider running more workflows before retro analysis').

**Green (No Action):**
- Schema fit: v1 requires no schema changes; all implementation is workflow authoring. No risk of architectural misalignment.
- Priority alignment: `wf.retro` can ship as a bundled workflow in `workflows/` with zero roadmap conflict.

## Recommended Revisions

1. **Add note quality scan as a REQUIRED first step in `wf.retro`** (not optional): scan session files, compute per-session average note length, flag sessions below 150 chars average, report the quality distribution before extraction.

2. **Add anti-sycophancy instructions to extraction step:** explicitly instruct the agent to look for uncertainty expressions, failure patterns, and edge cases in the notes -- not confirmation of success.

3. **Add extraction confidence disclosure to output step:** report `high/medium/low` confidence with explicit criteria and recommended action when confidence is low.

4. **Defer git-committed patch proposals to v2:** v1 output is a markdown summary report only. Patch proposals add commit mechanics that are not needed to validate the learning loop concept.

## Residual Concerns

1. **Sycophancy in notes is deeper than sycophancy in extraction.** If agents write uniformly positive notes (which they can while technically satisfying the `min(1)` requirement), no extraction quality filter can help. The real fix is enforcement at the note-writing step -- but that's a workflow UX design problem, not a `wf.retro` problem.

2. **v1 produces local-only knowledge.** If two WorkRail users independently discover the same workflow improvement, they have no way to share it. This is acceptable for now but is the gap nexus-cortex-v2 (collective knowledge graph) is designed to fill at scale.

3. **The 'how to implement `wf.retro`' question is not answered here.** This review covers the strategic direction; the actual workflow JSON authoring (step definitions, prompts, conditions) is implementation work that follows from this review.
