# Source Plan: OpenClaw vs WorkTrain Competitive Analysis

## Competitor: OpenClaw (https://github.com/openclaw/openclaw)
## Decision target: roadmap_prioritization

---

## Rules (all subagents must apply)

**shipped_vs_announced rule:** Only count behavior visible in source code, CHANGELOG, or release notes as shipped. VISION.md and issue feature requests are announced/aspirational. Mark each finding with [SHIPPED] or [ANNOUNCED].

**marketing_vs_user rule:** Any claim from the product website (openclaw.ai) or README must be paired with either source code evidence or a user artifact (GitHub issue, CHANGELOG fix). Marketing copy alone does not count as a finding.

---

## Source Inventory by Tier

### HIGH SIGNAL (will use)

| Source | What I expect | Reachability |
|--------|--------------|--------------|
| GitHub source code (`src/`) | Actual architecture, module contracts, subsystem design | ✅ Fully readable via gh API |
| CHANGELOG.md | What actually shipped, contributor patterns | ✅ Read (daily CalVer releases, very active) |
| Open issues (sample of 30) | User pain points, missing features, bugs | ✅ Fetched via gh issue list |
| AGENTS.md | How they handle agent context, coding conventions, CI expectations | ✅ Read |
| Release history | Cadence, stability, shipping velocity | ✅ 369k stars, 76k forks, daily releases |
| Governance: contributor employer analysis | Who controls steering | ✅ steipete (Peter Steinberger, PSPDFKit) dominates at 24k commits |

### MEDIUM SIGNAL (will use selectively)

| Source | What I expect | Reachability |
|--------|--------------|--------------|
| VISION.md | Strategic direction, what they won't build | ✅ Read |
| README.md | Product claims (need source pairing) | ✅ Read |
| GitHub behavioral metrics | fork-to-star ratio = 76260/369502 = 20.6% (STRONG -- above 50/1000 threshold) | ✅ Computed |

### LOW SIGNAL (will skip)

| Source | Why skipping |
|--------|-------------|
| openclaw.ai website | Marketing copy; README already has the claims; no new signal |
| X/Twitter | Not relevant for architecture analysis |
| ClawHub plugin registry | Out of scope for WorkTrain comparison |

---

## Key structural observation

OpenClaw is **not a direct feature competitor** to WorkTrain. It is a personal AI assistant platform (think Home Assistant for AI agents), not an autonomous dev pipeline. However, it is implemented in TypeScript and has shipped many subsystems WorkTrain needs or is building:

- **Subagent spawning** (depth tracking, capability isolation, context inheritance)
- **Task registry** (SQLite-backed, with status, delivery, notify policy)
- **Commitments** (extracted agent promises, due windows, dedup, heartbeat delivery)
- **Context engine** (pluggable interface: assemble, compact, maintain, ingest, transcript rewrite)
- **Trajectory/session tracing** (structured event log per session)
- **Daemon service management** (launchd + systemd, restart handoff, service audit)
- **Crash recovery** (graduated ladder, doctor --fix, config rollback)

The overlap is architectural, not product-level. The relevant question for WorkTrain is: "What patterns has OpenClaw battle-tested that we should adopt?"

---

## Planned approach for high-signal sources

1. Source code: already read key subsystems (context-engine, tasks, commitments, agents/subagent-*, daemon/service-audit, trajectory)
2. CHANGELOG: read latest release for shipped vs announced verification
3. Open issues: sampled 30 -- looking for patterns in what breaks
4. AGENTS.md: read -- focus on architectural guidelines and CI approach
