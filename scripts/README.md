# Scripts

## Releases

This repository uses **semantic-release** as the **single release authority**.

- **Publishing**: performed by GitHub Actions on pushes to `main` (after CI passes)
- **Versioning/tags**: produced by semantic-release in CI
- **Local release scripts** (`scripts/release.sh`, `scripts/release-new.sh`): intentionally disabled to avoid competing version/tag/publish mechanisms

### Local validation

You can validate what semantic-release would do without publishing:

```bash
npx semantic-release --dry-run --no-ci
```