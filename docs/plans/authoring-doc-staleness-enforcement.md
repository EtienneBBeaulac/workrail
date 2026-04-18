# Authoring Doc Staleness Enforcement

**Status:** Discovery / Design
**Date:** 2026-04-16

**Artifact strategy:** This document is human-readable reference material. It
is NOT execution truth. Durable execution state lives in WorkRail notes and
context variables. If the chat rewinds, this file may not reflect the latest
session state -- consult WorkRail session notes instead.

---

## Context / Ask

WorkRail has a known sync problem: when a new engine feature ships, authoring
documentation lags or never gets updated. We need CI-enforced mechanical checks,
not process rules.

**Existing assets:**
- `spec/authoring-spec.json` -- 16 topics, ~32 rules. Each rule has `sourceRefs`
  pointing to runtime implementation files. Has `lastReviewed: "2026-04-04"`.
- `scripts/validate-authoring-spec.js` -- validates structural validity and
  sourceRef path existence.
- `spec/workflow.schema.json` -- the workflow JSON schema.
- CI already runs `validate:authoring-spec` but only checks structure and path
  existence, not coverage or freshness.

**Key engine surfaces for cross-reference:**
- `src/application/services/compiler/feature-registry.ts` -- closed-set feature
  IDs: `wr.features.memory_context`, `wr.features.capabilities`,
  `wr.features.subagent_guidance`
- `src/v2/durable-core/domain/decision-trace-builder.ts` -- loop/condition trace
  logic (no direct authoring surface, but represents control flow primitives)
- `src/mcp/handlers/v2-reference-resolver.ts` -- workflow reference resolution
  (workspace vs package)

---

## Path Recommendation

**landscape_first** -- the dominant need is understanding current gaps and
designing complementary CI checks. The problem is well-framed, the assets are
known, so full reframing is not needed.

---

## Constraints / Anti-goals

**Constraints:**
- Must be Node.js scripts (existing tooling pattern, no new build deps)
- Must be non-blocking on first introduction (warn mode, then harden to fail)
- Must not require manual maintenance per-rule (defeat the purpose)
- Must run fast enough for CI (< 5s)

**Anti-goals:**
- Do NOT parse TypeScript ASTs -- too fragile, too expensive
- Do NOT require authors to update a separate manifest file for every code change
- Do NOT fail CI on the first day (start advisory, promote to blocking on next PR)

---

## Landscape Packet

### Critical finding: `validate:authoring-spec` is NOT in CI

The `validate:authoring-spec` npm script exists but is NOT wired into
`.github/workflows/ci.yml`. Only `validate:registry` and
`validate:workflow-discovery` run in CI. This means the structural validation
that already exists is not enforced on PRs. **Any new checks must also be added
to ci.yml to have enforcement value.**

### What `validate-authoring-spec.js` already does

1. Schema validation of `authoring-spec.json` via Ajv
2. Rule ID uniqueness
3. Scope catalog membership for each rule's `scope` array
4. `sourceRefs` and `exampleRefs` path existence on disk (not JSON validity for
   .json refs)
5. Enforcement mode constraints (`planned` rules may not have `runtime`
   enforcement)

### What it does NOT do

- Check whether sourceRef files have been modified since the spec was last reviewed
- Check whether feature registry IDs have corresponding spec coverage
- Check whether new schema fields have corresponding spec rules

### `lastReviewed` semantics

The spec has a single top-level `lastReviewed: "2026-04-04"` date. Individual
rules do NOT have per-rule review dates. This means staleness detection must
work at the whole-spec level or we need to add per-rule `lastReviewed` dates.

**Key insight:** Adding per-rule `lastReviewed` is the correct granularity for
Check 1. The spec version already increments when required rules change, but
`lastReviewed` exists specifically for "did anyone re-read this rule since the
source changed?"

### Feature registry state

3 features in `FEATURE_DEFINITIONS`:
- `wr.features.memory_context` -- referenced in `features-are-closed-set` rule
- `wr.features.capabilities` -- NOT explicitly named as a known feature in any
  spec rule (the `features-are-closed-set` rule mentions only
  `subagent_guidance` and `memory_context` in its checks text)
- `wr.features.subagent_guidance` -- referenced in `features-are-closed-set`
  rule

**Gap found:** `wr.features.capabilities` is a live feature in the registry but
is not mentioned in `authoring-spec.json`. This is exactly the kind of drift
the checks should catch.

---

## Candidate Generation Expectations

Path: `landscape_first`. The candidate set must:
- Reflect actual landscape precedents (validate:registry stamp pattern, existing validate-authoring-spec.js, feature-registry.ts closed-set structure)
- Address the concrete gaps found (wr.features.capabilities missing, validate:authoring-spec not in CI)
- Include at least one candidate that exploits an existing pattern rather than inventing a new mechanism
- NOT drift into free invention (e.g. "add a new MCP tool for spec linting" is out of scope)
- Candidates should differ in implementation approach, not just in naming

## Candidate Directions

### Check 1: sourceRefs staleness (`--check-staleness` flag)

**Approach:** For each rule that has `sourceRefs` pointing to TypeScript/JS
files, run `git log -1 --format="%as" -- <path>` to get the file's last
modification date in git. Compare against the rule's `lastReviewed` date
(falling back to the spec-level `lastReviewed`). Flag rules whose sourceRef
files were modified after the review date.

**Implementation:**

Add a `lastReviewed` field to each rule in `authoring-spec.json`. Default to
the spec-level `lastReviewed` for rules that do not set it.

Extend `validate-authoring-spec.js` with a `--check-staleness` flag:

```js
// Pseudocode for --check-staleness logic (add to validate-authoring-spec.js)
const { execSync } = require('child_process');

function getGitLastModifiedDate(filePath) {
  try {
    const result = execSync(
      `git log -1 --format="%as" -- "${filePath}"`,
      { cwd: repoRoot, encoding: 'utf8' }
    ).trim();
    return result || null; // null if file has no git history
  } catch {
    return null;
  }
}

function checkStaleness(spec) {
  const specLastReviewed = new Date(spec.lastReviewed);
  const staleRules = [];

  for (const topic of spec.topics) {
    for (const rule of topic.rules) {
      // Per-rule lastReviewed takes precedence over spec-level
      const ruleReviewDate = rule.lastReviewed
        ? new Date(rule.lastReviewed)
        : specLastReviewed;

      for (const ref of rule.sourceRefs ?? []) {
        // Only check TypeScript/JavaScript source files
        if (!ref.path.match(/\.(ts|js|mts|mjs)$/)) continue;

        const fullPath = path.join(repoRoot, ref.path);
        const lastModified = getGitLastModifiedDate(fullPath);
        if (!lastModified) continue;

        if (new Date(lastModified) > ruleReviewDate) {
          staleRules.push({
            ruleId: rule.id,
            sourceRef: ref.path,
            lastModified,
            ruleReviewed: ruleReviewDate.toISOString().slice(0, 10),
          });
        }
      }
    }
  }

  return staleRules;
}

// In main(), after existing checks:
if (process.argv.includes('--check-staleness')) {
  const staleRules = checkStaleness(spec);
  if (staleRules.length > 0) {
    console.warn('\n[STALENESS] The following rules have sourceRef files modified after their lastReviewed date:');
    for (const s of staleRules) {
      console.warn(`  rule: ${s.ruleId}`);
      console.warn(`    sourceRef: ${s.sourceRef}`);
      console.warn(`    file last modified: ${s.lastModified}`);
      console.warn(`    rule last reviewed: ${s.ruleReviewed}`);
    }
    // On first introduction: warn only. Promote to process.exit(1) after
    // all existing rules have per-rule lastReviewed dates.
    if (process.env.WORKRAIL_STRICT_STALENESS === '1') {
      process.exit(1);
    }
  } else {
    console.log('[STALENESS] All sourceRef files are current relative to lastReviewed dates.');
  }
}
```

**Schema change needed:** Add optional `lastReviewed` (date string) field to the
rule schema in `spec/authoring-spec.schema.json`.

**CI integration:**
```json
// package.json -- add to validate:authoring-spec script or as separate target
"validate:authoring-staleness": "node scripts/validate-authoring-spec.js --check-staleness"
```

**Limitations:**
- Git-based: only works inside a git repo (fine for CI)
- Single `lastReviewed` at spec level is coarse; per-rule dates require a one-time
  backfill
- Does not detect semantic drift -- only that a file was touched after review

---

### Check 2: feature-registry completeness

**Approach:** Read `feature-registry.ts`, extract all feature IDs from
`FEATURE_DEFINITIONS`, then check that each feature ID appears somewhere in
`authoring-spec.json` (in any rule's `sourceRefs[].path` or in the rule text
or `checks` array).

Since the file is TypeScript, we cannot `require()` it directly in a Node.js
script without compilation. Two viable approaches:

**Option A: Text extraction (simple, no TS compilation)**

Extract feature IDs with a regex match on `feature-registry.ts`:

```js
// scripts/validate-feature-coverage.js
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const registryPath = path.join(repoRoot, 'src/application/services/compiler/feature-registry.ts');
const specPath = path.join(repoRoot, 'spec/authoring-spec.json');

function extractFeatureIds(source) {
  // Match: id: 'wr.features.something'
  const matches = [...source.matchAll(/id:\s*['"]([^'"]+)['"]/g)];
  return matches
    .map(m => m[1])
    .filter(id => id.startsWith('wr.features.'));
}

function collectSpecText(spec) {
  // Gather all text from all rules for full-text search
  const texts = [];
  const visit = (rule) => {
    texts.push(rule.id, rule.rule, ...(rule.checks ?? []), ...(rule.antiPatterns ?? []));
    for (const ref of rule.sourceRefs ?? []) {
      texts.push(ref.path, ref.note ?? '');
    }
  };
  for (const topic of [...(spec.topics ?? []), ...(spec.plannedTopics ?? [])]) {
    for (const rule of topic.rules) visit(rule);
  }
  for (const rule of spec.plannedRules ?? []) visit(rule);
  return texts.join('\n');
}

function main() {
  const registrySource = fs.readFileSync(registryPath, 'utf8');
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

  const featureIds = extractFeatureIds(registrySource);
  const specText = collectSpecText(spec);

  const uncovered = featureIds.filter(id => !specText.includes(id));

  if (uncovered.length > 0) {
    console.error('[FEATURE-COVERAGE] The following feature IDs from feature-registry.ts have no coverage in authoring-spec.json:');
    for (const id of uncovered) {
      console.error(`  - ${id}`);
    }
    console.error('\nAdd a rule to spec/authoring-spec.json that documents this feature, or add it to a sourceRef or checks entry of an existing rule.');
    process.exit(1);
  }

  console.log(`[FEATURE-COVERAGE] All ${featureIds.length} features covered in authoring-spec.json.`);
}

main();
```

**Option B: JSON sidecar (more robust, requires maintenance)**

Add a `knownFeatureIds` array to `authoring-spec.json` and validate it matches
the registry. Requires one more file to keep in sync -- worse than Option A.

**Recommendation:** Option A. It is self-contained, does not require TS
compilation, and the regex pattern is stable (feature IDs follow a clear
naming convention).

**CI integration:**
```json
"validate:feature-coverage": "node scripts/validate-feature-coverage.js"
```

Add to the CI `validate` job alongside `validate:authoring-spec`.

**Current gap this would catch:**
`wr.features.capabilities` is in the registry but not mentioned in
`authoring-spec.json`. This check would fail immediately on the current state
of the repo, proving it works.

---

### Check 3: AGENTS.md enforcement rule

The following rule text should be added to `AGENTS.md` under a new section
"Engine feature additions":

```markdown
## When adding a new engine feature

A "new engine feature" means any of:
- A new `wr.features.*` entry in `src/application/services/compiler/feature-registry.ts`
- A new schema field in `spec/workflow.schema.json`
- A new runtime behavior in `src/v2/durable-core/` or `src/mcp/` that authors
  need to declare, reference, or avoid

**Checklist -- all items required before the PR can merge:**

- [ ] `spec/authoring-spec.json`: add or update a rule covering the new feature.
  - The rule's `sourceRefs` must include the file that implements the feature.
  - If the feature is a `wr.features.*` ID, the rule's `checks` or rule text
    must mention the full feature ID string.
- [ ] `spec/authoring-spec.json` `lastReviewed`: update to today's date.
- [ ] Run `npm run validate:authoring-spec` -- must pass.
- [ ] Run `npm run validate:feature-coverage` -- must pass (new feature ID must
  appear in spec).
- [ ] `docs/authoring-v2.md` and/or `docs/authoring.md`: add a section or
  paragraph explaining when and how to use the feature.
- [ ] No `planned` enforcement on a rule for a feature that is already live in
  runtime -- use `runtime` or `validator`.
```

---

## Challenge Notes

**Against Check 1 (staleness):**
- A file touching only comments or formatting would trigger a false positive.
  Mitigation: accept this as a minor cost. A touched file is a signal worth
  reviewing, even if the change was cosmetic.
- The spec currently has no per-rule `lastReviewed` dates, so the first run
  would compare all rules against the spec-level `2026-04-04` date. Files
  modified after that date would all appear stale even if their corresponding
  rules are still accurate. Mitigation: introduce in warn-only mode first,
  then do a review pass to set per-rule dates.

**Against Check 2 (feature coverage):**
- Regex-based extraction is fragile if the feature definition format changes.
  Mitigation: the format is extremely stable (it's a const array) and the
  regex only needs to match `id: 'wr.features.*'`. If it breaks, the check
  would produce zero IDs (false negative), not a false positive. Add a guard:
  if `featureIds.length === 0`, fail with "extracted 0 feature IDs -- regex
  may be broken."
- Full-text search in spec text is loose. A feature ID appearing only in a
  comment or antiPatterns entry counts as "covered." This is acceptable --
  the check verifies the ID is acknowledged somewhere, not that the coverage
  is high quality.

**Against Check 3 (AGENTS.md rule):**
- AGENTS.md rules are agent-only -- they do not enforce on human contributors.
  Mitigation: the mechanical checks (1 and 2) handle the human path. The
  AGENTS.md rule handles the agent path.

---

## Resolution Notes

All three checks are complementary and non-overlapping:
- Check 1 catches drift after initial documentation exists (time-based signal)
- Check 2 catches new features that were never documented (completeness signal)
- Check 3 provides the agent with a concrete checklist to run before merging

**Recommended implementation order:**
1. Check 2 (feature coverage) -- highest value, simplest implementation, fails
   immediately on a known gap (`wr.features.capabilities`)
2. Check 3 (AGENTS.md rule) -- no code, zero cost, immediate value
3. Check 1 (staleness) -- requires schema change + per-rule review date backfill

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-16 | landscape_first path | Problem is well-framed, assets are known. No need for full reframing. |
| 2026-04-16 | Option A (regex extraction) for Check 2 | Simpler, no TS compilation, stable feature ID format |
| 2026-04-16 | Warn-only first for Check 1 | Per-rule lastReviewed dates need backfill before hard failure is fair |
| 2026-04-16 | AGENTS.md checklist > process prose | Agents respond to checklists better than principles |
| 2026-04-16 | Candidates A + B selected; C is future evolution; D dismissed | A closes primary gap (feature coverage), B adds time-based drift signal. Challenge failed to find blocking weakness in A. Main risk (regex brittleness) is mitigated by zero-extraction guard. Advisory-to-blocking upgrade path for B is deferred but not abandoned. |

---

## Final Recommendation

**Confidence: HIGH**

**Selected direction: Hybrid A+**

### PR 1 (primary -- implement first)
1. Add `scripts/validate-feature-coverage.js` -- regex-extracts all `wr.features.*` IDs from `feature-registry.ts` and hard-fails if any ID is absent from `authoring-spec.json` text.
2. Add `validate:feature-coverage` npm script to `package.json`.
3. Wire both `validate:authoring-spec` AND `validate:feature-coverage` into the `validate-workflows` job in `.github/workflows/ci.yml`.
4. Update `authoring-spec.json` to add coverage for `wr.features.capabilities` (confirmed gap).
5. Add AGENTS.md enforcement checklist (see Check 3 section below).

### PR 2 (follow-up -- create GitHub issue at PR 1 merge time)
1. Add `--check-staleness` flag to `validate-authoring-spec.js` with `rule.lastReviewed ?? spec.lastReviewed` fallback.
2. Add `validate:authoring-staleness` npm script.
3. Wire into CI as an advisory-only step (warn, don't fail).
4. Document the advisory-to-blocking upgrade condition in the issue.

### Residual risks
1. Coverage is a floor check (text presence), not a quality gate. The AGENTS.md checklist is the quality gate.
2. Staleness check deferred to PR 2. If PR 2 never ships, Criterion 2 is unmet.
3. Open question: is `wr.features.capabilities` intentionally excluded from the spec? Evidence says no (it's in user-facing bundled workflows), but confirm with project owner before PR 1 merges.

## Final Summary

**Path:** landscape_first
**Problem frame:** Engine velocity vs documentation discipline. The feature registry is a closed-set machine-readable source of truth; `authoring-spec.json` is the documentation target. The gap between them can be measured mechanically at CI time.
**Landscape takeaways:** (1) `wr.features.capabilities` is confirmed absent from spec but used in user-facing bundled workflows. (2) `validate:authoring-spec` script exists but is NOT in CI. (3) 3+ sourceRef files were modified after the spec's `lastReviewed: 2026-04-04` date. (4) The `stamp-workflow` pattern is the direct precedent for date-based review tracking.
**Chosen direction:** Hybrid A+ (Candidate A feature coverage + Candidate B staleness advisory with per-rule fallback)
**Strongest alternative:** Candidate C (per-rule lastReviewed dates) -- lost because the 32-rule backfill cost is not yet justified; spec-level dates are YAGNI-sufficient.
**Confidence:** HIGH
**Next actions:**
1. Confirm with project owner whether `wr.features.capabilities` is intentionally excluded from spec (evidence says no).
2. Implement PR 1 (validate-feature-coverage.js + ci.yml wiring + spec entry for capabilities + AGENTS.md checklist).
3. Create a GitHub issue for PR 2 (staleness check) at the time PR 1 merges.

Three complementary CI checks designed:

1. **`--check-staleness` flag on `validate-authoring-spec.js`** -- compares git
   modification dates of sourceRef TS files against per-rule `lastReviewed`
   dates. Requires schema change + backfill, introduce in warn mode.

2. **New `scripts/validate-feature-coverage.js`** -- regex-extracts all
   `wr.features.*` IDs from `feature-registry.ts` and confirms each appears
   in `authoring-spec.json`. Self-contained, fast, fails on existing gap
   (`wr.features.capabilities`). Highest priority to implement.

3. **AGENTS.md checklist** -- specific, actionable 6-item checklist for "when
   adding a new engine feature" that references both mechanical checks by name.
