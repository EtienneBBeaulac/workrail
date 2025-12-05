/**
 * Structured logging utility for WorkRail
 * 
 * Best Practices:
 * - Logs to stderr (stdout is reserved for MCP protocol)
 * - Structured JSON format for easy parsing
 * - Configurable log levels via WORKRAIL_LOG_LEVEL env var
 * - Context-aware with component names
 * - Silent by default in production
 * - ISO timestamps for consistency
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4
}

export interface LogEntry {
  timestamp: string;
  level: string;
  component: string;
  message: string;
  data?: Record<string, unknown>;
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
}

export class Logger {
  private readonly component: string;
  private static logLevel: LogLevel = LogLevel.SILENT;
  private static initialized = false;

  constructor(component: string) {
    this.component = component;
    Logger.initializeIfNeeded();
  }

  private static initializeIfNeeded(): void {
    if (Logger.initialized) return;

    // Parse log level from environment
    const envLevel = process.env['WORKRAIL_LOG_LEVEL']?.toUpperCase();
    switch (envLevel) {
      case 'DEBUG':
        Logger.logLevel = LogLevel.DEBUG;
        break;
      case 'INFO':
        Logger.logLevel = LogLevel.INFO;
        break;
      case 'WARN':
        Logger.logLevel = LogLevel.WARN;
        break;
      case 'ERROR':
        Logger.logLevel = LogLevel.ERROR;
        break;
      case 'SILENT':
        Logger.logLevel = LogLevel.SILENT;
        break;
      default:
        // Default to SILENT in production, INFO if explicitly set
        Logger.logLevel = envLevel ? LogLevel.INFO : LogLevel.SILENT;
    }

    Logger.initialized = true;

    // Log initialization (only if not silent)
    if (Logger.logLevel < LogLevel.SILENT) {
      const initLogger = new Logger('Logger');
      initLogger.info('Logger initialized', { logLevel: LogLevel[Logger.logLevel] });
    }
  }

  /**
   * Set log level programmatically (useful for tests)
   */
  static setLogLevel(level: LogLevel): void {
    Logger.logLevel = level;
    Logger.initialized = true;
  }

  /**
   * Get current log level
   */
  static getLogLevel(): LogLevel {
    return Logger.logLevel;
  }

  private shouldLog(level: LogLevel): boolean {
    return level >= Logger.logLevel;
  }

  private write(entry: LogEntry): void {
    // Write to stderr (stdout is for MCP protocol)
    // Use console.error which writes to stderr by default
    if (process.env['WORKRAIL_LOG_FORMAT'] === 'json') {
      console.error(JSON.stringify(entry));
    } else {
      // Human-readable format
      const time = new Date(entry.timestamp).toISOString();
      const prefix = `[${time}] [${entry.level}] [${entry.component}]`;
      const dataStr = entry.data ? ' ' + JSON.stringify(entry.data) : '';
      const errorStr = entry.error ? `\n  Error: ${entry.error.message}\n  Stack: ${entry.error.stack}` : '';
      console.error(`${prefix} ${entry.message}${dataStr}${errorStr}`);
    }
  }

  debug(message: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog(LogLevel.DEBUG)) return;

    this.write({
      timestamp: new Date().toISOString(),
      level: 'DEBUG',
      component: this.component,
      message,
      data
    });
  }

  info(message: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog(LogLevel.INFO)) return;

    this.write({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      component: this.component,
      message,
      data
    });
  }

  warn(message: string, errorOrData?: Error | unknown | Record<string, unknown>, data?: Record<string, unknown>): void {
    if (!this.shouldLog(LogLevel.WARN)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: 'WARN',
      component: this.component,
      message
    };

    // If first optional arg is an Error, treat it as error. Otherwise treat as data.
    if (errorOrData instanceof Error) {
      entry.error = {
        message: errorOrData.message,
        stack: errorOrData.stack,
        code: (errorOrData as any).code
      };
      entry.data = data;
    } else if (errorOrData) {
      entry.data = errorOrData as Record<string, unknown>;
    }

    this.write(entry);
  }

  error(message: string, error?: Error | unknown, data?: Record<string, unknown>): void {
    if (!this.shouldLog(LogLevel.ERROR)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: 'ERROR',
      component: this.component,
      message,
      data
    };

    if (error) {
      if (error instanceof Error) {
        entry.error = {
          message: error.message,
          stack: error.stack,
          code: (error as any).code
        };
      } else {
        entry.error = {
          message: String(error)
        };
      }
    }

    this.write(entry);
  }

  /**
   * Create a child logger with a sub-component name
   */
  child(subComponent: string): Logger {
    return new Logger(`${this.component}:${subComponent}`);
  }
}

/**
 * Create a logger for a component
 */
export function createLogger(component: string): Logger {
  return new Logger(component);
}
