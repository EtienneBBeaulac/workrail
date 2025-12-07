import pino from 'pino';
import { singleton } from 'tsyringe';
import type { Logger, ILoggerFactory, LogLevel } from './types.js';
import { REDACTION_CONFIG } from './redaction.js';

/**
 * Get log level from environment.
 * 
 * WORKRAIL_LOG_LEVEL: trace | debug | info | warn | error | fatal | silent
 * Default: silent (MCP servers should be quiet unless debugging)
 */
function getLogLevel(): LogLevel {
  const level = process.env['WORKRAIL_LOG_LEVEL']?.toLowerCase();
  const validLevels: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];
  
  if (level && validLevels.includes(level as LogLevel)) {
    return level as LogLevel;
  }
  
  return 'silent';
}

/**
 * Create the root pino logger instance.
 * 
 * CTC MCP Pattern: 
 * - Sync output to stderr (stdout reserved for MCP protocol)
 * - JSON format for machine parsing
 * - Comprehensive redaction for security
 */
function createRootLogger(): Logger {
  return pino(
    {
      level: getLogLevel(),
      
      // Redact sensitive fields
      redact: REDACTION_CONFIG,
      
      // ISO timestamps for consistency
      timestamp: pino.stdTimeFunctions.isoTime,
      
      // Include error stack traces
      serializers: {
        err: pino.stdSerializers.err,
      },
    },
    // Sync output to stderr (fd 2)
    // MCP constraint: stdout is for protocol, stderr for logs
    pino.destination({ dest: 2, sync: true })
  );
}

/**
 * Logger factory - creates component loggers.
 * 
 * CTC MCP Pattern: Injectable factory, singleton lifecycle.
 */
@singleton()
export class PinoLoggerFactory implements ILoggerFactory {
  private readonly _root: Logger;
  
  constructor() {
    this._root = createRootLogger();
  }
  
  get root(): Logger {
    return this._root;
  }
  
  create(component: string): Logger {
    return this._root.child({ component });
  }
}
