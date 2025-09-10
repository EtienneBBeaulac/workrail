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

# Function to get package name
get_package_name() {
    grep '"name"' package.json | sed -E 's/.*"name": "([^"]+)".*/\1/'
}

# Function to show help
show_help() {
    echo "Usage: $0 [OPTIONS]"
    echo
    echo "Options:"
    echo "  --interactive                      Run in interactive mode (prompts for all values)"
    echo "  --type <patch|minor|major|prerelease|custom>  Specify version bump type"
    echo "  --preid <identifier>               Pre-release id (e.g., beta, rc) when type=prerelease"
    echo "  --version <x.y.z>                  Custom version (required if type=custom)"
    echo "  --desc <description>               Release description"
    echo "  --features <features>              Key features (use config file for multi-line)"
    echo "  --push                             Automatically push to origin"
    echo "  --no-push                          Skip pushing to origin"
    echo "  --publish                          Automatically publish to npm"
    echo "  --no-publish                       Skip publishing to npm"
    echo "  --access <public|restricted>       NPM access level (default: public)"
    echo "  --tag <dist-tag>                   NPM dist-tag (e.g., beta, next). Defaults to preid for prerelease"
    echo "  --force                            Continue even with uncommitted changes"
    echo "  --migrate                          Convert current command to .releaserc format"
    echo "  --help                             Show this help message"
    echo
    echo "Config File:"
    echo "  Create a .releaserc file to set defaults. See .releaserc.example for format."
    echo
    echo "Mode Selection:"
    echo "  Default: Batch mode (fails if required arguments missing)"
    echo "  Use --interactive for interactive mode with prompts"
    echo
    echo "Examples:"
    echo "  $0 --type minor --desc \"Bug fixes\" --push --publish"
    echo "  $0 --interactive"
    echo "  $0  # Uses .releaserc if present"
    echo
    exit 0
}

# Detect mode from arguments
MODE="batch"  # default to batch mode
for arg in "$@"; do
    if [ "$arg" = "--interactive" ]; then
        MODE="interactive"
        break
    fi
done

# Initialize variables with defaults
TYPE=""
CUSTOM_VERSION=""
DESC=""
FEATURES=""
PUSH=""
PUBLISH=""
ACCESS="public"
FORCE=false
PREID=""
DIST_TAG=""

# Load config file if it exists
if [ -f ".releaserc" ]; then
    print_color "$BLUE" "📋 Loading configuration from .releaserc"
    source .releaserc
    
    # Map config variables to script variables
    TYPE="${RELEASE_TYPE:-}"
    CUSTOM_VERSION="${RELEASE_VERSION:-}"
    DESC="${RELEASE_DESC:-}"
    FEATURES="${RELEASE_FEATURES:-}"
    [ "${RELEASE_PUSH:-}" = "true" ] && PUSH=true
    [ "${RELEASE_PUSH:-}" = "false" ] && PUSH=false
    [ "${RELEASE_PUBLISH:-}" = "true" ] && PUBLISH=true
    [ "${RELEASE_PUBLISH:-}" = "false" ] && PUBLISH=false
    ACCESS="${RELEASE_ACCESS:-public}"
    [ "${RELEASE_FORCE:-}" = "true" ] && FORCE=true || FORCE=false
    PREID="${RELEASE_PREID:-}"
    DIST_TAG="${RELEASE_TAG:-}"
fi

# Parse command line arguments (these override config file)
CMD_TYPE=""
CMD_CUSTOM_VERSION=""
CMD_DESC=""
CMD_FEATURES=""
CMD_PUSH=""
CMD_PUBLISH=""
CMD_ACCESS=""
CMD_FORCE=false
SHOW_MIGRATE=false
CMD_PREID=""
CMD_DIST_TAG=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --interactive) shift ;; # Already processed above
        --type) CMD_TYPE="$2"; shift 2 ;;
        --version) CMD_CUSTOM_VERSION="$2"; shift 2 ;;
        --desc) CMD_DESC="$2"; shift 2 ;;
        --features) CMD_FEATURES="$2"; shift 2 ;;
        --push) CMD_PUSH=true; shift ;;
        --no-push) CMD_PUSH=false; shift ;;
        --publish) CMD_PUBLISH=true; shift ;;
        --no-publish) CMD_PUBLISH=false; shift ;;
        --access) CMD_ACCESS="$2"; shift 2 ;;
        --preid) CMD_PREID="$2"; shift 2 ;;
        --tag) CMD_DIST_TAG="$2"; shift 2 ;;
        --force) CMD_FORCE=true; shift ;;
        --migrate) SHOW_MIGRATE=true; shift ;;
        --help) show_help ;;
        *) print_color "$RED" "Unknown option: $1"; show_help ;;
    esac
done

# Command line arguments override config file
[ -n "$CMD_TYPE" ] && TYPE="$CMD_TYPE"
[ -n "$CMD_CUSTOM_VERSION" ] && CUSTOM_VERSION="$CMD_CUSTOM_VERSION"
[ -n "$CMD_DESC" ] && DESC="$CMD_DESC"
[ -n "$CMD_FEATURES" ] && FEATURES="$CMD_FEATURES"
[ -n "$CMD_PUSH" ] && PUSH="$CMD_PUSH"
[ -n "$CMD_PUBLISH" ] && PUBLISH="$CMD_PUBLISH"
[ -n "$CMD_ACCESS" ] && ACCESS="$CMD_ACCESS"
[ "$CMD_FORCE" = true ] && FORCE=true
[ -n "$CMD_PREID" ] && PREID="$CMD_PREID"
[ -n "$CMD_DIST_TAG" ] && DIST_TAG="$CMD_DIST_TAG"

# Handle --migrate flag
if [ "$SHOW_MIGRATE" = true ]; then
    print_color "$BLUE" "🔄 Generating .releaserc from current arguments..."
    cat > .releaserc <<EOF
# Generated by release.sh --migrate
RELEASE_TYPE="${TYPE:-minor}"
RELEASE_VERSION="${CUSTOM_VERSION:-}"
RELEASE_DESC="${DESC:-}"
RELEASE_FEATURES="${FEATURES:-}"
RELEASE_PUSH=${PUSH:-true}
RELEASE_PUBLISH=${PUBLISH:-true}
RELEASE_ACCESS="${ACCESS:-public}"
RELEASE_FORCE=${FORCE:-false}
EOF
    print_color "$GREEN" "✅ Created .releaserc file"
    print_color "$YELLOW" "📝 Please review and edit .releaserc as needed"
    exit 0
fi

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

# Get current version
CURRENT_VERSION=$(get_current_version)
print_color "$GREEN" "Current version: $CURRENT_VERSION"
print_color "$GREEN" "Mode: $MODE"
echo

# Batch mode validation - fail fast if required arguments are missing
if [ "$MODE" = "batch" ]; then
    ERRORS=()
    
    # Check required arguments
    if [ -z "$TYPE" ]; then
        ERRORS+=("❌ Missing required argument: --type (or RELEASE_TYPE in .releaserc)")
    fi
    
    if [ "$TYPE" = "custom" ] && [ -z "$CUSTOM_VERSION" ]; then
        ERRORS+=("❌ Missing required argument: --version (required when --type=custom)")
    fi
    
    # If we have errors, display them and exit
    if [ ${#ERRORS[@]} -gt 0 ]; then
        print_color "$RED" "Batch mode validation failed:"
        for error in "${ERRORS[@]}"; do
            print_color "$RED" "  $error"
        done
        echo
        print_color "$YELLOW" "Options:"
        print_color "$YELLOW" "  1. Create a .releaserc file with required values"
        print_color "$YELLOW" "  2. Provide missing arguments on command line"
        print_color "$YELLOW" "  3. Use --interactive mode for prompts"
        echo
        print_color "$BLUE" "Example .releaserc:"
        cat <<EOF
RELEASE_TYPE="minor"
RELEASE_DESC="Bug fixes and improvements"
RELEASE_FEATURES="- Fixed authentication bug
- Improved performance"
EOF
        exit 1
    fi
    
    # In batch mode, check for uncommitted changes
    if ! $FORCE && ! git diff-index --quiet HEAD --; then
        print_color "$RED" "❌ Error: Uncommitted changes detected in batch mode."
        print_color "$YELLOW" "Options:"
        print_color "$YELLOW" "  1. Commit your changes first"
        print_color "$YELLOW" "  2. Use --force to proceed anyway"
        print_color "$YELLOW" "  3. Use --interactive mode"
        exit 1
    fi
fi

# Check for uncommitted changes (only prompt in interactive mode)
if ! $FORCE && ! git diff-index --quiet HEAD -- && [ "$MODE" = "interactive" ]; then
    print_color "$YELLOW" "⚠️  Warning: You have uncommitted changes."
    read -p "Do you want to continue anyway? (y/N) " -n 1 -r < /dev/tty
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_color "$RED" "Release cancelled."
        exit 1
    fi
fi

# Determine version bump type
if [ -z "$TYPE" ] && [ "$MODE" = "interactive" ]; then
    print_color "$BLUE" "What type of version bump?"
    echo "1) patch (x.x.X) - Bug fixes"
    echo "2) minor (x.X.0) - New features (backward compatible)"
    echo "3) major (X.0.0) - Breaking changes"
    echo "4) prerelease (x.y.z-<preid>.<n>) - Beta/RC"
    echo "5) custom - Specify version manually"
    echo "6) cancel"
    echo
    read -p "Select option (1-5): " VERSION_CHOICE < /dev/tty
    case $VERSION_CHOICE in
        1) TYPE="patch" ;;
        2) TYPE="minor" ;;
        3) TYPE="major" ;;
        4) TYPE="prerelease" ;;
        5) TYPE="custom" ;;
        6) print_color "$YELLOW" "Release cancelled."; exit 0 ;;
        *) print_color "$RED" "Invalid option. Release cancelled."; exit 1 ;;
    esac
fi

# Validate type
case $TYPE in
    patch|minor|major|prerelease|custom) ;;
    *) print_color "$RED" "Invalid type: $TYPE"; exit 1 ;;
esac

# Handle custom version
if [ "$TYPE" = "custom" ]; then
    if [ -z "$CUSTOM_VERSION" ]; then
        if [ "$MODE" = "interactive" ]; then
            read -p "Enter new version (e.g., 1.2.3): " CUSTOM_VERSION < /dev/tty
        else
            print_color "$RED" "❌ --version required for custom type in batch mode."
            print_color "$YELLOW" "Provide it via --version or RELEASE_VERSION in .releaserc"
            exit 1
        fi
    fi
fi

# Bump version
if [ "$TYPE" = "custom" ]; then
    npm version "$CUSTOM_VERSION" --no-git-tag-version --silent || { print_color "$RED" "❌ Failed to bump version."; exit 1; }
else
    if [ "$TYPE" = "prerelease" ]; then
        if [ -z "$PREID" ]; then PREID="beta"; fi
        npm version prerelease --preid "$PREID" --no-git-tag-version --silent || { print_color "$RED" "❌ Failed to bump prerelease version."; exit 1; }
    else
        npm version "$TYPE" --no-git-tag-version --silent || { print_color "$RED" "❌ Failed to bump version."; exit 1; }
    fi
fi

# Get the new version from package.json
NEW_VERSION=$(get_current_version)
PKG_NAME=$(get_package_name)

print_color "$GREEN" "✅ Version bumped to: $NEW_VERSION"
echo

# Get release description
if [ -z "$DESC" ] && [ "$MODE" = "interactive" ]; then
    print_color "$BLUE" "Enter a brief description of this release (or press Enter to skip):"
    read -r DESC < /dev/tty
fi

# Get features
if [ -z "$FEATURES" ] && [ "$MODE" = "interactive" ]; then
    print_color "$BLUE" "List key features/changes (one per line, empty line to finish):"
    FEATURES=""
    while IFS= read -r line < /dev/tty; do
        [ -z "$line" ] && break
        FEATURES="${FEATURES}- ${line}\n"
    done
fi

# In batch mode, show what will be committed
if [ "$MODE" = "batch" ]; then
    print_color "$BLUE" "📋 Release Configuration:"
    echo "  Type: $TYPE"
    echo "  Version: $CURRENT_VERSION → $NEW_VERSION"
    [ -n "$DESC" ] && echo "  Description: $DESC"
    if [ -n "$FEATURES" ]; then
        echo "  Features:"
        echo -e "$FEATURES" | sed 's/^/    /'
    fi
    echo
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
    if [ "$MODE" = "interactive" ]; then
        echo
        read -p "Push commits and tags to origin? (y/N) " -n 1 -r < /dev/tty
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            PUSH=true
        else
            PUSH=false
        fi
    else
        # In batch mode, default to not pushing unless explicitly set
        PUSH=false
    fi
fi

if [ "$PUSH" = true ]; then
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
    if [ "$MODE" = "interactive" ]; then
        echo
        read -p "Publish to npm? (y/N) " -n 1 -r REPLY < /dev/tty
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            PUBLISH=true
        else
            PUBLISH=false
        fi
    else
        # In batch mode, default to not publishing unless explicitly set
        PUBLISH=false
    fi
fi

if [ "$PUBLISH" = true ]; then
    # Check npm login
    npm whoami >/dev/null 2>&1 || { print_color "$RED" "❌ Not logged into npm. Run 'npm login' first."; exit 1; }

    # If access not specified, ask (only in interactive mode)
    if [ -z "$ACCESS" ] && [ "$MODE" = "interactive" ]; then
        print_color "$BLUE" "Select npm access level:"
        echo "1) public (default)"
        echo "2) restricted"
        read -p "Select option (1-2) [1]: " NPM_ACCESS < /dev/tty
        ACCESS="public"
        if [ "$NPM_ACCESS" = "2" ]; then
            ACCESS="restricted"
        fi
    fi

    ACCESS_FLAG="--access $ACCESS"
    if [ -z "$DIST_TAG" ] && [ "$TYPE" = "prerelease" ]; then
        DIST_TAG="$PREID"
    fi
    TAG_FLAG=""
    if [ -n "$DIST_TAG" ]; then
        TAG_FLAG="--tag $DIST_TAG"
    fi
    print_color "$BLUE" "📦 Publishing to npm..."
    npm publish $ACCESS_FLAG $TAG_FLAG
    
    if [ $? -eq 0 ]; then
        print_color "$GREEN" "✅ Successfully published to npm!"
        print_color "$GREEN" "🎉 Release v$NEW_VERSION complete!"
        # Ensure beta is always ahead or equal to latest: tag beta to this stable release as well
        if [ "$TYPE" != "prerelease" ]; then
            print_color "$BLUE" "🏷️  Tagging dist-tag 'beta' → $NEW_VERSION..."
            npm dist-tag add "$PKG_NAME@$NEW_VERSION" beta || print_color "$YELLOW" "⚠️  Failed to set beta tag; you can run: npm dist-tag add $PKG_NAME@$NEW_VERSION beta"
        fi
        echo
        print_color "$BLUE" "Users can now install with:"
        if [ -n "$DIST_TAG" ]; then
            print_color "$YELLOW" "npm install @exaudeus/workrail@$DIST_TAG"
            print_color "$YELLOW" "npx -y @exaudeus/workrail@$DIST_TAG"
        else
            print_color "$YELLOW" "npm install @exaudeus/workrail@$NEW_VERSION"
        fi
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
if [ "$PUSH" = true ]; then
    print_color "$GREEN" "  - Pushed: ✅"
fi
if [ "$PUBLISH" = true ]; then
    print_color "$GREEN" "  - Published: ✅"
fi

echo
print_color "$BLUE" "Done! 🚀"