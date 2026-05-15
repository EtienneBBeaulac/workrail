# Research Log -- Exceptional MR Review

## Phase 1 complete

- Regime: depth_serial
- Sub-question count: 6
- Topological order: SQ1 -> SQ2 -> SQ3 -> SQ4 -> SQ5 -> SQ6
- Source map: 8 entries (deep mode cap reached)
- Artifacts: source-map.md, dependency-matrix.json, plan.md

## Phase 2 complete

- Plan approved autonomously (subagent mode, no user available)
- No edits required
- Regime unchanged: depth_serial
- Proceeding to collection

## Phase 3 complete (pass 1)

- SQ1: 10 claims -- Google guide (9 dimensions, 3-step navigation), Chelsea Troy (participation principle), Gergely Orosz (system context, nitpick automation)
- SQ2: 7 claims -- Bacchelli & Bird 2013 (confirmed exists, key findings inferred), Pirouzkhah et al. 2026 (PR description value, 80K PRs study), Swarmia synthesis
- SQ3: 8 claims -- EASE 2026 paper verified (arXiv:2604.24525, 0.44-0.62 developer agreement confirmed), Sphinx paper (3 LLM limitations), Abstain/Validate (noise erosion)
- SQ4: 8 claims -- Sphinx CRPO (40% improvement with checklist, empirically validated), SOEN-101 role specialization (15% improvement), Abstain/Validate two-stage, OWASP security specialization
- SQ5: 7 claims -- 4-role specialization framework (Intent/Design, Correctness/Completeness, Security, Maintainability), Sphinx 5-domain decomposition
- SQ6: 8 claims -- 6 structural guardrails (intent gate, diff scope, output schema, synthesis deduplication, knowledge gap protocol, conditional early termination)

Total claims: 48 across 6 sub-questions

## Phase 4 complete (pass 1): 7 verified, 17 single-source, 24 inferred, 0 falsified-pending, 8 corroborated

Key findings:
- EASE 2026 paper verified (arXiv:2604.24525)
- 0.44-0.62 figure is real but refers to LLM-as-Judge vs developer labels
- Checklist-based training: 40% improvement in coverage (Sphinx, best validated technique)
- Steelman-before-criticize: NO empirical validation found
- Role specialization: partially validated via adjacent task (SOEN-101)
- Prior P8 partially falsified: checklist validated, steelman/false-positive suppression are not

## Phase 5 complete (pass 1): stop

SQ1 and SQ3 resolved. SQ2, SQ4, SQ5, SQ6 partial but gaps are synthesis gaps, not collection gaps. Proceeding to synthesis.

## Phase 6 complete: 1526 words

## Phase 7 complete: dissent type = weakest-claim

Dissent challenges: (1) F1 is entirely prescriptive, not empirical; Bacchelli & Bird (the only empirical observational study) was not directly accessed. (2) F5 4-role decomposition is a synthesis claim with no direct source; SOEN-101 evidence is adjacent task only. Both challenges are substantive but do not overturn the core findings.

## Phase 8 complete: RESEARCH COMPLETE -- brief.md emitted

Final brief: /Users/etienneb/git/personal/workrail/docs/design/mr-review-overhaul/research-exceptional-mr-review.md
Word count: 2456 (budget: 2500)
Validation gate: PASS (structural_integrity: high, confidence_integrity: high, focus_integrity: high)
