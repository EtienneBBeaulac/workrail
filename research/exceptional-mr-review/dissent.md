# Dissent: Challenging the BLUF and Finding F1

## Adversarial Review of brief.md

Using ONLY the evidence in brief.md, claims/, priors-ledger.json, and source-map.md.

---

## Argument Against the BLUF

The BLUF states: "Great human reviewers check intent and design first, ask questions when they don't understand code, and distinguish blocking issues from non-blocking suggestions."

**The challenge:** The evidence base for this claim is dominated by prescriptive guides (Google Engineering Practices, Gergely Orosz blog), not observational studies of what reviewers ACTUALLY do. The Bacchelli & Bird 2013 paper -- the one empirical study that examined what reviewers actually do at scale -- is NOT directly accessed. Its findings are inferred from secondary sources (claims SQ2-C2, SQ2-C3 are both tagged "inferred," not "single-source" or "verified"). The gap between what a prescriptive guide SAYS reviewers should do and what they ACTUALLY DO is precisely the gap that Bacchelli & Bird measures -- and their finding was that developer expectations about finding bugs are often unmet in practice. If the empirical paper shows that even human reviewers fail to do what the guides prescribe, then building an LLM reviewer architecture around the guide's prescriptions is building on unvalidated assumptions about human reviewer behavior.

The BLUF's claim about "intent and design first" is drawn from the Google guide (verified) and Gergely Orosz (single-source). Neither source presents empirical data on whether this ordering produces better outcomes -- they are practitioner opinions that happen to align. The BLUF conflates "what great reviewers should do" with "what great reviewers do and what demonstrably improves outcomes."

---

## Strongest Argument Against F1: "Exceptional reviewers check intent and system impact BEFORE correctness"

**The evidence base for F1 is entirely prescriptive, not empirical.**

Every source cited for F1 is a prescriptive guide or practitioner opinion:
- Google Engineering Practices: a guide written by Google engineers describing what they BELIEVE works. There is no empirical study cited showing that following this sequence produces better outcomes than alternative sequences.
- Gergely Orosz: a practitioner blog post. The author draws on experience at Uber and Skyscanner, but this is anecdote, not data. The claims about "better reviews check the change in the context of the larger system" are opinions, not measurements.
- Chelsea Troy: explicitly flagged as [unconfirmed -- single source] in the brief itself.

**The specific claim "ask questions instead of writing findings when you don't understand" is not supported by any study showing this behavior correlates with better review outcomes.** It is stated as a principle in the Google guide (SQ1-C9) but the guide does not present evidence that reviewers who ask questions catch more issues or produce better outcomes than reviewers who write tentative findings and iterate.

**There is a plausible counter-argument:** A reviewer who writes a tentative finding ("I'm not sure, but this looks like it might have a race condition in the concurrent access to X") creates a discussion that may reveal the issue. A reviewer who asks a question ("Can you explain how concurrent access to X is handled?") may also reveal the issue. It is not obvious from the evidence base which approach is more effective. The brief asserts a hierarchy (questions before findings) without empirical support for why questions-first produces better outcomes.

**The 40% improvement claim (F2) does NOT corroborate F1.** The Sphinx paper demonstrates checklist-based training improves coverage -- but a checklist is a tool for ensuring completeness, not for sequencing intent-before-correctness. The checklist improvement is about not missing things, not about the order in which things are checked. F1 and F2 are independent claims; the strength of F2 should not be read as corroborating F1.

---

## The Single Weakest Claim in the Brief

**Weakest claim: F5 -- "The correct decomposition is 4 roles in a defined execution order" [confidence: M]**

This is the most load-bearing claim for the wr.mr-review overhaul design (it determines the workflow structure) and has the weakest evidence:

1. **The 4-role decomposition is a synthesis claim with no direct source.** Looking at claim SQ5-C6: "Optimal 4-role specialization... [synthesis]." The source is "synthesis" -- not any paper or guide. The 5 dimensions from Sphinx (SQ5-C3) are NOT the same as the proposed 4 roles. Sphinx uses: functional correctness, robustness, security, coding conventions, architectural alignment. The brief proposes: Intent & Design, Correctness & Completeness, Security, Maintainability & Style. These are different decompositions, and the brief does not explain why the proposed decomposition is superior to the Sphinx decomposition, or to other decompositions.

2. **The SOEN-101 evidence is explicitly noted as "adjacent task" not code review.** SOEN-101 measures code GENERATION quality, not code REVIEW quality. The transfer of the specialization benefit from generation to review is assumed, not demonstrated.

3. **There is no evidence that 4 roles is better than 3 or 6.** The Google guide cites specific complex concerns (privacy, security, concurrency, accessibility, internationalization -- at least 5 specialist types). The Sphinx paper uses 5 dimensions. The brief proposes 4 roles. The choice of 4 is arbitrary within the evidence base.

4. **The ordering constraint ("INTENT & DESIGN must go first") is derived from a single Google guide observation** (SQ6-C2, SQ6-C8) about early termination for design problems. While intuitively compelling, no study measures whether forcing this sequential constraint improves outcomes vs. letting all reviewers run in parallel and then synthesizing.

---

## What Would Falsify the Brief

- A study showing that reviewers who start with line-by-line correctness (not broad view) catch more issues -- this would falsify F1.
- A study showing that generalist LLM reviewers with a checklist outperform specialized role-based reviewers -- this would falsify F5.
- Access to the full Bacchelli & Bird 2013 paper showing that the "design first" principle is not what expert reviewers actually practice -- this would partially falsify both F1 and the BLUF.
- A study showing that checklist-based prompting of general-purpose LLMs (without the CRPO training) achieves comparable improvement -- this would weaken the implementation implication of F2 (the Sphinx result is from a fine-tuned model, not just a prompted one).

---

## Summary

The brief is built primarily on prescriptive practitioner guides (F1, F5), one strong empirical paper on a narrow LLM evaluation problem (F3, EASE 2026), and one paper on model training technique (F2, Sphinx). The BLUF is directionally correct but overstates the certainty: it presents as resolved principles what are in fact well-regarded practitioner hypotheses supported by practitioner consensus, not controlled outcomes research. The specific 4-role decomposition in F5 is the most actionable but least justified claim -- it should be presented explicitly as a design hypothesis to be validated, not as a finding from the research.
