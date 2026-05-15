# Category Positioning Brief: wr.mr-review

*Note: Per workflow divergence rules for alternative_approach type, this battlecard is repurposed as a category positioning brief. The central question: are we in the same category as CodeRabbit and PR-Agent, or is a new category frame needed?*

---

## What each product is (one-line descriptions)

- **CodeRabbit:** An AI reviewer platform that clones your full repository and reviews every PR with parallel specialized agents, static tools, and a learnings system that gets smarter with each review cycle. (~24 words)
- **PR-Agent (open-source):** A fast, configurable, BYOK open-source AI reviewer that produces structured findings with confidence constraints in a single LLM call (~30 seconds). (~23 words)
- **wr.mr-review:** A workflow-enforced AI review agent that applies a specific sequence of review concerns to a PR, producing durable session state with step-level accountability. (~25 words)

---

## Are we in the same category?

**Short answer: adjacent, with category frame disputed.**

The synthesis proposes: wr.mr-review is in "AI review methodology enforcement," not "AI code reviewer." The red hat critique challenges this: the user outcome (different review rules for different code areas) may be achievable with CodeRabbit today, making the category distinction a mechanism difference, not a user-perceivable one.

**The honest position:**

We are in a partially overlapping category. All three products answer the question "help me catch problems before merge." Where they differ:

- CodeRabbit and PR-Agent: the product is the output (findings). The methodology is a means.
- wr.mr-review: the product is the methodology (how the review is conducted). The findings are an output of the methodology.

This distinction matters to teams that have formal review requirements (security certifications, audit trails, reproducible methodology). It does NOT matter to teams that just want fewer bugs in production. We win in the first context; we lose in the second.

---

## We Win When

1. **The team has formal review requirements or audit needs.** Step enforcement produces a session log showing that the security review step was completed on PR #N, on date D, by agent version V. CodeRabbit and PR-Agent produce no equivalent artifact. Proof: durable session state is a WorkRail v2 architectural property, not an add-on (docs/design/v2-core-design-locks.md).

2. **The review methodology itself needs to evolve.** Teams that want to improve their review process over time - changing what families are applied, adjusting verdict thresholds, adding new reviewer concerns - can fork the workflow JSON, version it, and track what changed. CodeRabbit's equivalent (learnings system) is a natural-language blob that cannot be diffed, versioned, or reviewed. Proof: WorkRail workflow JSON is committed to version control by design.

3. **The PR is complex and the reviewer needs to not cut corners.** On high-stakes PRs (auth changes, schema migrations, security-critical paths), step enforcement means every concern is evaluated. A one-shot LLM reviewer can satisfy itself early and stop investigating. WorkRail's step tokens make it structurally impossible to skip. Proof: WorkRail v2 execution contract (docs/reference/workflow-execution-contract.md).

---

## We Lose When

1. **The team just wants fewer bugs and doesn't care how the review is conducted.** CodeRabbit's agentic exploration + 40 static tools + full repo clone will find more bugs in more places than wr.mr-review's diff-only, single-session review. If the user's JTBD is purely "catch problems before merge," CodeRabbit's approach is architecturally superior. Proof: CodeRabbit architecture doc (docs.coderabbit.ai/overview/architecture, verified C10); our single-session gap documented in evidence base C10/gap inventory.

2. **The team wants a reviewer that understands their codebase conventions without manual configuration.** CodeRabbit's learnings system stores team preferences from review conversations and applies them automatically. PR-Agent with AGENTS.md (shipping within 60-90 days per C09) will support codebase context files. wr.mr-review reviewer families are generic until someone manually encodes the invariants. Teams with no bandwidth to configure will get better out-of-box behavior from competitors. Proof: user complaint cluster C19 ("will it understand our codebase?"), CodeRabbit learnings (verified C11).

3. **Signal-to-noise discipline is not enforced in our workflow.** If wr.mr-review reviewer families produce more than ~3 findings per family, and we don't enforce volume caps, the output will trigger the same "disabled due to chattiness" failure mode documented in C19 (HN, 2025-12-21). PR-Agent defaults to max 3 findings (C03). We have no equivalent default. Proof: C19 (verified), C03 (verified).

---

## Top 3 Differentiators Tied to Switching Forces

1. **Step accountability (addresses inertia/moat).** Durable session state with per-step output is an audit artifact that single-shot tools cannot produce. For teams where "we did a security review" needs to be demonstrably true, not just asserted, WorkRail's architecture produces evidence.

2. **Methodology as code (addresses pull-toward-us).** The workflow JSON is the methodology. It can be reviewed, versioned, forked, and improved. No other tool encodes the review methodology in a machine-readable, version-controlled artifact. This is a different kind of value from "smarter findings."

3. **Workflow composability (addresses anxiety about lock-in).** A wr.mr-review workflow is portable. If the LLM backend changes, the methodology doesn't. If a new reviewer family is needed, it's added to the workflow JSON. Teams are not locked into a vendor's prompt design.

---

## Top 3 Landmine Discovery Questions

*(Derived from user complaints in 02c_user_voice.json)*

1. "Have you ever disabled an AI code review tool because it was too chatty or produced too many false positives?" - If yes, they've been burned and will be skeptical. You need to demonstrate volume discipline (max N findings) and confidence constraints before they'll trust another reviewer.

2. "How do you currently know whether an AI reviewer's finding was correct?" - If they say "we just check it," they don't have an evaluation framework. Tie this to the EASE 2026 finding (C20): developer fix/wontFix is confounded by workflow pressure. Offer: wr.mr-review's step output can be compared to known-good examples.

3. "What happens when your reviewer misses a bug that causes a production incident?" - This surfaces whether they have review accountability requirements. If yes: wr.mr-review's session log is the artifact that shows what was reviewed and what was found. If no: they may not be in our segment.

---

## Pricing Posture

- CodeRabbit: $24-48/dev/mo (official, verified). Full infrastructure included.
- PR-Agent: $0 BYOK (official, verified). You bring your own LLM keys.
- wr.mr-review: Part of WorkRail; pricing not established externally. Competing on value, not price, in the short term.

**Note:** At $48/dev/mo for a 10-person engineering team, CodeRabbit costs $480/mo. The value comparison is not feature-count; it is whether the audit trail + methodology enforcement is worth the delta.

---

## Objection - Response Pairs

**Objection 1: "CodeRabbit can do everything you do, and it has full-repo access."**
Response: CodeRabbit is excellent for finding bugs in the diff. wr.mr-review enforces that specific concerns are evaluated in a specific order with a verifiable record. If "we did a security review" needs to be demonstrable - not just "the AI reviewed it" - the session log matters. A reviewer with full-repo access that doesn't log what it reviewed is not an audit artifact; it's a black box.

**Objection 2: "PR-Agent is free and configurable. Why do we need another tool?"**
Response: PR-Agent's configuration is static - you set it up once and it applies a fixed prompt. wr.mr-review's workflow can branch, loop, and apply different reviewer families based on what's in the PR. It's the difference between a checklist (PR-Agent) and a protocol that can adapt based on what it finds. Also: PR-Agent produces max 3 findings per review. If you want to run 5 distinct reviewer families (correctness, architecture, security, performance, tests), you'd need 5 separate PR-Agent invocations; wr.mr-review orchestrates them in a single session.

**Objection 3: "We don't care about methodology enforcement - we just want fewer bugs."**
Response: That's legitimate - and if the primary goal is raw bug count, CodeRabbit's full-repo clone + 40 static tools will likely find more. Where we add value: the bugs we're targeting are the ones that require sequential reasoning (e.g., security reviewer needs to know the auth architecture before evaluating a crypto decision). Those are the findings that one-shot reviewers miss because they don't build context step by step. Also: PR-Agent's own research shows that one-shot generation is poor at ranking findings - two-pass scoring is better. Our step-by-step approach is the multi-step equivalent for review concerns, not just for findings.

---

## Confidence / Freshness Metadata

- Date: 2026-05-15
- Primary sources: CodeRabbit docs (May 2026 changelog, verified), PR-Agent prompts and config (raw files, verified), Google Eng Practices (verified), arXiv papers (EASE 2026, PatchGuru, AWI security), HN/Reddit (user voice, May 2026)
- Fields flagged as unconfirmed: Greptile claims (marketing only, [unverified-vendor-claim]), Qodo 2.0 features (no accessible docs), PR-Agent MCP + AGENTS.md (open PRs, not shipped)
- Red hat adversarial points incorporated: PR-Agent convergence timeline revised to 6-12 months (from 60-90 days); CodeRabbit dismissed as competitor revised to "partially overlapping"; step enforcement as only-safe-property challenged and acknowledged in "We Lose When #3"
