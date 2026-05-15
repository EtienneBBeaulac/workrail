# Research Log

## Phase 8 complete: RESEARCH COMPLETE -- brief.md emitted

## Phase 7 complete: dissent type = weakest-claim

## Phase 6 complete: ~720 words

## Phase 5 complete (pass 1): stop

## Phase 4 complete (pass 1): 5 verified, 17 single-source, 8 inferred, 0 falsified-pending, 0 corroborated

## Phase 3 complete (pass 1)

- SQ1: 8 claims written (Semgrep, SonarQube, Reviewdog diff-anchoring mechanisms and failure modes)
- SQ2: 8 claims written (PR-Agent source inspection, CodeRabbit learnings/multi-repo, Copilot limitations)
- SQ3: 7 claims written (hard cases taxonomy: HC-1 through HC-7)
- SQ4: 6 claims written (Infer reactive, Semgrep Pro limitation, CodeRabbit multi-repo)
- SQ5: 5 claims written (3 concrete techniques with implementation detail)
- Final brief written to: docs/design/mr-review-overhaul/research-regression-vs-preexisting.md

## Phase 1 complete

- **Regime:** depth_serial (SQ3 depends on SQ1; SQ4 depends on SQ1 + SQ3; SQ5 depends on SQ2 + SQ3 + SQ4)
- **Sub-question count:** 5
- **Topological order:** SQ1 -> SQ2 -> SQ3 -> SQ4 -> SQ5
- **Source map entries:** 8 (deep mode cap)
- **Mode:** deep
- **Per-subagent token budget:** 25,000

Artifacts produced:
- `source-map.md` -- 8 source types mapped to sub-questions
- `dependency-matrix.json` -- 5 sub-questions with dependency graph and topological order
- `plan.md` -- per-sub-question task, source priorities, stop rules, token budgets
