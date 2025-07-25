#!/bin/bash

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

# Main script
print_color "$BLUE" "🚀 Workrail Release Script"
print_color "$BLUE" "========================="
echo

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    print_color "$RED" "❌ Error: package.json not found. Please run this script from the package root."
    exit 1
fi

# Check for uncommitted changes
if ! git diff-index --quiet HEAD --; then
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

# Ask for version bump type
print_color "$BLUE" "What type of version bump?"
echo "1) patch (x.x.X) - Bug fixes"
echo "2) minor (x.X.0) - New features (backward compatible)"
echo "3) major (X.0.0) - Breaking changes"
echo "4) custom - Specify version manually"
echo "5) cancel"
echo

read -p "Select option (1-5): " VERSION_CHOICE

case $VERSION_CHOICE in
    1)
        VERSION_TYPE="patch"
        NEW_VERSION=$(npm version patch --no-git-tag-version)
        ;;
    2)
        VERSION_TYPE="minor"
        NEW_VERSION=$(npm version minor --no-git-tag-version)
        ;;
    3)
        VERSION_TYPE="major"
        NEW_VERSION=$(npm version major --no-git-tag-version)
        ;;
    4)
        read -p "Enter new version (e.g., 1.2.3): " CUSTOM_VERSION
        VERSION_TYPE="custom"
        NEW_VERSION=$(npm version $CUSTOM_VERSION --no-git-tag-version)
        ;;
    5)
        print_color "$YELLOW" "Release cancelled."
        exit 0
        ;;
    *)
        print_color "$RED" "Invalid option. Release cancelled."
        exit 1
        ;;
esac

# Strip the 'v' prefix if present
NEW_VERSION=${NEW_VERSION#v}

print_color "$GREEN" "✅ Version bumped to: $NEW_VERSION"
echo

# Ask for release description
print_color "$BLUE" "Enter a brief description of this release (or press Enter to skip):"
read -r RELEASE_DESC

# Build release notes
RELEASE_NOTES="Release v$NEW_VERSION"
if [ -n "$RELEASE_DESC" ]; then
    RELEASE_NOTES="$RELEASE_NOTES - $RELEASE_DESC"
fi

# Ask for key features (optional)
print_color "$BLUE" "List key features/changes (one per line, empty line to finish):"
FEATURES=""
while IFS= read -r line; do
    [ -z "$line" ] && break
    FEATURES="${FEATURES}- ${line}\n"
done

# Commit version bump
print_color "$BLUE" "📝 Creating commit..."
git add package.json package-lock.json

COMMIT_MSG="chore: release v$NEW_VERSION"
if [ -n "$RELEASE_DESC" ]; then
    COMMIT_MSG="$COMMIT_MSG

$RELEASE_DESC"
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

# Ask if user wants to push to remote
echo
read -p "Push commits and tags to origin? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    print_color "$BLUE" "📤 Pushing to origin..."
    git push origin main --tags
    if [ $? -eq 0 ]; then
        print_color "$GREEN" "✅ Pushed to origin"
    else
        print_color "$YELLOW" "⚠️  Failed to push. You can push manually later with: git push origin main --tags"
    fi
fi

# Ask if user wants to publish to npm
echo
read -p "Publish to npm? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    # Ask for npm access level
    print_color "$BLUE" "Select npm access level:"
    echo "1) public (default)"
    echo "2) restricted"
    read -p "Select option (1-2) [1]: " NPM_ACCESS
    
    ACCESS_FLAG="--access public"
    if [ "$NPM_ACCESS" = "2" ]; then
        ACCESS_FLAG="--access restricted"
    fi
    
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
if [[ $REPLY =~ ^[Yy]$ ]] && [ $? -eq 0 ]; then
    print_color "$GREEN" "  - Published: ✅"
fi

echo
print_color "$BLUE" "Done! 🚀" 