# Scripts

## release.sh

An interactive release script that automates the entire release process for Workrail.

### Usage

From the package root directory:

```bash
npm run release
# or
./scripts/release.sh
```

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
- Git
- npm authentication (for publishing)
- Bash shell (works on macOS, Linux, Git Bash on Windows) 