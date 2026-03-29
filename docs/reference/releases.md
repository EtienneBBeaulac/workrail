# Release Policy

This is the canonical reference for WorkRail release behavior.

## Release authority

Releases are produced by **semantic-release** in GitHub Actions.

Do not:

- bump `package.json` versions manually
- create release tags locally
- treat local tags as the source of truth for published versions

## Release classification

WorkRail uses conventional commits through `semantic-release`, but the governing principle is
**external-surface impact**, not commit wording alone.

The release type is determined by the commit that lands on `main`.

For squash merges, that means the **PR title / squash commit title** controls the release type,
so the title should accurately reflect the release class implied by the change.

### External-surface impact

Release level is based on whether a change affects a stable external surface that existing
consumers could reasonably rely on.

External surface includes:

- MCP tool contracts
- workflow authoring/schema contracts
- stable runtime semantics that clients, workflows, or operators reasonably rely on
- public engine/package behavior
- operator-facing release/config behavior

This repo is not primarily judged by direct end-user visibility. The meaningful question is
whether an existing consumer, workflow author, integration, or operator would need to adjust
because of the change.

### Reasonable reliance

A behavior counts as reasonably relied on when it is either:

- explicitly documented, or
- obvious core behavior that careful consumers would reasonably depend on

Incidental implementation details and accidental quirks do **not** count as stable external
surface.

### Release matrix

| Commit shape on `main` | Release result | Notes |
|---|---|---|
| `fix:` | `patch` | Contract-preserving fixes, semantic corrections, regressions, and operational/config correctness fixes |
| `perf:` | `patch` | Performance improvements without new supported capability |
| `revert:` | `patch` | Reverting a previously released change |
| `feat:` | `minor` | Meaningful non-breaking expansion of supported external behavior or capability |
| breaking change + `WORKRAIL_ALLOW_MAJOR_RELEASE=true` | `major` | Explicitly approved breaking release |
| breaking change + major approval **not** enabled | `minor` | Safe downgrade by default |
| `docs:`, `style:`, `chore:`, `refactor:`, `test:`, `build:`, `ci:` | no release | No version bump, no tag, no GitHub release |

### Patch vs minor

Default to **patch** unless the change clearly adds a meaningful new supported capability.

Use **patch** for:

- contract-preserving fixes
- semantic corrections
- bug and regression repairs
- operational or release-config fixes
- behavior that "should already have worked this way"

Use **minor** for:

- meaningful non-breaking expansion of supported capability
- new supported MCP/workflow/engine behavior
- new external-surface area consumers can intentionally adopt

### Untagged / no-release work

When a change falls into a no-release class:

- semantic-release creates **no version bump**
- semantic-release creates **no tag**
- semantic-release creates **no GitHub release**

This is the right bucket for:

- documentation-only changes
- internal refactors with no release-worthy effect
- test-only changes
- CI/build maintenance
- internal-only cleanup with no meaningful external-surface impact

## Breaking changes

Breaking changes are **not** released as `major` by default.

Instead:

- a breaking change is treated as **`minor` by default**
- it becomes **`major` only when explicitly approved**

Approval is controlled by:

- repository variable: **`WORKRAIL_ALLOW_MAJOR_RELEASE=true`**

This keeps accidental breaking-change markers from creating an unplanned major release.

### What counts as breaking

A change is breaking when existing consumers, workflows, or operators would need **meaningful
adjustment** or would be **importantly surprised** by the new behavior.

This can include:

- incompatible MCP/schema/API changes
- incompatible changes to stable runtime semantics
- behavior shifts that invalidate reasonable existing assumptions

It does **not** automatically include:

- internal implementation refactors
- non-obvious incidental behavior
- accidental quirks no careful consumer should have built around

## Practical guidance

Use these rules when choosing a PR title or squash-merge title:

- choose **`fix:`** when the goal is a patch release
- choose **`feat:`** when the goal is a minor release
- choose **`docs:`** / **`chore:`** / **`refactor:`** / **`test:`** when the change should be untagged

If the work mixes multiple commit types on a branch, the title of the commit that lands on `main` is what matters for release classification.

## Intentional major release flow

If you actually want a major release:

1. Set the GitHub repository variable `WORKRAIL_ALLOW_MAJOR_RELEASE=true`
2. Merge the breaking-change commit(s) to `main`
3. Let the normal release workflow publish the release
4. Remove or reset the repository variable afterward

## Dry-run commands

### Local

Normal preview:

```bash
npx semantic-release --dry-run --no-ci
```

Preview with major approval enabled:

```bash
WORKRAIL_ALLOW_MAJOR_RELEASE=true npx semantic-release --dry-run --no-ci
```

### GitHub Actions

Use:

- `.github/workflows/release-dry-run.yml`

## Source of truth

The behavior is implemented in:

- `.releaserc.cjs`
- `.github/workflows/release.yml`
- `.github/workflows/release-dry-run.yml`
