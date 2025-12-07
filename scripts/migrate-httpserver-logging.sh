#!/bin/bash

# Migrate HttpServer console calls to pino logger

FILE="src/infrastructure/session/HttpServer.ts"

# Simple replacements
sed -i '' 's/console\.error(\[Dashboard\] Unified dashboard disabled, using legacy mode");/this.logger.info("Unified dashboard disabled, using legacy mode");/g' "$FILE"
sed -i '' "s/console\.error(\[Dashboard\] Port 3456 busy despite lock, falling back to legacy mode');/this.logger.warn('Port 3456 busy despite lock, falling back to legacy mode');/g" "$FILE"
sed -i '' "s/console\.error(\[Dashboard\] ✅ Unified dashboard at http:\/\/localhost:3456');/this.logger.info('Unified dashboard at http:\/\/localhost:3456');/g" "$FILE"
sed -i '' "s/console\.error(\[Dashboard\] Primary elected');/this.logger.info('Primary elected');/g" "$FILE"
sed -i '' "s/console\.error(\[Dashboard\] Cannot write lock file (permission denied)');/this.logger.error('Cannot write lock file (permission denied)');/g" "$FILE"
sed -i '' 's/console\.error(`\[Dashboard\] Lock reclaim needed: \${reason}`);/this.logger.info({ reason }, "Lock reclaim needed");/g' "$FILE"
sed -i '' "s/console\.error(\[Dashboard\] Lock reclaimed successfully');/this.logger.info('Lock reclaimed successfully');/g" "$FILE"
sed -i '' "s/console\.error(\[Dashboard\] Lock deleted during reclaim, trying fresh');/this.logger.info('Lock deleted during reclaim, trying fresh');/g" "$FILE"
sed -i '' 's/console\.error(`\[Dashboard\] Primary (PID \${lockData\.pid}) not responding, attempting graceful shutdown`);/this.logger.warn({ pid: lockData.pid }, "Primary not responding, attempting graceful shutdown");/g' "$FILE"
sed -i '' 's/console\.error(`\[Dashboard\] Primary shutting down (sync cleanup)`);/this.logger.info("Primary shutting down (sync cleanup)");/g' "$FILE"
sed -i '' 's/console\.error(`\[Dashboard\] Lock file released`);/this.logger.debug("Lock file released");/g' "$FILE"
sed -i '' 's/console\.error(`\[Dashboard\] Primary shutting down (async cleanup)`);/this.logger.info("Primary shutting down (async cleanup)");/g' "$FILE"
sed -i '' 's/console\.error(`\[Dashboard\] Received \${signal}`);/this.logger.info({ signal }, "Received signal");/g' "$FILE"
sed -i '' 's/console\.error(`\[Dashboard\] Started in legacy mode on port \${this\.port}`);/this.logger.info({ port: this.port }, "Started in legacy mode");/g' "$FILE"
sed -i '' 's/console\.error(`🔧 Workrail MCP Server Started`);/this.logger.info("Workrail MCP Server Started");/g' "$FILE"
sed -i '' 's/console\.error(`HTTP server stopped`);/this.logger.info("HTTP server stopped");/g' "$FILE"

# SSE error replacements
sed -i '' 's/console\.error(`\[SSE\] Write error for \${workflow}\/\${id}:`, error);/this.logger.error({ err: error, workflow, sessionId: id }, "SSE write error");/g' "$FILE"
sed -i '' 's/console\.error(`\[SSE\] Max connection time reached for \${workflow}\/\${id}, closing`);/this.logger.warn({ workflow, sessionId: id }, "SSE max connection time reached, closing");/g' "$FILE"
sed -i '' 's/console\.error(`\[SSE\] Request error for \${workflow}\/\${id}:`, error);/this.logger.error({ err: error, workflow, sessionId: id }, "SSE request error");/g' "$FILE"
sed -i '' 's/console\.error(`\[SSE\] Response error for \${workflow}\/\${id}:`, error);/this.logger.error({ err: error, workflow, sessionId: id }, "SSE response error");/g' "$FILE"

# Cleanup logging
sed -i '' 's/console\.error(`\[Cleanup\] Found \${busyPorts\.length} workrail process(es), checking health\.\.\.`);/this.logger.info({ count: busyPorts.length }, "Found workrail processes, checking health");/g' "$FILE"
sed -i '' 's/console\.error(`\[Cleanup\] Removing unresponsive process \${pid} on port \${port}`);/this.logger.warn({ pid, port }, "Removing unresponsive process");/g' "$FILE"
sed -i '' 's/console\.error(`\[Cleanup\] Cleaned up \${cleanedCount} orphaned process(es)`);/this.logger.info({ count: cleanedCount }, "Cleaned up orphaned processes");/g' "$FILE"
sed -i '' "s/console\.error(\[Cleanup\] Failed, continuing anyway:', error);/this.logger.warn({ err: error }, 'Cleanup failed, continuing anyway');/g" "$FILE"
sed -i '' 's/console\.error(`\[Cleanup\] No workrail processes found`);/this.logger.info("No workrail processes found");/g' "$FILE"
sed -i '' 's/console\.error(`\[Cleanup\] Found \${busyPorts\.length} workrail process(es), removing all\.\.\.`);/this.logger.info({ count: busyPorts.length }, "Found workrail processes, removing all");/g' "$FILE"
sed -i '' 's/console\.error(`\[Cleanup\] Skipping current process \${pid}`);/this.logger.debug({ pid }, "Skipping current process");/g' "$FILE"
sed -i '' 's/console\.error(`\[Cleanup\] Killing process \${pid} on port \${port}`);/this.logger.info({ pid, port }, "Killing process");/g' "$FILE"
sed -i '' 's/console\.error(`\[Cleanup\] Force killed process \${pid}`);/this.logger.debug({ pid }, "Force killed process");/g' "$FILE"
sed -i '' 's/console\.error(`\[Cleanup\] Process \${pid} terminated gracefully`);/this.logger.debug({ pid }, "Process terminated gracefully");/g' "$FILE"
sed -i '' 's/console\.error(`\[Cleanup\] Failed to kill process \${pid}:`, error);/this.logger.error({ err: error, pid }, "Failed to kill process");/g' "$FILE"
sed -i '' 's/console\.error(`\[Cleanup\] Cleaned up \${cleanedCount} process(es)`);/this.logger.info({ count: cleanedCount }, "Cleaned up processes");/g' "$FILE"
sed -i '' "s/console\.error(\[Cleanup\] Removed lock file');/this.logger.debug('Removed lock file');/g" "$FILE"
sed -i '' "s/console\.error(\[Cleanup\] Full cleanup failed:', error);/this.logger.error({ err: error }, 'Full cleanup failed');/g" "$FILE"

# Special cases with error objects
sed -i '' "s/console\.error(\[HttpServer\] Delete session error:', error);/this.logger.error({ err: error }, 'Delete session error');/g" "$FILE"
sed -i '' "s/console\.error(\[HttpServer\] Bulk delete error:', error);/this.logger.error({ err: error }, 'Bulk delete error');/g" "$FILE"
sed -i '' "s/console\.error(\[Dashboard\] Lock reclaim failed:', error\.message);/this.logger.warn({ err: error }, 'Lock reclaim failed');/g" "$FILE"
sed -i '' "s/console\.error(\[Dashboard\] Lock file corrupted, attempting fresh claim');/this.logger.warn('Lock file corrupted, attempting fresh claim');/g" "$FILE"
sed -i '' "s/console\.error(\[Dashboard\] Server close timeout after 5s, forcing shutdown');/this.logger.warn('Server close timeout after 5s, forcing shutdown');/g" "$FILE"
sed -i '' "s/console\.error(\[Dashboard\] Failed to release lock file:', error\.message);/this.logger.warn({ err: error }, 'Failed to release lock file');/g" "$FILE"
sed -i '' "s/console\.error(\[Dashboard\] Cleanup error:', err);/this.logger.error({ err }, 'Cleanup error');/g" "$FILE"

# Print banner console.error calls (keep them as they're UI output)
echo "Note: Keeping banner/UI console.error calls for user visibility"

echo "Migration complete!"
