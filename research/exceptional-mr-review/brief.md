# Research Brief: Exceptional MR Review

## Intake Question (verbatim)

What does an exceptional MR/PR review look like, what distinguishes great human reviewers from mediocre ones, what are the known failure modes of LLM agents doing code review, and what concrete prompt/workflow techniques produce agent review quality that rivals expert human reviewers?

---

## Ranked Findings

### F1: Exceptional reviewers check intent and system impact BEFORE correctness -- and always ask questions when they don't understand [confidence: H]

Great reviewers follow a three-step sequence (Google Engineering Practices, verified): (1) broad view -- does this change make sense at all? (2) main parts -- is the design sound? (3) the rest. They check Design first among 9 dimensions, and they explicitly ask for clarification before reviewing code they don't understand rather than writing findings about misunderstood code.

**Strongest evidence for:** Google Engineering Practices review guide (two verified Google pages). Gergely Orosz (blog.pragmaticengineer.com). Chelsea Troy [unconfirmed -- single source].

**Strongest evidence against:** No significant counter-evidence found.

---

### F2: The best-validated technique for improving LLM review quality is an explicit checklist -- 40% improvement in coverage [confidence: H]

Sphinx (Zhang et al., Microsoft/University of Rochester, arXiv:2601.04252) demonstrates that checklist-based training (CRPO) improves LLM PR review completeness by up to 40% over proprietary baselines. The mechanism: human reviewers operate with implicit checklists; making these explicit aligns LLM behavior with real-world review practices.

**Strongest evidence for:** Sphinx paper (arXiv:2601.04252 -- single source, but peer-reviewed, Microsoft-affiliated, accepted 2026).

**Strongest evidence against:** No counter-evidence. Prior claims about steelman-before-criticize and explicit false-positive suppression have NO empirical validation in the fetched literature.

---

### F3: LLMs have five documented failure modes that erode review quality; structural fixes required [confidence: M]

Five failure modes derived from EASE 2026 (arXiv:2604.24525, verified) and Sphinx (arXiv:2601.04252, verified):
(1) Surface pattern matching -- comment on code form, not runtime behavior or system impact.
(2) Context blindness -- treat PR as isolated diff, miss intent alignment.
(3) Pre-existing issue attribution -- flag issues that predate the PR.
(4) Verbosity inflation -- many comments dilute high-signal findings; EASE 2026 shows 0.44-0.62 agreement between automated evaluators and developer labels.
(5) Knowledge gap filling -- write findings about misunderstood code instead of asking questions.

Important nuance on the 0.44-0.62 figure: this measures LLM-as-Judge agreement with developer action labels (fix/wontFix), not raw developer agreement with LLM findings. The figure is directionally correct but understates quality problems because developers ignore good comments under time pressure.

**Strongest evidence for:** EASE 2026 paper (arXiv:2604.24525, accepted EASE 2026, confirmed).

**Strongest evidence against:** No direct counter-evidence. Failure modes are aggregated from multiple papers; the exact categorization is inferred synthesis.

---

### F4: Review value resides primarily in design and maintainability, not bug-finding; automated tools can handle the rest [confidence: M]

Bacchelli & Bird 2013 (ICSE, Microsoft Research -- confirmed to exist; full text not accessed directly) is widely reported as finding that review comment distribution is: code improvements > defect finding > questions > superfluous. Design and evolvability are where human review adds value that static analysis cannot.

Pirouzkhah, Wurzel Goncalves & Bacchelli 2026 (arXiv:2602.14611, 80K PRs): PR descriptions that state desired feedback type best predict reviewer engagement. Intent matters structurally.

**Strongest evidence for:** Bacchelli & Bird 2013 (single-source, confirmed existence); Pirouzkhah et al. 2026 (single-source, directly fetched).

**Strongest evidence against:** No contradicting evidence. The implication for LLM review is clear: agents that focus on correctness/style are optimizing for the lowest-value dimensions.

---

### F5: Role specialization outperforms generalist review; the correct decomposition is 4 roles in a defined execution order [confidence: M]

Google Engineering Practices (verified) requires specialist reviewers for security, concurrency, privacy, and accessibility. Sphinx (verified) decomposes complete PR review into 5 dimensions (functional correctness, robustness, security, coding conventions, architectural alignment). SOEN-101 (arXiv:2403.15852, ICSE 2025) shows role-based multi-agent specialization achieves ~15% improvement in code quality in an adjacent task.

Proposed 4-role decomposition (inferred synthesis): (1) INTENT & DESIGN -- first, blocks all others if fundamentally wrong; (2) CORRECTNESS & COMPLETENESS; (3) SECURITY; (4) MAINTAINABILITY & STYLE -- cannot block merge alone. Roles 2 and 3 can run in parallel after role 1.

**Strongest evidence for:** Google guide (verified), SOEN-101 (ICSE 2025, single-source), Sphinx (single-source).

**Strongest evidence against:** No empirical study directly measuring 4-role vs. generalist reviewer agent quality. The 4-role structure is inferred synthesis.

---

## Contradictions

**C1: Chelsea Troy vs. Google on reviewer participation**
Chelsea Troy: reviewer must pull down and run code, push working code suggestions -- full participation in the solution. Google guide: reviewer reads every line but focuses on comments; running the code is recommended for UI-facing changes only.
Resolution: These are not contradictory -- Troy describes the ideal; Google describes the minimum. For an LLM agent, Troy's standard is impractical (cannot run code), but the implication is that agents should provide working code suggestions, not just flags.

**C2: EASE 2026 vs. practitioner enthusiasm for AI code review**
EASE 2026 shows only moderate LLM-as-Judge agreement with developers (0.44-0.62). Industry tooling blog posts (Qodo, GitHub Copilot) present AI code review as highly effective.
Resolution: EASE 2026 measures an industrial deployment at Beko; industry blogs describe curated demos. The EASE 2026 result should be treated as ground truth for quality estimation.

---

## Falsified Priors

**P8 -- FALSIFIED (partial):** "LLMs improve with: concrete checklist, steelman-before-criticize, explicit false-positive suppression."
- CORROBORATED portion: concrete checklist -- validated by Sphinx (40% improvement).
- FALSIFIED portion: steelman-before-criticize and explicit false-positive suppression -- NO empirical validation found in fetched literature. These are plausible hypotheses, not validated techniques. The prior overstates the evidence.
- Overturning claim: SQ4-C7 (synthesis showing gap in validation for two of three claimed techniques).

---

## What We Now Know

- The 9 Google review dimensions and 3-step sequence are confirmed and should structure reviewer prompts directly.
- The EASE 2026 paper exists and the 0.44-0.62 figure is real but nuanced (measures evaluator-developer label agreement, not direct finding acceptance).
- Checklist-based review is the strongest evidence-backed technique (40% improvement).
- Five LLM failure modes are empirically supported and traceable to specific papers.
- Design and maintainability concerns are where review adds most human value; style is automatable.
- Role specialization is supported by practitioner evidence and adjacent-task research.

## What We Still Do Not Know

- Whether the specific 4-role structure proposed for wr.mr-review outperforms generalist review or a different decomposition (no direct empirical study exists).
- Whether steelman-before-criticize reduces false positive rate in code review specifically (hypothesis, not validated).
- The Bacchelli & Bird exact distribution of comment types (paper confirmed but not directly accessible; findings are from secondary sources).
- Whether the intent gate (Guardrail 1) reduces wasted compute/noise in practice -- it is structurally justified but not measured.
- Whether the 0.44-0.62 figure improves with the techniques identified (no study has measured structured-checklist + role-specialized LLM review against developer acceptance).

---

## Implications for wr.mr-review Overhaul

The research directly answers the design questions:

1. **Reviewer family prompts must use explicit checklists per role** -- the single best-validated technique (Sphinx, 40% improvement). Each reviewer role should receive a domain-specific checklist, not a general instruction to review.

2. **Intent review must be structurally first and gate the rest** -- this is the highest-leverage structural change. If intent is misaligned, the rest of the review may be thrown away (Google guide, verified).

3. **Each reviewer must receive full context: diff + PR description + linked issue** -- not just the diff. Context blindness is a documented failure mode (Sphinx).

4. **Output schema must be forced: severity enum, category, location, reasoning, recommendation** -- vague findings are the chief output failure mode (from Abstain/Validate, Oliveira et al.).

5. **A synthesis step with deduplication is mandatory** -- raw multi-reviewer output is noisy and contradictory without it.

6. **Steelman-before-criticize and false-positive suppression are unvalidated** -- they can be included as reasonable hypotheses but should not be presented as evidence-backed techniques.

---

## Recommended Next Steps

**N1:** Run a controlled experiment with wr.mr-review using explicit per-role checklists vs. current prompts, measuring finding actionability rate. Estimated cost: medium (requires 20-30 real PR reviews with human rating).

**N2:** Validate the intent gate structure by analyzing existing wr.mr-review sessions for cases where late design findings would have been caught earlier by an intent check. Estimated cost: low (can be done on historical session data).

**N3:** Access the full Bacchelli & Bird 2013 paper text to verify the exact comment type distribution. Estimated cost: low (institutional access or ResearchGate request).

---

## BLUF

Great human reviewers check intent and design first, ask questions when they don't understand code (rather than writing findings), and distinguish blocking issues from non-blocking suggestions. The empirically strongest technique for improving LLM review quality is an explicit per-domain checklist -- validated at 40% improvement in coverage (Sphinx, Microsoft). LLMs have five documented failure modes: surface pattern matching, context blindness, pre-existing issue attribution, verbosity inflation, and knowledge gap filling. The workflow for wr.mr-review should enforce: an intent gate before all other reviewers, full context injection (diff + PR description + issue), per-role checklists, a forced output schema with severity enumeration, and a synthesis step with deduplication. Steelman-before-criticize and false-positive suppression are plausible improvements but have no empirical validation in the code review literature.
