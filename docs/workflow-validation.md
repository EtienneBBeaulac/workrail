# Workflow Validation

This document describes the workflow validation system and how to use it.

## Overview

All workflow JSON files must pass JSON Schema validation before they can be loaded by the system. Invalid workflows are rejected with clear error messages.

## Validation Layers

### 1. **Runtime Validation (Non-Silent)**
When the MCP server loads workflows, the `SchemaValidatingWorkflowStorage` validates each workflow against the schema. Invalid workflows are now **logged to console** with detailed error messages instead of being silently skipped.

Example error:
```
[SchemaValidation] Workflow 'my-workflow' failed validation: 
  /metaGuidance/19: must NOT have more than 256 characters
```

### 2. **CLI Validation**
Validate individual workflow files using the CLI:

```bash
# Validate a single workflow
node dist/cli.js validate workflows/my-workflow.json

# Or with npm
workrail validate workflows/my-workflow.json
```

### 3. **Batch Validation**
Validate all workflows at once:

```bash
# Via npm script
npm run validate:workflows

# Or directly
bash scripts/validate-workflows.sh
```

This will check all `.json` files in the `workflows/` directory and report:
- ✅ Which workflows passed
- ❌ Which workflows failed (with detailed errors)
- Overall success/failure status

### 4. **Pre-Commit Hook**
A git pre-commit hook automatically validates any workflow files you're about to commit.

**Installation:**
```bash
# Automatic (runs on npm install)
npm install

# Manual
bash scripts/setup-hooks.sh
```

**Behavior:**
- Only runs when workflow files (`.json` in `workflows/`) are being committed
- Validates each changed workflow file
- **Blocks the commit** if any workflow is invalid
- Provides detailed error messages

**Skip the hook (not recommended):**
```bash
git commit --no-verify
```

### 5. **CI/CD Pipeline (GitHub Actions)**
The `.github/workflows/validate-workflows.yml` workflow automatically runs on:
- Pushes to `main` or `develop` branches
- Pull requests targeting `main` or `develop`
- Only when workflow files or the schema changes

**What it does:**
- Installs dependencies
- Builds the project
- Validates all workflow files
- Fails the CI build if any workflow is invalid

## Common Validation Errors

### 1. **String Too Long**
```
/metaGuidance/19: must NOT have more than 256 characters
```
**Fix:** Shorten the string or split it into multiple items.

### 2. **Missing Required Field**
```
Missing required field 'steps' at root level
```
**Fix:** Add the required field to your workflow.

### 3. **Invalid ID Format**
```
/id: must match pattern "^[a-z0-9-]+$"
```
**Fix:** Use only lowercase letters, numbers, and hyphens in workflow IDs.

### 4. **Invalid Step Structure**
```
/steps/0: must have required property 'prompt'
```
**Fix:** Ensure all steps have required fields (id, title, prompt).

## Best Practices

1. **Validate Early**: Run `npm run validate:workflows` before committing
2. **Check CI**: Monitor GitHub Actions to catch validation issues
3. **Never Skip Hooks**: Use `--no-verify` only in emergencies
4. **Keep Strings Short**: metaGuidance and other string fields have 256-char limits
5. **Test Locally**: Use the CLI to validate before pushing

## Troubleshooting

### Hook Not Running
```bash
# Reinstall hooks
bash scripts/setup-hooks.sh

# Verify hook exists
ls -la .git/hooks/pre-commit
```

### Validation Script Fails
```bash
# Rebuild the project first
npm run build

# Then try again
npm run validate:workflows
```

### Silent Failures (Old Behavior)
If workflows are being silently rejected:
1. Check the MCP server console logs for `[SchemaValidation]` errors
2. Run `npm run validate:workflows` to see all validation errors
3. Update to the latest version with non-silent validation

## Schema Location

The workflow schema is located at:
```
spec/workflow.schema.json
```

To view the complete schema:
```bash
cat spec/workflow.schema.json
```

Or get it programmatically:
```bash
workrail get-schema
```

## Workflow Development Workflow

Recommended workflow for creating/modifying workflows:

1. **Edit** your workflow JSON file
2. **Validate** locally: `npm run validate:workflows`
3. **Test** by loading it in the MCP server
4. **Commit** (hook will validate again)
5. **Push** and check CI

This multi-layer validation ensures invalid workflows never reach production.















