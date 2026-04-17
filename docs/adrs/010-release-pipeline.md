# ADR-010: Release Pipeline and Version Synchronization

**Status:** Adopted  
**Date:** 2026-04-17

## Context

WorkRail uses semantic-release to automate versioning and publishing. The pipeline needs to:
1. Publish to npm when releasable commits land on main
2. Create a GitHub release + git tag
3. Keep `package.json` on main in sync with the published version

The challenge: GitHub branch protection rulesets block direct pushes to main, including automated pushes from CI. Fine-grained PATs and GitHub App tokens with bypass permissions were both tested -- both could verify bypass but still received GH013 on the actual push. The root cause was that `@semantic-release/git` pushes directly to `main`, which violates the "require pull request" rule regardless of bypass configuration.

## Decision

**Remove `@semantic-release/git` direct push. Use a post-release PR instead.**

After semantic-release publishes to npm and creates the GitHub release, the workflow:
1. Creates a branch `chore/release-<version>`
2. Commits the `package.json` + `package-lock.json` version bump with `--no-verify` (bypasses the commit-msg hook which rejects automated commit formats)
3. Opens a PR
4. Admin-merges it immediately (no CI wait -- it's a mechanical 1-line change with no code risk)

This approach requires no bypass permissions. It's a normal PR merge, which the branch protection rules allow.

## Architecture

```
fix:/feat: commit → main
  ↓
CI passes
  ↓
Release workflow fires (workflow_run trigger)
  ↓
Generate GitHub App token (workrail-release-bot, App ID: 3405427)
  ↓
Checkout refs/heads/main (full branch ref, not detached HEAD)
  ↓
semantic-release:
  - analyzeCommits → determines next version (patch/minor/major)
  - generateNotes → release notes
  - exec.prepareCmd → npm pkg set version=X.Y.Z
  - exec.publishCmd → npm publish --access public (OIDC trusted publishing)
  - github → creates GitHub release + tag
  ↓
Open version-bump PR:
  - branch: chore/release-X.Y.Z
  - commit: chore(release): X.Y.Z [skip ci] --no-verify
  - PR admin-merged immediately
  ↓
package.json on main = npm version = GitHub release
```

## Token setup

- **`GH_APP_ID`** secret: App ID of `workrail-release-bot` GitHub App (3405427)
- **`GH_APP_PRIVATE_KEY`** secret: Private key `.pem` for the app
- The app is installed on `EtienneBBeaulac/workrail` with Contents + Pull requests + Administration permissions
- The app is in the ruleset bypass list (for GitHub API calls like creating releases/tags)
- The version-bump PR uses `--admin` merge, no bypass needed

## npm publishing

Uses npm's OIDC trusted publishing (no npm token stored as a secret). The workflow has `id-token: write` permission and the npm package is configured to accept OIDC tokens from this repository.

## Commit types that trigger a release

| Type | Release |
|------|---------|
| `feat:` | minor (0.x.0) |
| `fix:`, `perf:`, `revert:` | patch (0.0.x) |
| `BREAKING CHANGE` | minor (capped; use `WORKRAIL_ALLOW_MAJOR_RELEASE=true` var to allow major) |
| `chore:`, `docs:`, `style:`, `refactor:`, `test:`, `build:`, `ci:` | no release |

## Key files

- `.releaserc.cjs` -- semantic-release config
- `.github/workflows/release.yml` -- the release pipeline
- `.github/workflows/ci.yml` -- CI that triggers release on success

## Lessons learned

- `GITHUB_TOKEN` cannot bypass branch protection rulesets -- it's intentionally limited
- Fine-grained PATs with admin permission also cannot bypass rulesets in CI context
- GitHub App tokens CAN bypass rulesets, but only for API operations (creating tags, releases) -- not for git push via HTTPS even with bypass list configured
- The right solution for automated version bumps is a PR, not a direct push
- `actions/checkout` with `ref: refs/heads/main` (not `ref: main` or a commit SHA) is required to avoid detached HEAD, which causes semantic-release to skip with "local branch is behind remote"
- The commit-msg hook runs in CI -- automated commits need `--no-verify`
