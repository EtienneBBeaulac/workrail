# Source Map

## Mode: deep (max 8 entries)

| # | Source | Type | Rationale |
|---|--------|------|-----------|
| S1 | Semgrep docs: `semgrep.dev/docs/semgrep-ci/` and `semgrep.dev/docs/ignoring-files-folders-code/` | Tool docs | Semgrep is the most widely deployed open-source SAST; its `--diff` / diff-aware scan mode is the canonical shipped implementation of new-issues-only filtering. Primary evidence source for Q1. |
| S2 | SonarQube/SonarCloud docs: `docs.sonarsource.com` -- PR analysis, new code period | Tool docs | SonarQube's "new code" concept is an industry reference for scoping findings to changed lines. Their definition of "new code" vs "existing code" is directly applicable. |
| S3 | Qodo PR-Agent source and docs (`github.com/Codium-ai/pr-agent`, `pr-agent-docs.codium.ai`) | OSS source + docs | PR-Agent is the most prominent open-source LLM review bot; its source code reveals exactly how it constructs prompts, what context it injects, and whether it does anything beyond diff injection. Falsifiable via code inspection. |
| S4 | CodeRabbit docs and changelog (`coderabbit.ai/blog`, `docs.coderabbit.ai`) | Product docs + changelog | CodeRabbit is the dominant commercial LLM review product; changelog entries confirm what is shipped vs roadmap. Look for "incremental review", "learnings", "sequence diagrams" features as evidence of context beyond the diff. |
| S5 | GitHub code review API and Checks API docs (`docs.github.com`) | Platform docs | Understanding what metadata the platform exposes (diff hunks, base sha, annotation positions) constrains what any bot can actually anchor findings to. Also reveals the `startLine`/`endLine` annotation model used by all tools. |
| S6 | Academic / research: papers on diff-anchored LLM review, "LLM code review" + "false positive" at arxiv.org and Google Scholar | Research papers | May contain systematic evaluations of pre-existing vs regression separation quality. Apply shipped_vs_announced filter heavily -- prefer papers with empirical evaluation on real PRs. |
| S7 | Critic source: "static analysis fatigue" / "alert noise" literature (e.g. Muske & Serebrenik 2016, Google eng practice docs) | Contrarian/critic | Documents failure modes of diff-based filtering, especially the "alert carries over silently" problem when unchanged code that depended on changed code is not re-analyzed. Important for identifying the hard cases. |
| S8 | CodeClimate, Reviewdog, Danger.js docs and source | Tool ecosystem | These are the plumbing layer many CI bots use to post annotations. Understanding their diff-anchoring primitives (especially Reviewdog's `--diff` flag and filter-mode options) reveals the actual mechanism used by tools built on top. |
