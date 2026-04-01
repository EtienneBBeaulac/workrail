# CI Optimization Implementation Plan

## Changes to `.github/workflows/ci.yml`

### 1. Path-based filtering for expensive jobs

Add `paths-ignore` to skip expensive tests for docs-only changes:

**Jobs that will skip on docs-only changes:**
- `build-and-test` (6 jobs - saves ~3-4 mins)
- `e2e-tests` (2 jobs - saves ~1-2 mins)
- `contract-tests` (1 job - saves ~30s)
- `validate-workflows` (1 job - saves ~30s)
- `semantic-release-dry-run` (1 job - saves ~25s)

**Docs-only patterns** (safe to skip tests):
```yaml
paths-ignore:
  - 'docs/**'
  - '*.md'
  - 'CLAUDE.md'
  - 'AGENTS.md'
  - 'README.md'
  - 'CHANGELOG.md'
  - 'LICENSE'
  - '.gitignore'
  - '.editorconfig'
```

**Jobs that always run** (fast, critical invariants):
- `ci-policy` (~20s)
- `lockfile` (~20s)
- `build-artifact` (~40s)
- `typecheck` (~25s)
- `verify-generated` (~25s)
- `security` (informational, continues on error)

### 2. Slim PR matrix, full matrix on main

**Current matrix** (9 jobs total):
```yaml
matrix:
  os: [ubuntu-latest, macos-latest, windows-latest]
  node-version: [20, 22.14.0]
# = 3 OS × 2 Node = 6 build-and-test jobs
# + 2 e2e-tests jobs = 8 total
# + 1 contract-tests = 9 total
```

**New matrix for PRs** (3 jobs):
```yaml
# On pull_request:
matrix:
  os: [ubuntu-latest]
  node-version: [22.14.0]
# = 1 build-and-test job
# + 1 e2e-test job
# + 1 contract-test job = 3 total

# On push to main:
matrix:
  os: [ubuntu-latest, macos-latest, windows-latest]
  node-version: [20, 22.14.0]
# = Full 6 jobs (before release)
```

### 3. Fix `ci-success` to handle conditional jobs

Update the `ci-success` job to properly handle when jobs are skipped:
- Check if jobs were skipped or succeeded
- Use `needs.<job>.result` which can be 'success', 'failure', 'cancelled', or 'skipped'

## Expected Outcomes

### Docs-only PRs (e.g., CLAUDE.md)
- **Before**: 6 minutes (all 9+ jobs)
- **After**: 2 minutes (5 fast jobs only)
- **Savings**: 67% reduction

### Code PRs (any src/, test/, workflow/ changes)
- **Before**: 6 minutes (6 build jobs + 2 e2e + 1 contract)
- **After**: 2.5 minutes (1 build job + 1 e2e + 1 contract on Ubuntu only)
- **Savings**: 58% reduction
- **Safety**: Full matrix still runs on main push before release

### Main branch (release validation)
- **No change**: Full matrix runs to validate before release
- All 6 OS/Node combinations tested
- All platforms verified before npm publish

## Safety Guarantees

✅ **Workflows always validated**: `workflows/` changes trigger full suite
✅ **Schemas always validated**: `spec/` changes trigger full suite  
✅ **Pre-release validation**: Full matrix on main before semantic-release
✅ **No skipped invariants**: ci-policy, lockfile, typecheck, build always run
⚠️ **E2E only on Ubuntu**: Acceptable - Playwright tests are browser/Node behavior, not OS-specific
