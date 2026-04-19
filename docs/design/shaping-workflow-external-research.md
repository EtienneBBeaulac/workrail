# Shaping Workflow: External Research Synthesis
# Date: Apr 18, 2026
# Source: Deep research prompt answered by frontier model

## TL;DR

An 11-step prompt chain with two mandatory human gates, a self-refine loop with evaluator-optimizer split, sectioned solution divergence, and a hybrid JSON+markdown artifact. The single highest-leverage design decision: **generation and critique run on structurally different prompts (ideally different model families)** -- anchoring and self-preference bias are not mitigated by CoT or self-reflection alone (Lou & Sun 2025; Panickssery et al. 2024).

## The 11-Step Skeleton

| # | Step | Pattern | Output | Tokens |
|---|---|---|---|---|
| 1 | `ingest_and_extract` | Chain | Frame candidates, forces, open questions | 2–5k |
| 2 | `frame_gate` | Interrupt | Confirmed problem + appetite | small | **MANDATORY HUMAN GATE** |
| 3 | `diverge_solution_shapes` | Parallel ×4 | 4 candidate rough shapes | med ×4 |
| 4 | `converge_pick` | Separate judge | Chosen shape + rationale | small-med |
| 5 | `breadboard_and_elements` | Chain + 1 refine | Breadboard + fat-marker elements | 8–15k |
| 6 | `rabbit_holes_nogos` | Adversarial | Risks, mitigations, no-gos, assumptions | 3–6k |
| 7 | `context_pack_build` | Tool-augmented | File globs, utilities, conventions, related PRs | med-large |
| 8 | `example_map_and_gherkin` | Chain | Rules, examples, Gherkin scenarios | 3–6k |
| 9 | `draft_pitch` | Self-refine ×2, critic=separate prompt | Full pitch (markdown + JSON) | 8–15k ×critique |
| 10 | `approval_gate` | Interrupt | Approved pitch | small | **MANDATORY HUMAN GATE** |
| 11 | `finalize_and_handoff` | Deterministic + schema validate | Canonical artifact + pitch.md | <1k |

Total budget: 50–200k tokens depending on divergence fan-out.

## Key Empirical Findings

### What actually mitigates LLM failure modes in shaping (ranked):
1. **Generator ≠ Evaluator with authorship obfuscation** -- use different model families for generation vs critique. Beats anchoring, self-preference, and mode collapse simultaneously. CoT and self-reflection alone do NOT work (Lou & Sun 2025).
2. **Verbalized Sampling + N-alternatives-before-selection** -- prompt for a distribution, not a single answer. 1.6–2.1× diversity gain (Zhang et al. arXiv 2510.01171).
3. **Schema-constrained structured output** -- kills verbosity compensation, forces right abstraction level by construction.
4. **ClarifyGPT-style consistency check** -- generate two independent interpretations; divergence triggers clarification.
5. **Self-Refine with specific rubric**, bounded at 2–3 iterations (~20% absolute gain, Madaan et al. arXiv 2303.17651).
6. **Red-team pass** with explicit "what's hallucinated / what's missing" prompts against a separate instance.

### The right level of abstraction (encodable heuristic)
**Interfaces and Invariants, Not Function Bodies.**

Classify every sentence in the pitch as:
- **(a) Interface** -- user-visible surfaces, data objects, integration points, touched modules
- **(b) Invariant** -- declarative constraints (idempotency, auth model, consistency requirements, latency budgets)
- **(c) Exclusion** -- explicitly excluded functionality
- **(d) Implementation detail** -- over-specification, demote or cut
- **(e) Vague** -- under-specification, replace with concrete interface/invariant or ask clarifying question

A well-shaped pitch contains only (a), (b), (c).

### Shaping for AI implementers vs humans (the key asymmetry)
LLM implementers need:
- **MORE explicit** than any human spec on: interfaces, invariants, conventions, no-gos, exact API versions, file boundaries (LLMs fabricate APIs, lack tacit codebase knowledge, lack scope-shame)
- **LESS explicit** than junior-human spec on: standard implementation patterns (CRUD, routing, idiomatic error handling -- LLMs know these better)

The dominant failure mode to design against: **confident architectural divergence** -- agent produces working, tested, reviewable PR that reinvents an existing utility or lands logic in the wrong layer. Looks plausible in review. Neither tests nor LLM sensors reliably catch it. Only a better spec prevents it.

### Context Pack (Step 7) is the highest-leverage AI-specific addition
But: **LLM-generated Context Packs are measurably inferior to human-curated ones** (ETH Zurich AGENTS.md study -- LLM-generated context reduced task success in 5 of 8 settings). Treat Step 7 output as a draft requiring spot-check.

## The Artifact Schema

```jsonc
{
  "shaping_run_id": "uuid",
  "frame": {
    "problem_story_md": "...",
    "appetite": {
      "calendar_weeks": 6,
      "token_budget_est": 120000,
      "agent_turns_est": 60,
      "files_touched_est": 8,
      "sizing_bucket": "small|medium|large"
    },
    "forces": { "push": [...], "pull": [...], "anxiety": [...], "habit": [...] }
  },
  "solution": {
    "breadboard_md": "...",
    "elements": [{ "name": "...", "description_md": "...", "classification": "interface|invariant|exclusion" }],
    "alternatives_considered": [{ "sketch": "...", "rejected_because": "..." }]
  },
  "context_pack": {
    "touch_globs": ["src/billing/**"],
    "do_not_touch_globs": ["src/auth/**", "migrations/**"],
    "reuse_utilities": [{ "path": "...", "symbol": "...", "signature": "...", "reason_to_reuse": "..." }],
    "conventions_md": "...",
    "related_prior_art": [{ "path_or_pr": "...", "relevance": "..." }]
  },
  "acceptance_criteria": {
    "gherkin": "Feature: ...\n  Scenario: ...",
    "verification_commands": ["pnpm test src/billing", "tsc --noEmit"],
    "example_map": { "rules": [...], "examples": [...], "open_questions": [...] }
  },
  "rabbit_holes": [{ "risk": "...", "severity": "low|med|critical", "mitigation": "...", "patch_applied": true }],
  "no_gos": ["..."],
  "assumptions_log": [{ "step": "...", "assumption": "...", "confidence": 0.7, "rationale": "..." }],
  "decomposition": {
    "walking_skeleton": { "description": "thin end-to-end slice", "files": [...] },
    "atomic_subtasks": [{ "id": "s1", "title": "...", "depends_on": [], "est_context_window": "single", "acceptance_scenario_refs": ["scenario-1"] }]
  },
  "pitch_md": "# Pitch: ...\n\n## Problem\n...",
  "build_readiness_score": { "rubric_pass_count": 5, "critical_blockers": 0 }
}
```

## What NOT to Build
- Do NOT make this a dynamic autonomous agent -- shaping has a known skeleton (workflow, not agent)
- Do NOT use tree-of-thoughts -- no cheap partial-goal verification signal in shaping
- Do NOT build multi-agent role-plays -- single-voice judge with sectioning strictly dominates
- Do NOT skip the frame gate on "small" tasks -- wrong frame on a small task still wastes the run

## Failure Modes and Mitigations

| Failure mode | Mitigation |
|---|---|
| Mode collapse on diverge step | Verbalized Sampling framing, explicit framing diversity, auto-retry at higher temperature if >70% overlap |
| Self-preference on judge | Obfuscate authorship by rewriting all candidates into uniform voice; ideally different model family |
| Verbosity compensation on pitch | Hard max-length on JSON fields; critic checks for vague modifiers without concrete nouns |
| Hallucinated Context Pack entries | Tool-augment Step 7 with repo grep/AST scan; schema-validate all paths before Step 10 |
| Over-decomposition | Minimum subtask size = single context window; maximum 8 subtasks per pitch; if more, appetite was wrong |
| Silent architectural divergence | Include consistency-check sub-task: implementer lists every new file/symbol and justifies why it's not a duplicate |
