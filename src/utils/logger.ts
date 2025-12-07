/**
 * Legacy logger compatibility layer.
 * 
 * CTC MCP Pattern: Graceful migration - old code keeps working.
 * 
 * This module provides backward compatibility for code using the old
 * createLogger() API. Internally delegates to the new pino-based system.
 * 
 * For new code, use:
 *   import type { Logger } from '../core/logging/index.js';
 *   import { ILoggerFactory } from '../core/logging/index.js';
 *   // Inject via DI
 * 
 * @deprecated Use core/logging module with DI instead
 */

import { createBootstrapLogger } from '../core/logging/index.js';
import type { Logger as PinoLogger } from '../core/logging/index.js';

// Legacy log levels (for reference, not used)
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4
}

/**
 * Legacy Logger wrapper that adapts old API to pino.
 * 
 * Old API: logger.debug(message, data?)
 * Pino API: logger.debug({ data }, message)
 * 
 * This wrapper converts old calls to pino format.
 */
export class Logger {
  constructor(private readonly pino: PinoLogger) {}
  
  debug(message: string, data?: Record<string, unknown>): void {
    if (data) {
      this.pino.debug(data, message);
    } else {
      this.pino.debug(message);
    }
  }
  
  info(message: string, data?: Record<string, unknown>): void {
    if (data) {
      this.pino.info(data, message);
    } else {
      this.pino.info(message);
    }
  }
  
  warn(message: string, errorOrData?: Error | unknown | Record<string, unknown>, data?: Record<string, unknown>): void {
    // Handle legacy signature: warn(message, error?, data?)
    if (errorOrData instanceof Error) {
      const merged = { err: errorOrData, ...data };
      this.pino.warn(merged, message);
    } else if (errorOrData) {
      this.pino.warn(errorOrData as Record<string, unknown>, message);
    } else {
      this.pino.warn(message);
    }
  }
  
  error(message: string, error?: Error | unknown, data?: Record<string, unknown>): void {
    // Handle legacy signature: error(message, error?, data?)
    if (error instanceof Error) {
      const merged = { err: error, ...data };
      this.pino.error(merged, message);
    } else if (error) {
      this.pino.error({ err: error, ...data }, message);
    } else if (data) {
      this.pino.error(data, message);
    } else {
      this.pino.error(message);
    }
  }
  
  child(subComponent: string): Logger {
    return new Logger(this.pino.child({ subComponent }));
  }
}

/**
 * Create a logger for a component.
 * 
 * @deprecated Use ILoggerFactory from DI instead.
 * 
 * This function now delegates to the bootstrap logger for backward
 * compatibility. New code should inject ILoggerFactory via DI.
 * 
 * @param component - Component name for log context
 * @returns Logger instance
 */
export function createLogger(component: string): Logger {
  // Silent delegation - no deprecation warning noise
  // Document migration path in ADR instead
  return new Logger(createBootstrapLogger(component));
}
