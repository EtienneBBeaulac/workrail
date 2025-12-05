#!/bin/bash
# Quick test script for unified dashboard features

set -e  # Exit on error

cd "$(dirname "$0")"

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                                                                ║"
echo "║           🧪 Testing Unified Dashboard Features 🧪             ║"
echo "║                                                                ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Cleanup function
cleanup() {
  if [ ! -z "$MCP_PID" ]; then
    echo "🧹 Cleaning up..."
    kill $MCP_PID 2>/dev/null || true
    sleep 1
  fi
}

trap cleanup EXIT

# Test 1: Primary election
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 1: Primary Election"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
npm run dev > /dev/null 2>&1 &
MCP_PID=$!
echo "Started MCP server (PID: $MCP_PID)"
sleep 3

PRIMARY=$(curl -s http://localhost:3456/api/health 2>/dev/null | jq -r '.isPrimary' 2>/dev/null || echo "false")
if [ "$PRIMARY" = "true" ]; then
  echo "✅ Primary election works"
else
  echo "❌ Primary election failed (isPrimary: $PRIMARY)"
fi

# Test 2: Lock file
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 2: Lock File Management"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ -f ~/.workrail/dashboard.lock ]; then
  LOCK_PID=$(cat ~/.workrail/dashboard.lock | jq -r '.pid' 2>/dev/null || echo "")
  LOCK_PORT=$(cat ~/.workrail/dashboard.lock | jq -r '.port' 2>/dev/null || echo "")
  echo "✅ Lock file exists"
  echo "   PID: $LOCK_PID (current: $MCP_PID)"
  echo "   Port: $LOCK_PORT"
else
  echo "❌ Lock file not found"
fi

# Test 3: API works
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 3: API Responds"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
API_SUCCESS=$(curl -s http://localhost:3456/api/sessions 2>/dev/null | jq -r '.success' 2>/dev/null || echo "false")
API_UNIFIED=$(curl -s http://localhost:3456/api/sessions 2>/dev/null | jq -r '.unified' 2>/dev/null || echo "false")
if [ "$API_SUCCESS" = "true" ]; then
  echo "✅ API responds correctly"
  echo "   Unified: $API_UNIFIED"
else
  echo "❌ API failed (success: $API_SUCCESS)"
fi

# Test 4: Dashboard loads
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 4: Dashboard HTML"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if curl -s http://localhost:3456 2>/dev/null | grep -q "Workrail Dashboard"; then
  echo "✅ Dashboard HTML loads"
else
  echo "❌ Dashboard HTML failed"
fi

# Test 5: Health check
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 5: Health Check Endpoint"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
HEALTH_STATUS=$(curl -s http://localhost:3456/api/health 2>/dev/null | jq -r '.status' 2>/dev/null || echo "unknown")
HEALTH_PORT=$(curl -s http://localhost:3456/api/health 2>/dev/null | jq -r '.port' 2>/dev/null || echo "unknown")
if [ "$HEALTH_STATUS" = "healthy" ]; then
  echo "✅ Health check works"
  echo "   Status: $HEALTH_STATUS"
  echo "   Port: $HEALTH_PORT"
else
  echo "❌ Health check failed (status: $HEALTH_STATUS)"
fi

# Cleanup
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Cleanup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
kill $MCP_PID 2>/dev/null || true
sleep 1

# Test 6: Lock cleanup
if [ ! -f ~/.workrail/dashboard.lock ]; then
  echo "✅ Lock file cleaned up"
else
  echo "⚠️  Lock file still exists (will be cleaned up on next start)"
  rm ~/.workrail/dashboard.lock 2>/dev/null || true
fi

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                                                                ║"
echo "║                    🎉 Tests Complete! 🎉                       ║"
echo "║                                                                ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "📚 For detailed testing, see MANUAL_TESTING_GUIDE.md"
echo "













