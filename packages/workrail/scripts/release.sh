#!/bin/bash
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to display colored output
print_color() {
    color=$1
    message=$2
    echo -e "${color}${message}${NC}"
}

# Function to get current version
get_current_version() {
    grep '"version"' package.json | sed -E 's/.*"version": "(.*)".*/\1/'
}

# Function to show help
show_help() {
    echo "Usage: $0 [OPTIONS]"
    echo
    echo "Options:"
    echo "  --type <patch|minor|major|custom>  Specify version bump type"
    echo "  --version <x.y.z>                  Custom version (required if type=custom)"
    echo "  --desc <description>               Release description"
    echo "  --features <features>              Key features (newline-separated)"
    echo "  --push                             Automatically push to origin (non-interactive)"
    echo "  --no-push                          Skip pushing to origin"
    echo "  --publish                          Automatically publish to npm (non-interactive)"
    echo "  --no-publish                       Skip publishing to npm"
    echo "  --access <public|restricted>       NPM access level (default: public)"
    echo "  --force                            Continue even with uncommitted changes"
    echo "  --help                             Show this help message"
    echo
    echo "If no options are provided, the script runs in interactive mode."
    exit 0
}

# Parse arguments
TYPE=""
CUSTOM_VERSION=""
DESC=""
FEATURES=""
PUSH=""
PUBLISH=""
ACCESS="public"
FORCE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --type) TYPE="$2"; shift 2 ;;
        --version) CUSTOM_VERSION="$2"; shift 2 ;;
        --desc) DESC="$2"; shift 2 ;;
        --features) FEATURES="$2"; shift 2 ;;
        --push) PUSH=true; shift ;;
        --no-push) PUSH=false; shift ;;
        --publish) PUBLISH=true; shift ;;
        --no-publish) PUBLISH=false; shift ;;
        --access) ACCESS="$2"; shift 2 ;;
        --force) FORCE=true; shift ;;
        --help) show_help ;;
        *) print_color "$RED" "Unknown option: $1"; show_help ;;
    esac
done

# Main script
print_color "$BLUE" "🚀 Workrail Release Script"
print_color "$BLUE" "========================="
echo

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    print_color "$RED" "❌ Error: package.json not found. Please run this script from the package root."
    exit 1
fi

# Check if in git repo
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { print_color "$RED" "❌ Not a git repository. Initialize git first."; exit 1; }

# Check for uncommitted changes
if ! $FORCE && ! git diff-index --quiet HEAD --; then
    print_color "$YELLOW" "⚠️  Warning: You have uncommitted changes."
    read -p "Do you want to continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_color "$RED" "Release cancelled."
        exit 1
    fi
fi

# Get current version
CURRENT_VERSION=$(get_current_version)
print_color "$GREEN" "Current version: $CURRENT_VERSION"
echo

# Determine version bump type
if [ -z "$TYPE" ]; then
    print_color "$BLUE" "What type of version bump?"
    echo "1) patch (x.x.X) - Bug fixes"
    echo "2) minor (x.X.0) - New features (backward compatible)"
    echo "3) major (X.0.0) - Breaking changes"
    echo "4) custom - Specify version manually"
    echo "5) cancel"
    echo
    read -p "Select option (1-5): " VERSION_CHOICE
    case $VERSION_CHOICE in
        1) TYPE="patch" ;;
        2) TYPE="minor" ;;
        3) TYPE="major" ;;
        4) TYPE="custom" ;;
        5) print_color "$YELLOW" "Release cancelled."; exit 0 ;;
        *) print_color "$RED" "Invalid option. Release cancelled."; exit 1 ;;
    esac
else
    case $TYPE in
        patch|minor|major|custom) ;;
        *) print_color "$RED" "Invalid type: $TYPE"; exit 1 ;;
    esac
fi

# Handle custom version
if [ "$TYPE" = "custom" ]; then
    if [ -z "$CUSTOM_VERSION" ]; then
        if [ -t 0 ]; then  # Interactive
            read -p "Enter new version (e.g., 1.2.3): " CUSTOM_VERSION
        else
            print_color "$RED" "❌ --version required for custom type in non-interactive mode."
            exit 1
        fi
    fi
fi

# Bump version
if [ "$TYPE" = "custom" ]; then
    NEW_VERSION=$(npm version "$CUSTOM_VERSION" --no-git-tag-version 2>&1) || { print_color "$RED" "❌ Failed to bump version."; exit 1; }
else
    NEW_VERSION=$(npm version "$TYPE" --no-git-tag-version 2>&1) || { print_color "$RED" "❌ Failed to bump version."; exit 1; }
fi

# Strip the 'v' prefix if present
NEW_VERSION=${NEW_VERSION#v}

print_color "$GREEN" "✅ Version bumped to: $NEW_VERSION"
echo

# Get release description
if [ -z "$DESC" ]; then
    print_color "$BLUE" "Enter a brief description of this release (or press Enter to skip):"
    read -r DESC
fi

# Get features
if [ -z "$FEATURES" ]; then
    print_color "$BLUE" "List key features/changes (one per line, empty line to finish):"
    FEATURES=""
    while IFS= read -r line; do
        [ -z "$line" ] && break
        FEATURES="${FEATURES}- ${line}\n"
    done
fi

# Build release notes
RELEASE_NOTES="Release v$NEW_VERSION"
if [ -n "$DESC" ]; then
    RELEASE_NOTES="$RELEASE_NOTES - $DESC"
fi

# Commit version bump
print_color "$BLUE" "📝 Creating commit..."
git add package.json package-lock.json

COMMIT_MSG="chore: release v$NEW_VERSION"
if [ -n "$DESC" ]; then
    COMMIT_MSG="$COMMIT_MSG

$DESC"
fi
if [ -n "$FEATURES" ]; then
    COMMIT_MSG="$COMMIT_MSG

$FEATURES"
fi

git commit -m "$COMMIT_MSG"

if [ $? -eq 0 ]; then
    print_color "$GREEN" "✅ Commit created"
else
    print_color "$RED" "❌ Failed to create commit"
    exit 1
fi

# Create git tag
print_color "$BLUE" "🏷️  Creating git tag..."
TAG_MSG="$RELEASE_NOTES"
if [ -n "$FEATURES" ]; then
    TAG_MSG="$TAG_MSG

$FEATURES"
fi

git tag -a "v$NEW_VERSION" -m "$TAG_MSG"

if [ $? -eq 0 ]; then
    print_color "$GREEN" "✅ Tag v$NEW_VERSION created"
else
    print_color "$RED" "❌ Failed to create tag"
    exit 1
fi

# Handle push
if [ -z "$PUSH" ]; then
    echo
    read -p "Push commits and tags to origin? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        PUSH=true
    else
        PUSH=false
    fi
fi

if $PUSH; then
    print_color "$BLUE" "📤 Pushing to origin..."
    git push origin main --tags
    if [ $? -eq 0 ]; then
        print_color "$GREEN" "✅ Pushed to origin"
    else
        print_color "$YELLOW" "⚠️  Failed to push. You can push manually later with: git push origin main --tags"
    fi
fi

# Handle publish
if [ -z "$PUBLISH" ]; then
    echo
    read -p "Publish to npm? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        PUBLISH=true
    else
        PUBLISH=false
    fi
fi

if $PUBLISH; then
    # Check npm login
    npm whoami >/dev/null 2>&1 || { print_color "$RED" "❌ Not logged into npm. Run 'npm login' first."; exit 1; }

    # If access not specified in args, ask
    if [ -z "$ACCESS" ]; then
        print_color "$BLUE" "Select npm access level:"
        echo "1) public (default)"
        echo "2) restricted"
        read -p "Select option (1-2) [1]: " NPM_ACCESS
        ACCESS="public"
        if [ "$NPM_ACCESS" = "2" ]; then
            ACCESS="restricted"
        fi
    fi

    ACCESS_FLAG="--access $ACCESS"
    print_color "$BLUE" "📦 Publishing to npm..."
    npm publish $ACCESS_FLAG
    
    if [ $? -eq 0 ]; then
        print_color "$GREEN" "✅ Successfully published to npm!"
        print_color "$GREEN" "🎉 Release v$NEW_VERSION complete!"
        echo
        print_color "$BLUE" "Users can now install with:"
        print_color "$YELLOW" "npm install @exaudeus/workrail@$NEW_VERSION"
    else
        print_color "$RED" "❌ Failed to publish to npm"
        print_color "$YELLOW" "You can publish manually later with: npm publish $ACCESS_FLAG"
        exit 1
    fi
else
    print_color "$YELLOW" "📦 Skipped npm publish"
    print_color "$GREEN" "✅ Release v$NEW_VERSION prepared (not published)"
    print_color "$YELLOW" "To publish later, run: npm publish --access public"
fi

echo
print_color "$BLUE" "📋 Summary:"
print_color "$GREEN" "  - Version: $CURRENT_VERSION → $NEW_VERSION"
print_color "$GREEN" "  - Commit: ✅"
print_color "$GREEN" "  - Tag: ✅"
if $PUSH; then
    print_color "$GREEN" "  - Pushed: ✅"
fi
if $PUBLISH; then
    print_color "$GREEN" "  - Published: ✅"
fi

echo
print_color "$BLUE" "Done! 🚀"