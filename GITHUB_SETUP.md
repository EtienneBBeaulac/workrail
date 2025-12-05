# GitHub Repository Setup Guide

This guide walks you through configuring GitHub repository settings to enforce best practices for code quality and collaboration.

## Branch Protection Rules

To prevent direct pushes to `main` and ensure all changes go through pull requests with CI validation, configure branch protection rules.

### How to Configure

1. Navigate to your GitHub repository
2. Go to **Settings** → **Branches**
3. Click **Add branch protection rule** (or edit existing rule for `main`)
4. Configure the following settings:

### Recommended Settings

#### Branch Name Pattern
```
main
```

#### Protect matching branches

-  **Require a pull request before merging**
  -  Require approvals: `1` (recommended, adjust based on team size)
  -  Dismiss stale pull request approvals when new commits are pushed
  -  Require review from Code Owners (optional, if you use CODEOWNERS file)

-  **Require status checks to pass before merging**
  -  Require branches to be up to date before merging
  - Add the following status checks as required:
    - `Build & Test (Node 20)`
    - `Build & Test (Node 22)`
    - `E2E Tests (Node 20)`
    - `E2E Tests (Node 22)`
    - `Validate Workflows`
    - `CI Success` (overall summary check)

-  **Require conversation resolution before merging** (optional but recommended)

-  **Do not allow bypassing the above settings**
  - This ensures even administrators must follow the rules

-  **Restrict who can push to matching branches**
  - Leave empty to prevent all direct pushes (recommended)
  - Or specify specific teams/users who can push directly (for emergency fixes)

#### Additional Settings

-  **Require linear history** (optional, prevents merge commits)
-  **Require deployments to succeed before merging** (if you have deployments configured)
-  **Lock branch** - Only enable for production-critical branches if needed

### Testing the Setup

After configuring branch protection:

1. Try to push directly to `main`:
   ```bash
   git checkout main
   git commit --allow-empty -m "Test direct push"
   git push origin main
   ```
   This should fail with a message about branch protection.

2. Create a pull request:
   ```bash
   git checkout -b test-branch
   git commit --allow-empty -m "Test PR"
   git push origin test-branch
   ```
   Then create a PR on GitHub - you should see all CI checks running.

## CI Workflow Details

The CI workflow (`.github/workflows/ci.yml`) runs automatically on:
- All pull requests
- Pushes to `main` branch

### Jobs Overview

1. **Build & Test** (Node 20, 22)
   - Installs dependencies
   - Builds the project
   - Runs unit tests
   - Uploads coverage reports

2. **E2E Tests** (Node 20, 22)
   - Installs dependencies
   - Builds the project
   - Installs Playwright browsers
   - Runs end-to-end tests
   - Uploads test reports

3. **Validate Workflows**
   - Validates all workflow JSON files
   - Checks against workflow schema
   - Ensures workflow integrity

4. **CI Success**
   - Summary job that checks all other jobs passed
   - Use this as the single required status check if you prefer

## Troubleshooting

### CI Checks Not Appearing
- Wait for the first PR to run - checks won't appear in the list until they've run at least once
- Verify the workflow file is in `.github/workflows/ci.yml` on the branch
- Check the Actions tab for any workflow errors

### "Required status check is not present"
- This happens when a check hasn't run yet
- Temporarily make the check optional, or wait for it to run once first

### E2E Tests Failing
- Check if Playwright browsers installed correctly
- Review the uploaded Playwright report in the Actions → Artifacts section
- Ensure the dashboard server starts correctly in CI

### Permission Denied on Protected Branch
- This is expected! Create a branch and PR instead
- If you need emergency access, temporarily disable branch protection

## Additional Resources

- [GitHub Branch Protection Documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Status Checks Documentation](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/about-status-checks)


