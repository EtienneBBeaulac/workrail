# Research Brief: Exceptional MR Review

## Intake Question (verbatim)

What does an exceptional MR/PR review look like, what distinguishes great human reviewers from mediocre ones, what are the known failure modes of LLM agents doing code review, and what concrete prompt/workflow techniques produce agent review quality that rivals expert human reviewers?

---

## BLUF

Great human reviewers -- by practitioner consensus from multiple independent sources -- check intent and design before correctness, ask questions when they don't understand code rather than writing tentative findings, and distinguish blocking issues from non-blocking suggestions. These are prescriptive principles with strong cross-source corroboration, though no controlled outcomes study directly confirms they cause better results. The empirically strongest technique for improving LLM review quality is an explicit per-domain checklist: validated at 40% improvement in coverage (Sphinx, Microsoft, arXiv:2601.04252). LLMs have five empirically documented failure modes: surface pattern matching, context blindness, pre-existing issue attribution, verbosity inflation, and knowledge gap filling (EASE 2026, arXiv:2604.24525). The wr.mr-review workflow should enforce: an intent gate before all other reviewers, full context injection (diff + PR description + linked issue), per-role explicit checklists, a forced output schema with severity enumeration, and a synthesis step with deduplication. Steelman-before-criticize and false-positive suppression are plausible improvements but have no empirical validation in the code review literature.

---

## Ranked Findings

### F1: Expert reviewers check intent and system impact before correctness, and ask questions rather than writing findings when they don't understand code [confidence: M-H, practitioner consensus]

NOTE: All sources for this finding are prescriptive guides and practitioner blogs, not controlled observational studies. The finding reflects strong cross-source practitioner consensus, not a measured causal relationship between this behavior and review outcomes. The only at-scale empirical study of reviewer behavior (Bacchelli & Bird 2013) was not directly accessed, and their known finding is that actual reviewer behavior often diverges from guide prescriptions.

Great reviewers follow a documented three-step sequence (Google Engineering Practices, two verified pages): (1) broad view -- does this change make sense? (2) main parts -- is the design sound? (3) the rest. They check Design first among 9 named dimensions. They ask for clarification before reviewing code they don't understand rather than writing findings about misunderstood code.

**Strongest evidence for:** Google Engineering Practices review guide (verified, two Google pages). Gergely Orosz (single-source, practitioner blog). Chelsea Troy [unconfirmed].

**Strongest evidence against:** No controlled counter-evidence. See dissent: the claim that intent-first ordering produces better outcomes vs. correctness-first is practitioner consensus, not measured causality.

---

### F2: The best-validated technique for improving LLM review quality is an explicit per-domain checklist -- 40% improvement in coverage [confidence: H]

Sphinx (Zhang et al., Microsoft/University of Rochester, arXiv:2601.04252, accepted 2026) demonstrates that checklist-based training (CRPO) improves LLM PR review completeness by up to 40% over proprietary baselines including GPT-4. The mechanism: human reviewers operate with implicit checklists -- verifying functional correctness, robustness, security compliance, coding conventions, and architectural alignment. Making these checklists explicit aligns LLM behavior with real-world review practices.

Important caveat: the 40% figure is from fine-tuned model training with CRPO, not from prompting a general-purpose LLM with a checklist. Whether a checklist prompt alone achieves comparable improvement in instruction-following LLMs is not separately measured.

**Strongest evidence for:** Sphinx paper (arXiv:2601.04252 -- single source, peer-reviewed, Microsoft-affiliated, accepted 2026).

**Strongest evidence against:** No counter-evidence. Prior claims about steelman-before-criticize and false-positive suppression have NO empirical validation in the fetched literature.

---

### F3: LLMs have five empirically documented failure modes that erode review quality and require structural fixes [confidence: M]

From EASE 2026 (arXiv:2604.24525, accepted EASE 2026, verified) and Sphinx (arXiv:2601.04252):

1. Surface pattern matching -- comment on code form, not runtime behavior or system impact
2. Context blindness -- treat PR as isolated diff, miss intent alignment ("limited contextual understanding" -- Sphinx)
3. Pre-existing issue attribution -- flag issues that predate the PR
4. Verbosity inflation -- many comments dilute high-signal findings
5. Knowledge gap filling -- write findings about misunderstood code instead of asking questions

On the 0.44-0.62 figure: This is the agreement ratio between automated evaluation (LLM-as-Judge) and developer action labels (fix/wontFix) on bot-generated PR comments. It is NOT raw developer agreement with LLM findings. The EASE 2026 paper notes developer labeling is "strongly influenced by workflow pressures and organizational constraints" -- meaning the figure likely overstates true quality because good comments get ignored when developers are under time pressure.

**Strongest evidence for:** EASE 2026 (arXiv:2604.24525, confirmed). Sphinx (arXiv:2601.04252). Abstain/Validate (arXiv:2510.03217, ICSE 2025) for failure modes 3-4.

**Strongest evidence against:** Failure modes 3-5 are inferred synthesis; no single paper directly measures all five.

---

### F4: Review value resides primarily in design and maintainability, not bug-finding [confidence: M, inferred from secondary sources]

Bacchelli & Bird 2013 (ICSE, Microsoft Research, DOI: 10.1109/ICSE.2013.6606617) is confirmed to exist but was not directly accessed. Widely reported finding: review comment distribution is code improvements > defect finding > questions > superfluous comments. Design and evolvability are where human review adds value that static analysis cannot.

Pirouzkhah, Wurzel Goncalves & Bacchelli 2026 (arXiv:2602.14611, 80K PRs, 156 projects): PR descriptions that state desired feedback type best predict reviewer engagement. This is a 2026 paper from Bacchelli's group that was directly accessed.

**Strongest evidence for:** Bacchelli & Bird 2013 (single-source, confirmed existence, full text not accessed). Pirouzkhah et al. 2026 (single-source, directly fetched). Swarmia synthesis (inferred).

**Strongest evidence against:** No contradicting evidence. Full Bacchelli text not verified directly.

---

### F5: Role specialization outperforms generalist review; the proposed 4-role decomposition is a design hypothesis requiring validation, not a research finding [confidence: M, partially inferred]

NOTE: This is the weakest finding. The 4-role decomposition is a synthesis claim with no single source. The SOEN-101 specialization evidence is from code generation (adjacent task). The choice of 4 roles vs. 3 or 5 is not empirically justified within the evidence base.

Google Engineering Practices (verified) requires specialist reviewers for complex concerns (security, concurrency, privacy, accessibility). Sphinx (single-source) decomposes review into 5 dimensions. SOEN-101 (ICSE 2025, single-source) shows role-based multi-agent specialization achieves ~15% improvement in code generation.

Proposed 4-role design hypothesis: (1) INTENT & DESIGN -- must run first, can gate rest if fundamentally wrong; (2) CORRECTNESS & COMPLETENESS; (3) SECURITY; (4) MAINTAINABILITY & STYLE -- cannot block merge alone. Roles 2 and 3 can run in parallel after role 1.

**Strongest evidence for:** Google guide (verified), SOEN-101 (ICSE 2025, single-source), Sphinx 5-dimension decomposition (single-source).

**Strongest evidence against:** No empirical study directly comparing 4-role vs. generalist reviewer agents in code review. The specific role structure is inferred synthesis.

---

## Contradictions

**C1: Chelsea Troy vs. Google on reviewer participation**
Chelsea Troy: reviewer must pull down and run code, push working code suggestions. Google: reviewer reads every line; running code is recommended for UI-facing changes only.
Resolution: Troy describes the ideal; Google describes the minimum. For LLM agents, Troy's full-participation standard is impractical, but the implication is clear: agents should provide working code fix suggestions, not just flags.

**C2: EASE 2026 vs. industry enthusiasm for AI code review**
EASE 2026 shows only moderate LLM-as-Judge agreement with developers (0.44-0.62). Industry blog posts present AI code review as highly effective.
Resolution: EASE 2026 is an industrial deployment study (2,604 bot comments at Beko). Industry blogs describe curated demos. The EASE 2026 figure should be treated as ground truth for quality estimation.

---

## Falsified Priors

**P8 -- PARTIALLY FALSIFIED:** "LLMs improve with: concrete checklist, steelman-before-criticize, explicit false-positive suppression."
- CORROBORATED portion: concrete checklist -- validated by Sphinx (40% improvement).
- FALSIFIED portion: steelman-before-criticize and explicit false-positive suppression -- NO empirical validation found in the fetched literature. These are plausible design hypotheses, not validated techniques.
- Overturning claim: SQ4-C7 (synthesis gap analysis showing no validation for two of three claimed techniques).

---

## What We Now Know

- Google's 9 review dimensions and 3-step sequence are confirmed practitioner standards and directly usable in reviewer prompts.
- The EASE 2026 paper exists (arXiv:2604.24525); the 0.44-0.62 figure is real but measures evaluator-developer label agreement, not raw finding acceptance.
- Checklist-based review is the empirically strongest technique -- 40% improvement in coverage.
- Five LLM failure modes are supported by at least one peer-reviewed paper each.
- Design and maintainability concerns are where human review adds most value; style concerns are automatable.
- Bacchelli & Bird 2013 is confirmed to exist as the foundational empirical study of reviewer behavior.

## What We Still Do Not Know

- Whether the specific 4-role decomposition outperforms generalist review or an alternative decomposition (no direct empirical study exists).
- Whether steelman-before-criticize reduces false positive rate in code review (hypothesis, not validated).
- The exact Bacchelli & Bird comment type distribution (paper not directly accessed; findings from secondary sources).
- Whether the intent gate reduces wasted compute/noise in practice (structurally justified, not measured).
- Whether checklist PROMPTING (vs. checklist TRAINING as in Sphinx) achieves comparable improvement in general-purpose LLMs.
- Whether the 0.44-0.62 figure improves with the identified techniques (no study has measured structured-checklist + role-specialized review against developer acceptance).

---

## Implications for wr.mr-review Overhaul

Six concrete design changes directly supported by the research:

1. **Per-role explicit checklists** -- single best-validated technique (Sphinx, 40% improvement). Each reviewer role should receive a domain-specific checklist, not a general instruction. The checklist format is what matters, not specific items (those are design decisions).

2. **Intent gate before all other reviewers** -- structurally required by Google's navigation guide and by the blast-radius principle. If intent is misaligned, remaining review may be thrown away. This is the highest-leverage structural change.

3. **Full context injection: diff + PR description + linked issue** -- not just the diff. Context blindness is Sphinx's second-named failure mode. Reviewers that receive only the diff produce shallow, context-blind findings.

4. **Forced output schema: severity enum (blocker|suggestion|nit) + category + location + reasoning + recommendation** -- vague findings are the chief output failure mode. Without a forced severity enum, findings lose signal-to-noise ratio. Without a required recommendation, findings become flags without direction.

5. **Synthesis step with deduplication** -- raw multi-reviewer output is noisy and contradictory. A synthesis step must deduplicate findings across roles, resolve severity conflicts, and produce prioritized output (blockers first).

6. **Treat steelman and false-positive suppression as hypotheses** -- they can be included in prompts as reasonable design choices, but they should not be presented as evidence-backed improvements.

---

## Recommended Next Steps

**N1:** Validate checklist prompting specifically (not just Sphinx's CRPO training) by A/B testing wr.mr-review with explicit per-role checklists vs. current prompts, measuring finding actionability rate. Estimated cost: medium (20-30 real PR reviews with human rating).

**N2:** Access full Bacchelli & Bird 2013 paper text to verify the comment type distribution and confirm that design/maintainability dominates over bug-finding in practice. Estimated cost: low (ResearchGate request or institutional access).

**N3:** After deploying the 4-role structure, measure whether roles 2-3 (correctness + security) findings overlap significantly -- if overlap is high, the decomposition may need adjustment. Estimated cost: low (analyze session data after 20+ reviews).

---

## Dissent

From adversarial review of the evidence base:

**F1 is prescriptive, not empirical.** Every source cited for F1 is a prescriptive guide or practitioner blog. No controlled study measures whether intent-first ordering produces better outcomes than correctness-first ordering. The claim that asking questions rather than writing tentative findings is superior is stated as principle in the Google guide (SQ1-C9) but is not demonstrated to correlate with better outcomes. The Bacchelli & Bird paper -- the foundational observational study -- was not directly accessed, and its finding that reviewer behavior diverges from guide prescriptions is not addressed.

**F5's 4-role decomposition is a design hypothesis, not a research finding.** The proposed role structure has no single source; it is inferred from Sphinx's 5 dimensions (different mapping), Google's specialist-for-complex-concerns principle, and SOEN-101's code-generation result (adjacent task). The choice of 4 roles vs. 3 or 5 is not justified within the evidence base.

Both critiques are fair and are reflected in the confidence ratings (F1 downgraded from H to M-H; F5 explicitly labeled as design hypothesis).

---

## Premortem

If this brief turns out to be wrong six months from now, the most likely reason is that checklist prompting of general-purpose LLMs (as distinct from CRPO fine-tuning as in Sphinx) does not achieve the 40% coverage improvement -- meaning the core recommendation to add per-role checklists to wr.mr-review's reviewer prompts produces much smaller gains than the Sphinx result suggests. The Sphinx result is from a model trained with structured rewards; applying checklists as instructions to a general-purpose LLM at inference time is a different technique. If this is wrong, the fallback remains the structural guardrails (intent gate, full context, output schema, synthesis) which are supported by practitioner consensus independently of the Sphinx result.

---

## Evidence Base

[1] Google Engineering Practices -- What to Look For in a Code Review -- https://google.github.io/eng-practices/review/reviewer/looking-for.html

[2] Google Engineering Practices -- Navigating a CL in Review -- https://google.github.io/eng-practices/review/reviewer/navigate.html

[3] Google Engineering Practices -- The Standard of Code Review -- https://google.github.io/eng-practices/review/reviewer/standard.html

[4] Chelsea Troy -- Reviewing Pull Requests (2019) -- https://chelseatroy.com/2019/12/18/reviewing-pull-requests/

[5] Gergely Orosz -- Good Code Reviews, Better Code Reviews -- https://blog.pragmaticengineer.com/good-code-reviews-better-code-reviews/

[6] Bacchelli & Bird -- Expectations, Outcomes, and Challenges of Modern Code Review (ICSE 2013) -- https://www.microsoft.com/en-us/research/publication/expectations-outcomes-and-challenges-of-modern-code-review/ [existence confirmed, full text not accessed]

[7] Karakaya, Torun, Ucar, Tüzün -- Understanding the Limits of Automated Evaluation for Code Review Bots in Practice (EASE 2026) -- https://arxiv.org/abs/2604.24525

[8] Zhang et al. -- Sphinx: Benchmarking and Modeling for LLM-Driven Pull Request Review (2026) -- https://arxiv.org/abs/2601.04252 / https://arxiv.org/html/2601.04252v1

[9] Lin, Kim, Chen -- SOEN-101: Code Generation by Emulating Software Process Models Using LLM Agents (ICSE 2025) -- https://arxiv.org/abs/2403.15852

[10] Pirouzkhah, Wurzel Goncalves, Bacchelli -- The Value of Effective Pull Request Description (2026) -- https://arxiv.org/abs/2602.14611

[11] Cambronero et al. -- Abstain and Validate: A Dual-LLM Policy for Reducing Noise in Agentic Program Repair (ICSE 2025) -- https://arxiv.org/abs/2510.03217

[12] Oliveira et al. -- AI-Assisted Code Review as a Scaffold for Code Quality (2026) -- https://arxiv.org/abs/2604.23251

[13] OWASP Code Review Guide v2 -- https://owasp.org/www-project-code-review-guide/

[14] Swarmia -- A Complete Guide to Code Reviews -- https://www.swarmia.com/blog/a-complete-guide-to-code-reviews/

---

## Appendix A: Priors Ledger

See: `/Users/etienneb/git/personal/workrail/research/exceptional-mr-review/priors-ledger.json`

Key status changes:
- P8 (steelman/false-positive suppression): PARTIALLY FALSIFIED
- P4 (LLM failure modes): CORROBORATED
- P5 (Google 9 dimensions): CORROBORATED
- P12 (0.44-0.62 figure): CORROBORATED with nuance

## Appendix B: Source Map

See: `/Users/etienneb/git/personal/workrail/research/exceptional-mr-review/source-map.md`

8 sources (deep mode cap): Chelsea Troy, Google Engineering Practices, EASE 2026, Bacchelli & Bird 2013, Bosu et al., Pragmatic Engineer, Trail of Bits, Prompt Engineering for Code Review.

## Appendix C: Dependency Matrix

See: `/Users/etienneb/git/personal/workrail/research/exceptional-mr-review/dependency-matrix.json`

Regime: depth_serial. Topological order: SQ1 -> SQ2 -> SQ3 -> SQ4 -> SQ5 -> SQ6.

## Appendix D: Gap Analysis Log

See: `/Users/etienneb/git/personal/workrail/research/exceptional-mr-review/gap-analysis.md`

Loop decision: STOP after pass 1. SQ1 and SQ3 resolved. SQ2, SQ4, SQ5, SQ6 partial. Remaining gaps are synthesis gaps, not collection gaps.
