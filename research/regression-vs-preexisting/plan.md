# Research Plan

## Mode: deep | Regime: depth_serial | Sub-questions: 5

---

## SQ1 -- Diff-anchoring techniques in shipped static analysis tools

**Planned task:** Fetch Semgrep CI diff-aware scan docs, SonarQube new-code-period docs, and Reviewdog filter-mode source/docs. Extract the actual mechanism: how is the diff computed, how are findings filtered, and what are documented limitations.

**Source-map priorities:** S1 (Semgrep), S2 (SonarQube), S8 (Reviewdog/CodeClimate)

**Stop rule:** min 3 fetches AND 2 consecutive zero-novelty fetches, OR token budget hit

**Token budget:** 25,000 tokens

**Shipped_vs_announced filter:** Require evidence from docs, source code, or changelog -- not blog posts making feature claims without implementation links.

---

## SQ2 -- LLM-based PR review bots: context construction and finding attribution

**Planned task:** Inspect Qodo PR-Agent source (GitHub) for prompt construction -- specifically how it builds the review prompt, what context it injects beyond the diff, and whether it has any mechanism to label findings as "new" vs "pre-existing". Also fetch CodeRabbit changelog/docs for evidence of any shipped incremental review or context-beyond-diff feature.

**Source-map priorities:** S3 (PR-Agent source), S4 (CodeRabbit docs), S5 (GitHub API)

**Stop rule:** min 3 fetches AND 2 consecutive zero-novelty fetches, OR token budget hit

**Token budget:** 25,000 tokens

**Shipped_vs_announced filter:** For PR-Agent: evidence from source code is authoritative. For CodeRabbit: changelog entries with dates > 2024-01-01 only; discard "coming soon" or "roadmap" items.

---

## SQ3 -- Hard cases where diff-anchoring fails

**Planned task:** Synthesize from SQ1 failure modes + search for documented cases. Look for: (a) Reviewdog filter-mode edge cases, (b) SonarQube "why didn't it catch this" community reports, (c) academic literature on false negatives in diff-filtered SAST. The goal is a taxonomy of hard cases with concrete examples.

**Source-map priorities:** S7 (alert noise / critic literature), S6 (academic papers), S1, S2

**Stop rule:** min 3 fetches AND 2 consecutive zero-novelty fetches, OR token budget hit

**Token budget:** 25,000 tokens

**Dependency:** Must complete SQ1 first.

---

## SQ4 -- Call-graph and cross-file impact analysis in shipped tools

**Planned task:** Search for concrete implementations of cross-file impact analysis in PR review context. Check: Facebook Infer's interprocedural analysis in CI, Semgrep's pro interprocedural rules (if any), SonarQube's taint flow, and any academic tools. Key question: is there any tool that, given a changed function signature, automatically flags unchanged callers?

**Source-map priorities:** S1 (Semgrep pro), S2 (SonarQube taint), S6 (academic)

**Stop rule:** min 3 fetches AND 2 consecutive zero-novelty fetches, OR token budget hit

**Token budget:** 25,000 tokens

**Dependency:** Must complete SQ1 and SQ3 first.

---

## SQ5 -- Concrete techniques for LLM-based review workflow

**Planned task:** Synthesize findings from SQ1-SQ4 into concrete, implementable techniques for wr.mr-review. For each technique: name, mechanism, what it addresses from the hard-cases taxonomy (SQ3), whether it requires engine primitives or is pure prompt engineering, and estimated implementation effort. Aim for 2-3 ranked recommendations.

**Source-map priorities:** All prior findings; no additional fetching unless a gap is discovered.

**Stop rule:** Synthesis only -- no fetching unless a specific gap requires it.

**Token budget:** 10,000 tokens (synthesis, minimal new fetching)

**Dependency:** Must complete SQ2, SQ3, SQ4 first.

---

## Notes

- All artifacts written to `/Users/etienneb/git/personal/workrail/research/regression-vs-preexisting/`
- Final brief written to `/Users/etienneb/git/personal/workrail/docs/design/mr-review-overhaul/research-regression-vs-preexisting.md`
- iterationCap: 2 (maximum 2 search/fetch passes per sub-question before declaring zero novelty)
