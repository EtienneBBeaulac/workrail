# Scripts

## release.sh

A flexible release script that automates the entire release process for Workrail. Supports both interactive guided mode and fully automated mode via command-line arguments.

### Usage

From the package root directory:

**Interactive mode (guided):**
```bash
npm run release
# or
./scripts/release.sh
```

**Non-interactive mode (with arguments):**
```bash
# Patch release with description
./scripts/release.sh --type patch --desc "Bug fixes" --push --publish

# Minor release with features
./scripts/release.sh --type minor --desc "New features" --features "Feature 1\nFeature 2" --push --publish

# Custom version
./scripts/release.sh --type custom --version 2.0.0 --desc "Major release" --push --publish --access public

# Skip push/publish
./scripts/release.sh --type patch --desc "Local test" --no-push --no-publish
```

### Command-Line Options

- `--type <patch|minor|major|custom>` - Specify version bump type
- `--version <x.y.z>` - Custom version (required when type=custom)
- `--desc <description>` - Release description
- `--features <features>` - Key features (use \n for newlines)
- `--push` - Automatically push to origin
- `--no-push` - Skip pushing to origin
- `--publish` - Automatically publish to npm
- `--no-publish` - Skip npm publishing
- `--access <public|restricted>` - NPM access level (default: public)
- `--force` - Continue even with uncommitted changes
- `--help` - Show help message

### Features

The script will guide you through:

1. **Version Bumping** - Choose from:
   - `patch` (1.2.X) - For bug fixes
   - `minor` (1.X.0) - For new features (backward compatible)
   - `major` (X.0.0) - For breaking changes
   - `custom` - Specify any version manually

2. **Release Description** - Add a brief description of the release

3. **Feature List** - List key features/changes (optional)

4. **Git Operations**:
   - Creates a commit with the version bump
   - Creates an annotated git tag
   - Optionally pushes to origin

5. **NPM Publishing**:
   - Choose between public or restricted access
   - Handles the build process automatically
   - Shows install command after publishing

### Example Session

```
🚀 Workrail Release Script
=========================

Current version: 0.1.0

What type of version bump?
1) patch (x.x.X) - Bug fixes
2) minor (x.X.0) - New features (backward compatible)
3) major (X.0.0) - Breaking changes
4) custom - Specify version manually
5) cancel

Select option (1-5): 2
✅ Version bumped to: 0.2.0

Enter a brief description of this release (or press Enter to skip):
Add new validation features

List key features/changes (one per line, empty line to finish):
Enhanced schema validation
Performance improvements
Bug fixes

📝 Creating commit...
✅ Commit created
🏷️  Creating git tag...
✅ Tag v0.2.0 created

Push commits and tags to origin? (y/N) y
📤 Pushing to origin...
✅ Pushed to origin

Publish to npm? (y/N) y
Select npm access level:
1) public (default)
2) restricted
Select option (1-2) [1]: 1
📦 Publishing to npm...
✅ Successfully published to npm!
🎉 Release v0.2.0 complete!

Users can now install with:
npm install @exaudeus/workrail@0.2.0

📋 Summary:
  - Version: 0.1.0 → 0.2.0
  - Commit: ✅
  - Tag: ✅
  - Published: ✅

Done! 🚀
```

### Safety Features

- Checks for uncommitted changes before starting
- Confirms each major action before proceeding
- Provides manual commands if any step fails
- Shows clear error messages with recovery instructions

### Requirements

- Node.js and npm
- Git repository initialized
- git push permissions to origin/main
- npm authentication (for publishing with `npm login`)
- Bash shell (works on macOS, Linux, Git Bash on Windows)
- Clean working directory (or use `--force` to override)

### Error Handling & Safety

The enhanced script includes:
- **Strict mode** (`set -euo pipefail`) - Exits on any error
- **Git repository check** - Ensures you're in a git repo
- **NPM login check** - Verifies authentication before publishing
- **Version validation** - Ensures valid semver format
- **Rollback guidance** - Provides manual recovery commands if operations fail

### Safety Features

- Warns about uncommitted changes (use `--force` to override)
- Validates custom versions before proceeding
- Checks npm login status before attempting to publish
- Provides manual fallback commands for failed operations
- Non-destructive - creates commits and tags that can be undone if needed 