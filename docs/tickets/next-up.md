# Next Up

Groomed near-term tickets ready for implementation. For the full priority ordering see `docs/ideas/backlog.md` or run `npm run backlog -- --min-score 11 --unblocked-only`.

---

## Active roadmap (May 2026)

The goal of this sequence: make `wr.mr-review` complete reliably end-to-end in autonomous overnight operation, producing a draft review on GitHub that the operator can simply submit.

### Step 1 -- Engine hint content fixes (issue #1074) 🔴 READY

**What:** Fix 4 wrong strings in 3 engine files that actively misdirect agents when they fail to submit a required artifact. The engine says "fix notesMarkdown" when it means "fix output.artifacts", and says "submit wr.assessment" when the step requires something else.

**Why first:** The SessionCortex (step 3) draws from the same `blocked-messages` registry this creates. Ship this independently -- it benefits all entry points (MCP + daemon) and immediately reduces 0/13 to something better.

**Design:** `docs/plans/cortex-hint-content-design.md`

**Key files:** `reason-model.ts`, `advance.ts:137`, `artifact-contract-validator.ts`

---

### Step 2 -- Merge PR #1072 (issue #1076) 🔴 READY

**What:** Delivery adapter architecture refactor -- `GitHubDraftReviewAdapter` and `GitCommitAdapter` as proper `DeliveryAdapter<K>` classes, typed sidecar discriminated union, `GateResumeCallback` threaded into startup recovery so gate sessions resume after daemon restart.

**Why:** The review session fired against this PR stuck on the exact bug step 1 fixes. Retry after step 1.

---

### Step 3 -- SessionCortex Phase 1+2 (issue #1075) 🔴 READY (after step 1)

**What:** Cross-turn failure detection + hint injection + scaffold injection. Subscribes to existing `turn_end` event, counts per-step engine rejections, injects escalating guidance via `agent.steer()`. Backed by a typed append-only crash-safe cortex event log.

**Why:** Even with correct engine error messages (step 1), an agent that receives the same error twice needs active recovery -- the engine can't do that, only the harness can.

**Design:** `docs/plans/session-harness-design.md`, pitch at `.workrail/current-pitch.md`

---

### Step 4 -- End-to-end verification (issue #1077) 🟡 AFTER steps 1-3

**What:** Fire a real `wr.mr-review` session on a real feature PR. Confirm: session completes without stalling, draft review posts with inline comments, gate resumes when operator submits, daemon restart recovery works.

**Why:** This is the acceptance test for everything we've built. Until this passes cleanly, nothing is production-ready.

---

### Step 5 -- Remove human_approval gate from wr.mr-review (issue #1078) 🟡 AFTER step 4

**What:** Remove the redundant `requireConfirmation: { kind: 'human_approval' }` from `phase-6-final-handoff`. The draft review mechanism already provides operator control via GitHub's submit button.

**Why:** Currently requires two human interactions (local `worktrain inbox respond` + GitHub submit). One is enough. Verify delivery works first (step 4) before removing the gate.

---

## On deck (next design/implementation cycle)

Once the above sequence is complete:

- **SessionCortex Phase 3+4** (step rewind, operator escalation) -- needs design on the HMAC rewind mechanism first
- **C3 follow-on** (dynamic daemon tool description per step) -- only if sessions still fail at high turn counts after steps 1-3
- **`dispatch()` delivery** and Slack/GitLab adapters -- Phase 8 of the delivery feature

---

## Recently completed

- Delivery Phases 1-7: `delivery:` YAML block, `GitHubDraftReviewAdapter`, inline comments, gate resume wiring (PRs #1054-#1067)
- CLI redesign: 18→14 commands, `session events`, `dispatch` (PRs #1039-#1044)
- Stall timer fix: C1+C2, stdin stdin fix, per-call LLM timeout (PRs #1030, #1052, #1054)
- GateKind discriminated union (PR #1025)
- Reviewer identity + draft review adapter (PRs #1022-#1023)
