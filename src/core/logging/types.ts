import type { Logger as PinoLogger } from 'pino';

/**
 * Logger type - matches pino's Logger exactly.
 * 
 * CTC MCP Pattern: No abstraction, use library types directly.
 * This gives full pino features without wrapper overhead.
 * 
 * API follows pino idiom (data-first):
 *   logger.info({ userId: 123 }, 'User logged in');
 *   logger.error({ err: error }, 'Operation failed');
 */
export type Logger = PinoLogger;

/**
 * Logger factory interface for DI.
 */
export interface ILoggerFactory {
  /** Create a child logger for a component */
  create(component: string): Logger;
  
  /** Root logger instance */
  readonly root: Logger;
}

/**
 * Log level type.
 */
export type LogLevel = 'silent' | 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
