# Authoring Doc Staleness Enforcement -- Design Candidates

**Main design doc:** `docs/plans/authoring-doc-staleness-enforcement.md`
**Status:** Raw investigative material for main-agent review. NOT a final decision.
**Date:** 2026-04-16

---

## Problem Understanding

### Tensions
1. **Completeness signal vs false positive noise**: Git-date staleness fires on cosmetic code touches. If it fires too often, it gets suppressed. The check must be signal-dense enough to trust.
2. **Self-maintaining check vs rich check**: A feature-ID coverage check is perfectly self-maintaining. A staleness check with per-rule dates requires 32-rule backfill and ongoing date updates.
3. **Single responsibility vs one-stop validation**: Adding new checks to `validate-authoring-spec.js` keeps one command but dilutes responsibility. Separate scripts are cleaner but add CI wiring overhead.
4. **validate:authoring-spec not in CI yet**: Any check is advisory-only until wired into CI. The CI gap is load-bearing for all existing AND new checks.

### Likely seam
The gap is NOT in the runtime (correctly enforces the closed set). The gap is between:
- `src/application/services/compiler/feature-registry.ts` -- source of truth for what features exist
- `spec/authoring-spec.json` -- documentation target

The seam is the CI validation boundary, where this relationship can be asserted mechanically.

### What makes it hard
- The check needs to exist before it's obvious it's missing
- Wiring into CI so it actually blocks PRs (not just a script nobody runs)
- Getting false positive rate low enough that the check stays trusted
- Bootstrap problem: existing rules need review dates before staleness check is meaningful

---

## Philosophy Constraints

| Principle | How it applies |
|---|---|
| Make illegal states unrepresentable | Feature coverage check makes 'undocumented feature in registry' a CI-time violation |
| Validate at boundaries | CI IS the boundary. validate:authoring-spec not being in CI means no boundary today |
| YAGNI with discipline | Per-rule lastReviewed is YAGNI right now. Spec-level date is sufficient for first iteration |
| Errors are data | Scripts should aggregate violations and fail once at the end, not fail-fast mid-loop |
| Architectural fixes over patches | The feature-registry-as-source-of-truth approach is architectural; a manual checklist is a patch |

**Philosophy conflict:** YAGNI vs Make illegal states unrepresentable. Per-rule dates are more rigorous but are not yet needed. Resolution: start with spec-level dates (YAGNI), evolve to per-rule when false positives prove noisy.

---

## Impact Surface

- `scripts/validate-authoring-spec.js` -- extended with staleness flag or referenced as precedent
- `scripts/validate-feature-coverage.js` -- new script (Candidate A)
- `spec/authoring-spec.json` -- must add `wr.features.capabilities` rule to pass coverage check
- `spec/authoring-spec.schema.json` -- may need optional `lastReviewed` field on rules (Candidate C)
- `.github/workflows/ci.yml` -- `validate-workflows` job must add new npm script calls
- `package.json` -- new npm scripts for the new checks
- `AGENTS.md` -- new enforcement checklist section

Nearby contracts that must stay consistent:
- `validate:registry` job in CI (add new validation alongside, not replacing)
- `stamp-workflow` npm script pattern (precedent for lastReviewed date tooling)

---

## Candidates

### Candidate A: Minimal -- wire existing script + add feature coverage check

**Summary:** Add `validate:authoring-spec` to CI and add `scripts/validate-feature-coverage.js` that regex-extracts `wr.features.*` IDs from `feature-registry.ts` and asserts each appears in `authoring-spec.json`.

**Tensions resolved:** Completeness signal (hard fail on undocumented features). CI enforcement (existing structural check finally blocked). **Accepted:** No staleness signal.

**Boundary:** CI validation gate in the `validate-workflows` job.

**Why that boundary is best fit:** All existing workflow checks live in `validate-workflows`. This keeps the enforcement surface coherent.

**Failure mode:** Regex breaks if `feature-registry.ts` is reformatted. Guard: assert extracted count > 0, fail if zero with "regex may be broken" message.

**Repo pattern relationship:** Directly adapts `validate-authoring-spec.js` structure and `validate:registry` CI pattern.

**Gain:** Lowest cost. Fixes `wr.features.capabilities` gap immediately. One new 50-line script.
**Give up:** No time-based signal. Can't detect when a documented feature's implementation diverges from its spec entry.

**Scope:** Best-fit. Narrow enough for one PR, closes the primary gap.

**Philosophy:** Honors Make illegal states unrepresentable, Validate at boundaries, YAGNI. No conflicts.

**Pseudocode:**
```js
// scripts/validate-feature-coverage.js
function extractFeatureIds(registrySource) {
  const matches = [...registrySource.matchAll(/id:\s*['"]([^'"]+)['"]/g)];
  const ids = matches.map(m => m[1]).filter(id => id.startsWith('wr.features.'));
  if (ids.length === 0) {
    throw new Error('Extracted 0 feature IDs -- regex may be broken');
  }
  return ids;
}

function collectSpecText(spec) {
  const texts = [];
  const visit = (rule) => {
    texts.push(rule.id, rule.rule, ...(rule.checks ?? []), ...(rule.antiPatterns ?? []));
    for (const ref of rule.sourceRefs ?? []) texts.push(ref.path, ref.note ?? '');
  };
  for (const topic of [...(spec.topics ?? []), ...(spec.plannedTopics ?? [])]) {
    for (const rule of topic.rules) visit(rule);
  }
  return texts.join('\n');
}

function main() {
  const registrySource = fs.readFileSync(REGISTRY_PATH, 'utf8');
  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
  const featureIds = extractFeatureIds(registrySource);
  const specText = collectSpecText(spec);
  const uncovered = featureIds.filter(id => !specText.includes(id));
  if (uncovered.length > 0) {
    console.error('FAIL: feature IDs in registry with no spec coverage:', uncovered);
    process.exit(1);
  }
  console.log(`OK: all ${featureIds.length} features covered`);
}
```

---

### Candidate B: Staleness extension to existing validator

**Summary:** Extend `validate-authoring-spec.js` with `--check-staleness` flag that runs `git log -1 --format=%as -- <path>` on each TS sourceRef file and compares against the spec-level `lastReviewed` date. Warn (not fail) when stale. Add as advisory-only CI step.

**Tensions resolved:** Staleness detection (time-based signal for drift after initial doc). **Accepted:** False positive noise (cosmetic touches trigger it), spec-level date is coarse (all rules share one review date).

**Boundary:** Extended `validate-authoring-spec.js` invoked with `--check-staleness` flag. Separate npm script `validate:authoring-staleness` to keep it decoupled from hard-fail checks.

**Why that boundary is best fit:** Reuses existing script infrastructure. Advisory-only mode prevents it from blocking legitimate non-docs PRs on day 1.

**Failure mode:** Contributor updates a comment in `response-supplements.ts`, staleness fires on response-supplements rules even though guidance is still accurate. Check gets ignored. **Mitigation:** Document the false positive expectation explicitly. Only promote to hard-fail after per-rule dates are backfilled (Candidate C).

**Repo pattern relationship:** Directly adapts the `stamp-workflow` lastReviewed date pattern. Git-log date queries are a standard shell/CI pattern.

**Gain:** Catches implementation drift after documentation was written. Provides a time-based hygiene signal.
**Give up:** False positive cost at spec-level granularity. Requires spec `lastReviewed` to be manually bumped after review passes.

**Scope:** Best-fit as a complement to A. Slightly too broad as standalone solution.

**Philosophy:** Honors Determinism, Validate at boundaries. Mild conflict with Make illegal states unrepresentable (advisory only, not hard invariant).

**Pseudocode:**
```js
// Addition to validate-authoring-spec.js
function getGitLastModifiedDate(filePath) {
  try {
    return execSync(`git log -1 --format="%as" -- "${filePath}"`, 
      { cwd: repoRoot, encoding: 'utf8' }).trim() || null;
  } catch { return null; }
}

function checkStaleness(spec) {
  const reviewDate = new Date(spec.lastReviewed);
  const stale = [];
  for (const topic of spec.topics) {
    for (const rule of topic.rules) {
      const ruleDate = rule.lastReviewed ? new Date(rule.lastReviewed) : reviewDate;
      for (const ref of rule.sourceRefs ?? []) {
        if (!ref.path.match(/\.(ts|js)$/)) continue;
        const modified = getGitLastModifiedDate(path.join(repoRoot, ref.path));
        if (modified && new Date(modified) > ruleDate) {
          stale.push({ ruleId: rule.id, path: ref.path, modified, reviewed: ruleDate.toISOString().slice(0,10) });
        }
      }
    }
  }
  return stale;
}
// Called from main() when --check-staleness flag is present. Warns on findings.
// Exits non-zero only if WORKRAIL_STRICT_STALENESS=1 env var is set.
```

---

### Candidate C: Per-rule lastReviewed with schema enforcement

**Summary:** Add optional `lastReviewed` ISO date string to each rule in `authoring-spec.schema.json`, backfill all 32 existing rules, and have staleness check use per-rule dates instead of spec-level date.

**Tensions resolved:** Surgical staleness (only the specific rule covering a changed file goes stale). Lower false positive rate than B. **Accepted:** One-time 32-rule backfill cost, ongoing date update obligation.

**Boundary:** Schema validation layer (Ajv enforces valid dates) + staleness check.

**Failure mode:** Per-rule dates become stale because contributors forget to update them. The per-rule precision advantage erodes and the check becomes as noisy as Candidate B.

**Repo pattern relationship:** Adapts stamp-workflow pattern at per-rule granularity. Requires a `stamp-authoring-spec.js` helper script (analogous to `stamp-workflow.ts`) to be useful in practice.

**Gain:** Surgical signal. Only the rules covering changed files flag stale.
**Give up:** Highest maintenance cost. Bootstrap obligation.

**Scope:** Too broad for initial implementation. Correct long-term direction.

**Philosophy:** Honors Make illegal states unrepresentable, Prefer explicit domain types. Conflicts with YAGNI.

---

### Candidate D: knownFeatureIds sidecar array in authoring-spec.json

**Summary:** Add `knownFeatureIds: string[]` array to `authoring-spec.json`, manually sync with registry, validate that each listed ID has a spec rule.

**Tensions resolved:** Schema-enforced coverage (Ajv validates the list). **Accepted:** Reintroduces manual sync problem -- two places to update when adding a feature.

**Boundary:** Schema validation (Ajv).

**Failure mode:** Contributor adds feature to registry, forgets to update `knownFeatureIds`. Check passes silently because it only validates listed IDs have coverage. Completeness hole.

**Repo pattern relationship:** Departs from self-maintaining approach. No precedent.

**Gain:** Simpler validation logic.
**Give up:** Self-maintenance. This IS the problem we're trying to solve -- a sidecar list just moves the symptom.

**Scope:** Too narrow -- solves wrong problem.

**Philosophy:** Conflicts with Architectural fixes over patches. Honors Type safety.

---

## Comparison and Recommendation

### Recommendation: A + B implemented sequentially (C as future evolution)

**First PR (Candidate A):** Wire `validate:authoring-spec` into CI + add `validate-feature-coverage.js`. Fixes `wr.features.capabilities` gap immediately. Hard-fail on undocumented features.

**Second PR (Candidate B):** Add `--check-staleness` advisory mode. Wire into CI as a warning step. Uses spec-level `lastReviewed`.

**Future (Candidate C):** Upgrade B to per-rule granularity if false positives prove noisy.

**Candidate D:** Strictly inferior to A. Dismissed.

---

## Self-Critique

**Strongest counter-argument:** Advisory CI steps that never become blocking are eventually ignored. If Candidate B stays advisory forever, it has no enforcement value. Mitigation: the AGENTS.md checklist explicitly names the condition for promoting staleness to hard-fail.

**Narrower option that lost:** Just adding `validate:authoring-spec` to CI without the feature coverage script. Lost because the structural check already passes on current spec -- adding it to CI adds presence but doesn't catch the `wr.features.capabilities` gap.

**Broader option that might be justified:** Candidate C now. Evidence needed: a specific false positive from spec-level staleness that gets ignored by reviewers. Without that evidence, C is YAGNI.

**Assumption that would invalidate the design:** Regex extraction of feature IDs from `feature-registry.ts` becomes unreliable as the file evolves. If the `FEATURE_DEFINITIONS` array is refactored (e.g., moved to separate files, or IDs become programmatically generated), the regex breaks silently (zero IDs extracted). The guard (`if ids.length === 0, fail`) converts this from a silent false negative to a loud failure.

---

## Open Questions for the Main Agent

1. Is `wr.features.capabilities` intentionally undocumented (internal-only feature) or is this a confirmed gap that should be fixed?
2. Should `validate:authoring-spec` be added to the existing `validate-workflows` job in CI, or warrant its own separate job?
3. Is the advisory-to-blocking promotion path for the staleness check something the project owner wants to commit to in the first PR, or leave open?
