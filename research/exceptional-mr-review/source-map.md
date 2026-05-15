# Source Map -- Exceptional MR Review Research

Mode: deep | Cap: 8 entries

## S1: Chelsea Troy -- Code Review Writing
**URL pattern:** https://chelseatroy.com (search "code review")
**Rationale:** Primary practitioner source on reviewing code you don't fully understand -- directly relevant to the reviewer specialization and knowledge-gap sub-questions. Influential in the practitioner community.

## S2: Google Engineering Practices -- Code Review Guide
**URL:** https://google.github.io/eng-practices/review/reviewer/
**Rationale:** Canonical written reference for 9 review dimensions. Defines the baseline of "what great reviewers check" against which LLM behavior can be measured. Authoritative, widely cited.

## S3: EASE 2026 / Academic LLM Code Review Papers
**URL pattern:** ACM Digital Library, arXiv (search "LLM code review quality EASE 2026", "LLM pull request review")
**Rationale:** The 0.44-0.62 developer agreement figure comes from here. Primary empirical evidence on LLM review failure modes. Must verify the specific paper and figures exist.

## S4: Bacchelli & Bird 2013 -- "Expectations, Outcomes, and Challenges of Modern Code Review"
**URL pattern:** https://dl.acm.org (search "Bacchelli Bird code review 2013 ICSE")
**Rationale:** Foundational empirical study on what human reviewers actually find vs. what they expect to find. Baseline for understanding the gap between reviewer intent and outcome.

## S5: Bosu et al. -- What Review Comments Are Actionable
**URL pattern:** https://dl.acm.org (search "Bosu useful code review comments")
**Rationale:** Empirical work on what makes review comments actionable vs. noise -- directly maps to the LLM verbosity / signal-to-noise failure mode.

## S6: The Pragmatic Engineer -- Gergely Orosz on Review Culture
**URL pattern:** https://newsletter.pragmaticengineer.com (search "code review")
**Rationale:** Practitioner-level synthesis of how high-performing engineering orgs (Stripe, Uber, etc.) structure review. Bridges academic and industry perspectives.

## S7: Trail of Bits / Security Review Mental Models
**URL pattern:** https://blog.trailofbits.com (search "code review security")
**Rationale:** Security reviewers represent the most adversarial, highest-stakes review specialization. Their mental models (threat modeling from diff, blast radius reasoning) are transferable to general review quality.

## S8: Prompt Engineering for Code Review -- Academic / Applied
**URL pattern:** arXiv (search "prompt code review LLM chain-of-thought"), GitHub Copilot research blog
**Rationale:** Direct evidence on which prompt techniques (checklist, steelman, role-specific prompts, CoT) improve LLM review quality. Contrarian source: some papers show minimal improvement, important to surface.
