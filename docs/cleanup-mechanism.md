# Automatic Process Cleanup Mechanism

## Overview

Workrail implements a hybrid cleanup strategy to prevent orphaned processes from accumulating and blocking ports 3456-3499.

## Features

### 1. **Automatic Startup Cleanup** ✅
- Runs automatically every time the MCP server starts
- Only removes **unresponsive** processes (health check fails)
- Safe - won't kill healthy dashboard instances
- Fast - completes in ~2-3 seconds

### 2. **TTL-Based Lock Expiration** ✅
- Dashboard lock files include a `lastHeartbeat` timestamp
- Primary dashboard updates heartbeat every 30 seconds
- Locks older than 2 minutes are considered stale and auto-reclaimed
- Prevents permanent lock file corruption

### 3. **Manual Cleanup Command** ✅
```bash
# Interactive mode (3 second countdown)
workrail cleanup

# Force mode (no confirmation)
workrail cleanup --force
```

## How It Works

### Startup Flow

```
1. Server starts
   ↓
2. quickCleanup() runs
   ↓ 
3. Find all node processes on ports 3456-3499
   ↓
4. Health check each process (/api/health endpoint)
   ↓
5. Kill unresponsive processes (SIGTERM → SIGKILL)
   ↓
6. Continue with normal startup (become primary or secondary)
```

### Lock Management

```
Primary Dashboard:
├─ Creates lock file with PID, port, timestamps
├─ Updates heartbeat every 30 seconds
├─ Cleans up lock on graceful exit
└─ If crashed: TTL expires after 2 min → lock reclaimed

Secondary Dashboard:
├─ Checks existing lock file
├─ Validates: process alive? responding? heartbeat fresh?
├─ If valid: skip HTTP server (use primary's dashboard)
└─ If invalid: reclaim lock and become primary
```

## Platform Support

| Platform | Command | Status |
|----------|---------|--------|
| macOS    | `lsof`  | ✅ Tested |
| Linux    | `lsof`  | ✅ Should work |
| Windows  | `netstat` | ⚠️ Untested |

## Safety Features

1. **Health Checks**: Only kills processes that don't respond to HTTP health checks
2. **Self-Exclusion**: Never kills the current process
3. **Graceful Shutdown**: Tries SIGTERM first, then SIGKILL after 1 second
4. **Failure Resilience**: Cleanup failures don't block server startup
5. **Process Validation**: Checks both process existence and HTTP responsiveness

## Configuration

### Environment Variables
```bash
# Disable unified dashboard (skip cleanup, use legacy mode)
export WORKRAIL_DISABLE_UNIFIED_DASHBOARD=1
```

### Programmatic
```typescript
const httpServer = new HttpServer(sessionManager, {
  disableUnifiedDashboard: true // Skip cleanup & unified dashboard
});
```

## Troubleshooting

### Problem: Ports still blocked after cleanup

**Solution 1: Manual cleanup**
```bash
workrail cleanup --force
```

**Solution 2: Nuclear option**
```bash
# Kill all node processes on workrail ports
lsof -i :3456-3499 | grep node | awk '{print $2}' | xargs kill -9
```

**Solution 3: Disable unified dashboard**
```bash
export WORKRAIL_DISABLE_UNIFIED_DASHBOARD=1
# Server will use legacy mode with auto-increment ports
```

### Problem: Cleanup too aggressive

If cleanup is killing legitimate processes, check:
1. Is the process responding to `/api/health`?
2. Is the heartbeat updating (check lock file)?
3. Is the process on ports 3456-3499?

## Technical Details

### Port Detection
- **macOS/Linux**: Uses `lsof -i :3456-3499 -Pn | grep node`
- **Windows**: Uses `netstat -ano | findstr "3456"`
- Parses output to extract PID and port number
- Filters to port range 3456-3499

### Health Check
```typescript
fetch(`http://localhost:${port}/api/health`, { timeout: 2000 })
// Expected response: { status: 'healthy', isPrimary: boolean }
```

### Lock File Location
```
~/.workrail/dashboard.lock
```

### Lock File Format
```json
{
  "pid": 12345,
  "port": 3456,
  "startedAt": "2025-11-05T16:48:57.000Z",
  "lastHeartbeat": "2025-11-05T16:50:27.000Z",
  "projectId": "a1b2c3d4e5f6",
  "projectPath": "/Users/you/project"
}
```

## Performance Impact

- **Startup overhead**: ~1-2 seconds (only if processes found)
- **Heartbeat overhead**: Negligible (1 write every 30 seconds)
- **Memory overhead**: None (no background processes)
- **CPU overhead**: None (event-driven cleanup)

## Migration Notes

### From Previous Versions

If upgrading from a version without cleanup:
1. Run `workrail cleanup --force` once to clear old processes
2. Restart your IDE/MCP client
3. New server will use automatic cleanup

### Lock File Migration

Old lock files without `lastHeartbeat` field will:
- Use `startedAt` as fallback for age calculation
- Be treated as stale if > 2 minutes old
- Self-heal on next server start

## Best Practices

1. ✅ **Let automatic cleanup handle most cases** - it's fast and safe
2. ✅ **Use `workrail cleanup` if you hit issues** - manual safety valve
3. ✅ **Monitor stderr logs** - shows what's being cleaned up
4. ❌ **Don't manually kill processes** - use the cleanup command instead
5. ❌ **Don't disable unified dashboard** unless necessary

## Future Improvements

Potential enhancements (not implemented):
- [ ] Configurable TTL duration (currently hardcoded to 2 minutes)
- [ ] Cleanup metrics/telemetry
- [ ] Windows testing and optimization
- [ ] Process registry for better tracking
- [ ] Cleanup hooks for custom behavior

