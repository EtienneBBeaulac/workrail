
import pino from 'pino';
import type { Logger } from './types.js';
import { REDACTION_CONFIG } from './redaction.js';

/**
 * Bootstrap logger for use BEFORE DI container is initialized.
 * 
 * CTC MCP Pattern: Explicit bootstrap phase.
 * 
 * Used by:
 * - container.ts during initialization
 * - Early startup code
 * 
 * After DI is ready, use injected ILoggerFactory instead.
 */
let _bootstrapLogger: Logger | null = null;

export function getBootstrapLogger(): Logger {
  if (!_bootstrapLogger) {
    const level = process.env['WORKRAIL_LOG_LEVEL']?.toLowerCase() || 'silent';
    
    _bootstrapLogger = pino(
      {
        level,
        redact: REDACTION_CONFIG,
        timestamp: pino.stdTimeFunctions.isoTime,
      },
      pino.destination({ dest: 2, sync: true })
    );
  }
  
  return _bootstrapLogger;
}

/**
 * Create a bootstrap logger with component context.
 * 
 * For use in modules that load before DI.
 */
export function createBootstrapLogger(component: string): Logger {
  return getBootstrapLogger().child({ component });
}
