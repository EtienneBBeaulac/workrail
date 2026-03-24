# Release Policy

This is the canonical reference for WorkRail release behavior.

## Release authority

Releases are produced by **semantic-release** in GitHub Actions.

Do not:

- bump `package.json` versions manually
- create release tags locally
- treat local tags as the source of truth for published versions

## Default versioning behavior

WorkRail uses conventional commits through `semantic-release`.

Default outcomes:

- `fix` → `patch`
- `feat` → `minor`
- `perf` / `revert` → `patch`
- `docs`, `style`, `chore`, `refactor`, `test`, `build`, `ci` → no release

## Breaking changes

Breaking changes are **not** released as `major` by default.

Instead:

- a breaking change is treated as **`minor` by default**
- it becomes **`major` only when explicitly approved**

Approval is currently controlled by:

- repository variable: **`WORKRAIL_ALLOW_MAJOR_RELEASE=true`**

This means the default behavior is:

- merge the breaking-change commit to `main`
- semantic-release publishes a **minor** version unless major approval is explicitly enabled

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

## Why this policy exists

Major releases are easy to trigger accidentally once a commit is marked as breaking.

The current policy keeps normal release automation simple while making major-version intent explicit:

- **default**: safe downgrade to minor
- **override**: explicit approval for major

## Source of truth

The behavior is implemented in:

- `.releaserc.cjs`
- `.github/workflows/release.yml`
- `.github/workflows/release-dry-run.yml`
