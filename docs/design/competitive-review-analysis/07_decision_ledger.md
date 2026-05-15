# Decision Ledger: wr.mr-review Quality Overhaul Roadmap

*Decision target: roadmap_prioritization for the wr.mr-review quality overhaul.*
*Hard constraints: at most 3 urgent items, at most 1 changes-positioning item. No TBD verdicts.*

---

## Decision Rows

| Finding | Source Confidence | Verdict | Rationale | Owner |
|---|---|---|---|---|
| Two-pass self-reflection: generate findings then score 0-10 and re-rank in a second LLM call (PR-Agent). Directly adoptable technique. | verified (C01) | urgent | Directly addresses shallow findings gap. Low adoption complexity: one extra LLM call on same context. PR-Agent ships this in production today. Single highest-ROI change to finding quality. | wr.mr-review workflow author |
| Confidence constraint prompt language: "do not flag unless you can identify the specific affected code path from the diff context" (PR-Agent system prompt, directly read). | verified (C02) | urgent | Directly addresses false positives. Zero infrastructure cost: modify reviewer family prompts. #1 user complaint is signal-to-noise. This constraint is why PR-Agent's max-3-findings output is trusted. | wr.mr-review workflow author |
| Volume discipline: cap findings per reviewer family at N (default 3, PR-Agent). No equivalent cap in wr.mr-review. | verified (C03, C19) | urgent | False positives are #1 user complaint (multiple independent sources). A reviewer that cries wolf gets disabled. Enforcing volume caps is a required safety property, not an optional quality improvement. | wr.mr-review workflow author |
| Structured output with per-finding line numbers (start_line, end_line, relevant_file) enabling precise inline GitHub comments (PR-Agent Pydantic schema, directly read). | verified (C06) | backlog | Our typed verdict path should require this schema. Medium complexity: requires output contract update and comment posting integration. Important but not the first fix. | wr.mr-review schema + engine |
| Codebase-specific instructions via config file (AGENTS.md, .pr_agent.toml, or equivalent) loaded as reviewer context. Currently wr.mr-review reviewer families have no codebase-specific knowledge. | verified (C11, C09) | backlog | Addresses reviewer-families-not-codebase-specific gap. Medium complexity: need to define where the config lives, how it's loaded, how reviewer families receive it. PR-Agent community shipping this within months (C09). | wr.mr-review runtime + docs |
| Ticket compliance reviewer family: validate PR against linked issue requirements (TicketCompliance: fully-compliant, not-compliant, requires-human-verification). Entirely absent from wr.mr-review. | verified (C07) | backlog | High-value reviewer family, completely missing. Medium complexity: requires Jira/GitHub/Linear API integration. Delivers immediate value for teams with formal issue-tracking workflows. | wr.mr-review workflow author |
| Asymmetric dynamic context: expand context to enclosing function/class boundary before change (max 8 extra lines), minimal after (1 extra line). Better than raw diff lines. | verified (C04) | backlog | Addresses context quality for diff-read reviewers. Medium complexity: requires diff post-processing before prompt construction. Important but not first priority vs prompt-level changes. | wr.mr-review diff preprocessing |
| Large-PR compression: language-prioritized, token-aware, deletion-deprioritized. No equivalent in wr.mr-review - likely truncating silently on large PRs. | verified (C05) | backlog | Important for correctness on large PRs. Medium complexity: requires tokenization and file-ranking logic. Backlogged behind volume/quality improvements. | wr.mr-review diff preprocessing |
| Static tool integration: deterministic first pass (secret scanning, SAST, linters) before LLM review. Catches entire categories cheaply and reliably. | verified (C14) | backlog | High coverage value but high adoption complexity. Requires tool infrastructure. Backlogged as a Phase 2 addition after prompt quality improvements. | wr.mr-review tool integration |
| Prompt injection (AWI): PR content injected into agent prompts is an exploitable attack surface. 496 real-world confirmed vulnerabilities in GitHub Actions agentic workflows. | verified (C22) | backlog | Real security risk, not theoretical. Medium complexity: sanitize PR content before embedding in prompts. Backlogged behind immediate quality fixes but should not slip past the next major release. | wr.mr-review security |
| Incremental review: review only commits added since last review, not full diff on re-push. Currently wr.mr-review runs fresh session on every trigger. | verified (C08) | backlog | Addresses re-review noise. Medium-high complexity: requires commit-boundary tracking across sessions. Important but less critical than finding quality. | wr.mr-review engine + sessions |
| Google Eng Practices: reviewers must read every line; look at whole file for context; evaluate 9 dimensions: design, functionality, complexity, tests, naming, comments, style, documentation, context/system health. | verified (C23, C24) | backlog | Useful as reviewer family coverage audit: do our families cover all 9 dimensions? "Tests validity" and "context/system health" are likely gaps. No urgent action but should drive family design. | wr.mr-review workflow author |
| PR-Agent community shipping MCP integration, AGENTS.md support, repo-rule review, and SKILL.md - all within last 30 days. | likely (C09) | backlog | Timeline: 6-12 months to ship and adopt (not 60-90 days - per red hat revision). Not an immediate threat to differentiation. Monitor quarterly. | wr.mr-review strategy |
| "Review methodology enforcement" category frame is entirely unvalidated by user research. Zero evidence of users asking for this category. | unconfirmed (06_red_hat) | changes-positioning | This is the ACH Alternative Hypothesis 1 disconfirmation requirement. Before committing to "methodology enforcement" as the positioning story, validate with 3-5 team conversations in the target segment (high-risk engineering teams with formal review requirements). If they don't recognize the job, repivot to "finding quality" as the lead value proposition. | wr.mr-review product strategy |
| CodeRabbit CI/CD pipeline analysis closes regression detection loop architecturally - connects CI failure to specific PR lines. Missed in synthesis as a solution to pre-existing/regression gap. | verified (06_red_hat rebuttal) | backlog | Red hat point incorporated: CI feedback is one architectural path to regression detection. For wr.mr-review, this is a future integration direction. Not immediately actionable without CI output access. | wr.mr-review roadmap |
| EASE 2026: cannot use developer fix/wontFix as primary quality metric. 0.44-0.62 agreement only. Need blind review panels or known-bug injection. | verified (C20) | backlog | Affects how we measure wr.mr-review quality. Need alternative evaluation approach before claiming quality improvements. | wr.mr-review evaluation |
| Greptile "4x merge, 3x bug" claims - [unverified-vendor-claim], no independent benchmark. | unconfirmed (C26) | ignore | No independent evidence. Marketing claim only. Not actionable for roadmap. |  |

---

## Constraint Check

- Urgent items: 3 (two-pass self-reflection, confidence constraint prompt language, volume discipline cap) - exactly at limit.
- Changes-positioning items: 1 (category frame validation) - exactly at limit.
- TBD verdicts: 0.

---

## Adversarial Points Addressed (from 06_red_hat_critique.md)

| Adversarial Point | Disposition | Notes |
|---|---|---|
| PR-Agent convergence timeline overstated (60-90 days -> 6-12 months) | Incorporated | Decision ledger entry revised accordingly. C09 rated "likely" not "verified". |
| "CodeRabbit is not our competitor" is too clean | Incorporated | Battlecard rephrased to "partially overlapping category." We lose when described honestly. |
| Step enforcement with shallow methodology is worse than no enforcement | Incorporated | "We Lose When #3" and urgent finding quality items (self-reflection, confidence constraints, volume caps) directly address this. |
| Durable session state only valuable if session content is valuable | Incorporated | "We Win When #1" explicitly tied to formal audit requirements, not just architectural pride. |
| "Methodology enforcement" category unvalidated | Incorporated | Decision ledger "changes-positioning" item requiring user research. |
| Contradiction: medium-high confidence + weakly-supported assumption | Incorporated | Battlecard revises threat confidence. ACH alternative hypotheses in 06_red_hat acknowledged. |
| JTBD frame and premortem contradict each other | Partially addressed | Battlecard explicitly separates "win when" (methodology matters) from "lose when" (finding quality is all that matters). Full resolution requires user research validation. Surfaced as changes-positioning item. |
| Change Stack ordering is an agent problem too | Incorporated | Added to backlog: "asymmetric dynamic context" partially addresses but doesn't fully solve ordering. Future roadmap item. |
| CodeRabbit learnings creates compounding switching costs | Noted | Not a decision ledger item (we can't prevent CodeRabbit adoption). Surfaced as awareness item for roadmap framing. |

---

## Reviewer Notes (Unanswered Adversarial Points)

**Unanswered: ACH Alternative Hypothesis 2** - "CodeRabbit is the actual near-term threat because the agentic exploration gap is fatal" - was not resolved. The disconfirming evidence required (CodeRabbit false positive rate on full-repo-access vs diff-only, and whether $48/dev/mo is already acceptable to target segment) was not collected. This remains an open question. If the target segment already has CodeRabbit, the competitive question changes entirely. Recommended: ask "do you use CodeRabbit?" in any user research conversations.
