#!/bin/bash

# Test script for external workflow feature
# Tests all aspects: unit, integration, and e2e

set -e

echo "🧪 Testing External Workflows Feature"
echo "======================================"
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Change to package directory
cd "$(dirname "$0")/.."

echo -e "${BLUE}📦 Building project...${NC}"
npm run build
echo ""

echo -e "${BLUE}🧪 Running Unit Tests (Authentication)...${NC}"
npx vitest run tests/unit/external-workflow-auth.test.ts
echo ""

echo -e "${BLUE}🧪 Running Integration Tests (Git Operations)...${NC}"
npx vitest run tests/integration/external-workflow-git.test.ts
echo ""

echo -e "${BLUE}🧪 Running E2E Tests (Complete Flow)...${NC}"
npx vitest run tests/e2e/external-workflows-e2e.test.ts
echo ""

echo -e "${GREEN}✅ All External Workflow Tests Passed!${NC}"
echo ""
echo "Test Coverage:"
echo "  ✓ Phase 1: Common services (GitHub, GitLab, Bitbucket)"
echo "  ✓ Phase 2: Self-hosted Git services"
echo "  ✓ Phase 3: SSH key authentication"
echo "  ✓ Token resolution logic"
echo "  ✓ URL format detection"
echo "  ✓ Git clone/pull operations"
echo "  ✓ Multi-source loading"
echo "  ✓ Priority/precedence"
echo "  ✓ Error handling"
echo "  ✓ Complete end-to-end flow"
echo ""
echo -e "${YELLOW}💡 To run specific test suites:${NC}"
echo "  npm test -- external-workflow-auth     # Unit tests"
echo "  npm test -- external-workflow-git      # Integration tests"
echo "  npm test -- external-workflows-e2e     # E2E tests"
echo ""

