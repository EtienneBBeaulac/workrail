# Source Plan: Code Review Excellence Research

## Standing Rules (All Subagents Must Apply)

**Rule 1 - shipped_vs_announced:** Only count what is demonstrably shipped. Evidence required: release notes with a date, changelog entry, live feature in docs, or user screenshot/report. Vendor blog posts and press releases are LOW SIGNAL without corroboration. Announcements labeled "coming soon," "beta," or "roadmap" are excluded from the findings column and tagged `[unshipped]`.

**Rule 2 - marketing_vs_user:** Every vendor landing-page claim must be paired with an independent user artifact before it enters findings. Accepted user artifacts: G2/Capterra/TrustRadius reviews, Reddit/HN threads by non-employees, GitHub issues filed by users, Wayback-captured prior states. If no user artifact is findable, the claim is tagged `[unverified-vendor-claim]`.

---

## Subject Scope

This research covers the full ecosystem of code review excellence, not a single competitor:

1. AI-powered PR review tools: CodeRabbit, Qodo (formerly CodiumAI/PR-Agent), Greptile, Graphite, GitHub Copilot PR summaries, Sourcegraph Cody, Entelligence, Review Bot, Sweep
2. Human review methodology: Google eng practices, Chromium review culture, Stripe/Netflix/Linear/Netlify engineering blogs on review quality
3. Academic/research: LLM-based review papers, automated bug-finding (static analysis, symbolic execution)
4. Community techniques: public prompts and CLAUDE.md/AGENTS.md patterns for code review, community Cursor rules, shared agent workflows
5. Engine improvements implied by the above: sub-agent spawning, codebase-aware search, pre-existing vs regression distinction

**Decision target:** roadmap_prioritization for the wr.mr-review quality overhaul.

**Our gap context (keep in mind throughout):**
- Single-session diff-read: no targeted codebase investigation mid-review
- No pre-existing vs regression distinction (old bugs incorrectly attributed to PRs)
- Reviewer families are broad, not codebase-specific
- typed verdict path only recently enforced

---

## Source Inventory by Tier

### TIER 1 - HIGH SIGNAL (primary evidence)

#### 1a. Shipped product documentation and changelogs

| Source | URL | What to expect | Reachability |
|---|---|---|---|
| CodeRabbit changelog | https://docs.coderabbit.ai/changelog | Dated feature releases (multi-repo analysis, Change Stack, learnings, AST path instructions, CI/CD pipeline analysis, 40+ static tools) | HIGH - confirmed accessible, fetched May 2026 entries |
| PR-Agent (open-source) configuration.toml | https://raw.githubusercontent.com/the-pr-agent/pr-agent/main/pr_agent/settings/configuration.toml | Complete feature set (PR compression, dynamic context, self-reflection, ticket context, incremental review) | HIGH - raw file, fully readable |
| PR-Agent reviewer prompts | https://raw.githubusercontent.com/the-pr-agent/pr-agent/main/pr_agent/settings/pr_reviewer_prompts.toml | Exact prompts used for LLM review, Pydantic output schema (KeyIssuesComponentLink, TicketCompliance, etc.) | HIGH - raw file, fully readable |
| PR-Agent docs | https://docs.pr-agent.ai | Feature coverage (dynamic context, self-reflection, compression strategy, ticket context) | HIGH - confirmed accessible |
| CodeRabbit docs index | https://docs.coderabbit.ai/llms.txt | Complete feature inventory (multi-repo, learnings, Change Stack, CI/CD analysis, AST grep, path instructions, slop detection) | HIGH - confirmed accessible |
| Google Eng Practices | https://google.github.io/eng-practices/review/ | Canonical human review methodology (design, functionality, complexity, tests, naming, comments, style, context) | HIGH - confirmed accessible |

#### 1b. Open-source codebases (behavioral signal)

| Source | What to extract | Reachability |
|---|---|---|
| the-pr-agent/pr-agent (GitHub) | Review prompt structure, compression algorithm, self-reflection implementation, dynamic context code | HIGH - public repo |
| coderabbitai GitHub app repos | Release notes, issue tracker user reports | MEDIUM - app repo may be private |

#### 1c. User reviews and community signal (independent evidence)

| Source | Signal type | Reachability |
|---|---|---|
| Reddit r/programming, r/devops threads on CodeRabbit, PR-Agent | User complaints and praise not present in vendor docs | MEDIUM - searchable |
| Hacker News discussions on AI code review | Technical community assessment, real adoption patterns | MEDIUM - searchable via hn.algolia.com |
| GitHub Issues on the-pr-agent/pr-agent | Bugs users actually hit, missing features requested | HIGH - public issue tracker |
| G2/Capterra reviews for CodeRabbit, Qodo | Structured user ratings with specific praise/complaints | MEDIUM - some behind login |

---

### TIER 2 - MEDIUM SIGNAL (corroborating evidence)

#### 2a. Vendor product pages and architecture docs

| Source | URL | What to expect | Filter applied |
|---|---|---|---|
| CodeRabbit architecture page | https://docs.coderabbit.ai/overview/architecture | "Sandboxed cloud execution, multi-dimensional analysis, agentic exploration, specialized AI agents in parallel, living memory" | Verified against changelog (these features have dated release entries) |
| CodeRabbit learnings page | https://docs.coderabbit.ai/knowledge-base/learnings | How feedback loop works: chat -> learning stored -> applied to future reviews. Natural-language preferences scoped to repo or org | VERIFIED - detailed implementation docs present |
| CodeRabbit multi-repo analysis | https://docs.coderabbit.ai/knowledge-base/multi-repo-analysis | Cross-repo API contract detection, schema change detection | VERIFIED - configuration docs present |
| CodeRabbit Change Stack | https://docs.coderabbit.ai/pr-reviews/change-stack | Diff reorganized into cohorts+layers, keyboard nav, range-specific AI summaries, diagrams for call flows | VERIFIED - early access, shipping |
| Greptile product page | https://www.greptile.com/blog/code-review | Codebase-indexed review with semantic search into full repo | LOW SIGNAL - marketing page only, no independent corroboration found |
| Graphite | https://graphite.dev | Stacked PRs + review tools | MEDIUM - needs independent corroboration |

#### 2b. Academic / research papers

| Paper | Signal | Status |
|---|---|---|
| "Understanding the Limits of Automated Evaluation for Code Review Bots in Practice" (EASE 2026, arXiv:2604.24525) | Industrial study: 2,604 bot comments from Beko, LLM-as-a-Judge achieves only 0.44-0.62 agreement with developer labels. Developer actions (fix/wontFix) are confounded by organizational pressure. | HIGH SIGNAL - peer-reviewed, EASE 2026 |
| "PatchGuru: Patch Oracle Inference from Natural Language Artifacts with LLMs" (arXiv:2602.05270) | LLM extracts developer intent from PR NL artifacts, synthesizes runtime assertions, iteratively refines via pre/post patch comparison. 62% precision, found 12 unknown bugs. | HIGH SIGNAL - addresses our pre-existing vs regression gap directly |
| "Demystifying and Detecting Agentic Workflow Injection Vulnerabilities in GitHub Actions" (arXiv:2605.07135) | Security signal: untrusted PR content injected into agent prompts. Relevant to wr.mr-review security posture. | MEDIUM SIGNAL |
| "Software Testing with LLMs: Survey" (IEEE TSE, arXiv:2307.07221) | Survey of 102 LLM+testing studies; test case preparation and program repair are most common. Prompt engineering analysis. | MEDIUM SIGNAL - broad survey, useful for technique inventory |

#### 2c. Human review methodology

| Source | Signal | Reachability |
|---|---|---|
| Google Eng Practices - What to look for | Reviewed: design, functionality (edge cases, concurrency), complexity (over-engineering), tests (validity, not just presence), naming, comments, style, documentation, context (whole-file view, system health) | HIGH - confirmed accessible, fetched |
| Google Eng Practices - CL author guide | Reviewer selection, in-person review norms, "every line" reading norm | HIGH - confirmed accessible |
| Chromium code review guide | Similar to Google, Gerrit-based, stricter ownership model | MEDIUM - publicly accessible |
| Chelsea Troy "Reviewing Code You Don't Understand" | Technique for domain-unfamiliar reviewers: ask questions to force explanation | MEDIUM - blog post |
| Dan Luu on thoroughness | Thoroughness metrics, cost of shallow review | MEDIUM - blog post |

---

### TIER 3 - LOW SIGNAL (excluded from findings unless corroborated)

| Source | Why low signal |
|---|---|
| Vendor press releases ("CodeRabbit raises $X") | No feature signal, no user evidence |
| Twitter/X founder posts | Vaporware risk, no shipped evidence |
| Analyst reports on AI code review market | Generic, lagging, marketing-adjacent |
| Greptile "merge 4x faster, catch 3x more bugs" headline | [unverified-vendor-claim] - marketing page only, no independent benchmark |
| Entelligence website | Not enough independent user evidence found; company relatively new |

---

## Planned Approach by Tier

### High-signal sources (execute in research phase)

1. **PR-Agent open source deep-read:** Read the complete reviewer prompt (confirmed accessible), configuration defaults, self-reflection implementation. These are the ground truth for what's actually shipped. Extract: output schema, review categories, compression strategy, dynamic context algorithm, ticket context integration, self-reflection scoring.

2. **CodeRabbit docs deep-read:** Architecture page + learnings + multi-repo analysis + Change Stack + CI/CD pipeline analysis. Identify what's confirmed shipped vs early-access.

3. **Google Eng Practices full read:** Complete what-to-look-for guide, CL author guide. Map their eight review dimensions to our reviewer family model. The "context" section is especially relevant to our single-session gap.

4. **arXiv papers (EASE 2026, PatchGuru):** Both are directly relevant. EASE 2026 paper gives us ground truth on evaluation difficulty. PatchGuru gives us a technique for pre-existing vs regression detection worth studying.

5. **GitHub issue tracker for pr-agent:** Check open issues for user pain points. High-signal for what users actually care about vs what vendors claim.

### Medium-signal sources (corroborate, don't lead with)

- Reddit/HN threads: search for user experience reports on CodeRabbit and PR-Agent. Use to validate or challenge vendor claims.
- Academic survey (arXiv:2307.07221): use for technique inventory, not as evidence of what works in practice.
- Chromium and human review methodology blogs: use to map best human review practices to wr.mr-review gaps.

### Capability note

Web access confirmed available. Direct URL fetch succeeded for all high-signal sources listed above. No delegation to subagents needed for source collection - direct fetch is faster and preserves chain of evidence. Synthesis remains with the main agent.

---

## Gap-to-Source Mapping

| Our gap | Primary source to address it |
|---|---|
| Single-session diff-read / no codebase investigation | CodeRabbit agentic exploration + multi-repo docs; Greptile codebase-indexing approach; Google "context" section |
| No pre-existing vs regression distinction | PatchGuru paper (arXiv:2602.05270); PR-Agent incremental review feature |
| Reviewer families not codebase-specific | CodeRabbit learnings + path-based instructions + code guidelines; PR-Agent `extra_instructions` + wiki/repo settings |
| Shallow findings (keyword routing was fallback) | PR-Agent self-reflection + scoring; PR-Agent prompt schema with confidence constraints; CodeRabbit slop detection |

---

## Source Quality Assessment Summary

**Highest confidence sources confirmed reachable:**
- PR-Agent open-source codebase (prompt, config, docs) - directly readable, ground truth
- Google Eng Practices - confirmed, canonical
- CodeRabbit docs (changelog, learnings, architecture, Change Stack, multi-repo) - confirmed, dated entries
- EASE 2026 paper (arXiv:2604.24525) - peer-reviewed, directly applicable
- PatchGuru paper (arXiv:2602.05270) - peer-reviewed, directly applicable

**Sources requiring independent corroboration before use:**
- Greptile claims (codebase indexing approach) - only marketing page accessible so far
- Graphite review features - limited docs accessible
- Entelligence - insufficient evidence found

**Excluded from findings:**
- Vendor press releases, analyst reports, founder tweets
- Any claim tagged `[unverified-vendor-claim]` that lacks a matching user artifact
