# Gap Analysis -- Pass 1

## Resolved Sub-questions

**SQ1: What great human reviewers do differently**
Status: RESOLVED
Evidence: 2+ verified claims (SQ1-C1 verified with 2 Google guide URLs; SQ1-C10 verified with Google + Gergely). Multiple corroborating single-source claims from 3 distinct high-quality sources (Google guide, Chelsea Troy, Gergely Orosz). No contradicting evidence.
Key finding: 9 dimensions (Design first), 3-step sequence (broad view -> main parts -> rest), ask questions before findings, distinguish blocking from non-blocking.

**SQ2: Empirical evidence on review comment usefulness**
Status: PARTIAL
Evidence: 1 single-source verified (Bacchelli & Bird confirmed to exist, key findings inferred from secondary sources). Pirouzkhah et al. 2026 adds strong new evidence on PR description value. Bosu et al. findings remain inferred.
Key finding: Review value is primarily in design/maintainability/knowledge transfer, not bug-finding. Not fully resolved due to lack of direct paper text access.

**SQ3: LLM code review failure modes**
Status: RESOLVED
Evidence: EASE 2026 paper directly verified (arXiv:2604.24525). Sphinx paper directly verified (arXiv:2601.04252). Multiple single-source claims from distinct papers. 5 failure modes derived from empirically supported claims with clear derivation chain.
Key finding: Surface pattern matching, context blindness, pre-existing attribution, verbosity, knowledge gap filling. EASE 2026 0.44-0.62 figure confirmed and nuanced.

**SQ4: Prompt and instruction techniques**
Status: PARTIAL
Evidence: Checklist technique empirically validated (Sphinx, 40% improvement). Role specialization partially validated via adjacent task. Steelman-before-criticize and false-positive suppression have NO empirical validation in fetched literature. Two-stage validation validated in adjacent task.
Gap: No directly validated evidence for steelman or false-positive suppression in code review specifically.

**SQ5: Reviewer specialization structure**
Status: PARTIAL
Evidence: Strong theoretical/practitioner basis (Google, Gergely, Sphinx, OWASP) but no direct empirical measurement of specialized reviewer agent performance vs. generalist in code review. The 4-role structure is inferred synthesis.
Gap: No direct empirical evidence for the specific 4-role structure proposed.

**SQ6: Workflow structural guardrails**
Status: PARTIAL (by design -- synthesis sub-question)
Evidence: All 8 guardrails derive from SQ3-SQ5 claims. The synthesis is coherent and traceable. No direct empirical study measures workflow structural effects on agent review quality.
Gap: No direct empirical validation of the specific guardrails proposed.

## Open Sub-questions

None -- all have at least partial evidence.

## Loop Decision

**Decision: STOP**

Rationale:
1. iterationCount = 1, iterationCap = 2 (could iterate), but:
2. SQ1 and SQ3 are fully resolved -- the most critical sub-questions for the deliverable.
3. SQ4, SQ5, and SQ6 gaps are synthesis gaps, not collection gaps. No additional web search would resolve them -- they require synthesis reasoning, not more sources.
4. The SQ2 gap (Bacchelli full text) is not on the critical path -- the key finding (design > bugs in review value) is corroborated by multiple secondary sources and the Pirouzkhah 2026 paper.
5. The remaining gaps (steelman validation, 4-role structure validation) cannot be resolved with available web sources -- they would require experimental data not yet published.

Proceeding to synthesis.
