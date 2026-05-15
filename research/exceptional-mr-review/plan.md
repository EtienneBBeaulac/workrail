# Research Plan -- Exceptional MR Review

Mode: deep | Regime: depth_serial | Sub-questions: 6 | Subagent cap: 10 | Per-subagent token budget: 25,000

## Execution Order (topological)

SQ1 -> SQ2 -> SQ3 -> SQ4 -> SQ5 -> SQ6

---

## SQ1: What great human reviewers do differently

**Task:** Fetch Google Engineering Practices review guide (all pages), Chelsea Troy's code review posts, and Gergely Orosz / Pragmatic Engineer on review culture. Extract: dimensions checked, mental models used, sequencing of concerns, how reviewers handle knowledge gaps.

**Sources to prioritize:** S1 (Chelsea Troy), S2 (Google), S6 (Pragmatic Engineer)

**Stop rule:** Min 3 fetches AND 2 consecutive zero-novelty fetches OR token budget hit (25k tokens)

**Token budget:** 25,000

**Key questions to answer:**
- What are the named dimensions great reviewers check? (not just "correctness")
- How do reviewers handle parts of the diff they don't fully understand?
- What order do expert reviewers read a diff in?
- What do reviewers ask themselves before writing a finding?

---

## SQ2: Empirical evidence on what review comments are actually useful for

**Task:** Fetch Bacchelli & Bird 2013 (ICSE), Bosu et al. on useful review comments. Extract: distribution of review value across correctness/design/style/maintainability, what percentage of comments authors actually act on, what distinguishes actionable from noise.

**Sources to prioritize:** S4 (Bacchelli & Bird), S5 (Bosu et al.)

**Stop rule:** Min 3 fetches AND 2 consecutive zero-novelty fetches OR token budget hit

**Token budget:** 25,000

**Key questions to answer:**
- What fraction of review value is: correctness vs. design vs. style vs. maintainability?
- What makes a review comment actionable vs. ignored?
- What do authors say they want from reviewers vs. what reviewers actually provide?

---

## SQ3: Documented failure modes of LLM code reviewers

**Task:** Search for and fetch EASE 2026 paper on LLM code review, plus arXiv papers on LLM PR review quality. Verify the 0.44-0.62 developer agreement figure. Extract: categorized failure modes, frequency data, which failure modes are most impactful.

**Sources to prioritize:** S3 (EASE 2026 / academic LLM review papers)

**Stop rule:** Min 3 fetches AND 2 consecutive zero-novelty fetches OR token budget hit

**Token budget:** 25,000

**Key questions to answer:**
- What are the empirically documented failure modes? (categorized, with frequency if available)
- Is the 0.44-0.62 developer agreement figure real and what does it mean precisely?
- Do LLM reviewers perform better on some dimensions (style, syntax) than others (design, intent)?
- What is the false positive rate? What types of false positives are most common?

---

## SQ4: Prompt and instruction techniques that improve LLM review quality

**Task:** Search arXiv and GitHub research for "LLM code review prompt", "chain-of-thought code review", "role-based code review agent". Fetch Trail of Bits security review mental models. Extract: which techniques have empirical support, which are speculative, what the effect sizes are.

**Sources to prioritize:** S7 (Trail of Bits), S8 (Prompt engineering for code review)

**Stop rule:** Min 3 fetches AND 2 consecutive zero-novelty fetches OR token budget hit

**Token budget:** 25,000

**Key questions to answer:**
- Which prompt techniques have demonstrated improvement in LLM review quality? (with evidence)
- Does role-specific prompting (security reviewer vs. correctness reviewer) help?
- Does steelman-before-criticize reduce false positive rate?
- Does explicit false-positive suppression instruction help?
- What does security review training teach about adversarial reading technique?

---

## SQ5: Reviewer specialization structure

**Task:** Synthesize from SQ1, SQ2, SQ4 findings. Research how Stripe, Anduril, Figma, Linear structure their review processes. Identify natural role boundaries that maximize signal and minimize overlap noise.

**Sources to prioritize:** S6 (Pragmatic Engineer), S7 (Trail of Bits), plus any Stripe/Figma/Linear eng blog posts found

**Stop rule:** Min 2 fetches AND 2 consecutive zero-novelty fetches OR token budget hit

**Token budget:** 25,000

**Key questions to answer:**
- What are the natural specialization boundaries? (security, correctness, design, performance, completeness)
- How do specialized reviewers hand off to each other?
- What overlap should be expected and accepted vs. deduplicated?
- What context does each specialist need that the others don't?

---

## SQ6: Workflow structural guardrails

**Task:** Synthesize SQ3-SQ5 to identify what the wr.mr-review workflow structure must enforce. Enumerate specific failure modes that require structural prevention (not just prompt instruction). Map to concrete workflow design decisions.

**Sources to prioritize:** Internal -- synthesizes all prior sub-questions

**Stop rule:** Synthesis complete when all SQ3-SQ5 findings have been mapped to workflow design implications

**Token budget:** 25,000

**Key questions to answer:**
- Which LLM failure modes require workflow structure to prevent (not just prompting)?
- What must be enforced at the step level vs. the prompt level?
- What output contracts does each reviewer role need?
- What does the synthesis step need to enforce to prevent verbosity and false positive accumulation?

---

## Output artifacts

Per sub-question: `sq{N}-findings.md` in `/Users/etienneb/git/personal/workrail/research/exceptional-mr-review/`

Final synthesis brief: `/Users/etienneb/git/personal/workrail/docs/design/mr-review-overhaul/research-exceptional-mr-review.md`
