import type { Logger } from '../../src/core/logging/index.js';

/**
 * Fake logger for testing.
 * 
 * CTC MCP Pattern: Fakes over mocks - captures calls for assertions.
 */
export interface LogEntry {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  obj?: object;
  msg?: string;
}

export class FakeLogger implements Partial<Logger> {
  readonly entries: LogEntry[] = [];
  level: string = 'debug';
  
  trace(obj: object, msg?: string): void;
  trace(msg: string): void;
  trace(objOrMsg: object | string, msg?: string): void {
    this.log('trace', objOrMsg, msg);
  }
  
  debug(obj: object, msg?: string): void;
  debug(msg: string): void;
  debug(objOrMsg: object | string, msg?: string): void {
    this.log('debug', objOrMsg, msg);
  }
  
  info(obj: object, msg?: string): void;
  info(msg: string): void;
  info(objOrMsg: object | string, msg?: string): void {
    this.log('info', objOrMsg, msg);
  }
  
  warn(obj: object, msg?: string): void;
  warn(msg: string): void;
  warn(objOrMsg: object | string, msg?: string): void {
    this.log('warn', objOrMsg, msg);
  }
  
  error(obj: object, msg?: string): void;
  error(msg: string): void;
  error(objOrMsg: object | string, msg?: string): void {
    this.log('error', objOrMsg, msg);
  }
  
  fatal(obj: object, msg?: string): void;
  fatal(msg: string): void;
  fatal(objOrMsg: object | string, msg?: string): void {
    this.log('fatal', objOrMsg, msg);
  }
  
  child(bindings: object): FakeLogger {
    // Return same instance for simple testing
    // Or create new instance if isolation needed
    return this;
  }
  
  private log(level: LogEntry['level'], objOrMsg: object | string, msg?: string): void {
    if (typeof objOrMsg === 'string') {
      this.entries.push({ level, msg: objOrMsg });
    } else {
      this.entries.push({ level, obj: objOrMsg, msg });
    }
  }
  
  // ═══════════════════════════════════════════════════════════════════
  // Test Helpers
  // ═══════════════════════════════════════════════════════════════════
  
  clear(): void {
    this.entries.length = 0;
  }
  
  hasEntry(level: LogEntry['level'], msgContains: string): boolean {
    return this.entries.some(e => 
      e.level === level && e.msg?.includes(msgContains)
    );
  }
  
  hasEntryMatching(predicate: (entry: LogEntry) => boolean): boolean {
    return this.entries.some(predicate);
  }
  
  getEntries(level?: LogEntry['level']): LogEntry[] {
    return level 
      ? this.entries.filter(e => e.level === level)
      : [...this.entries];
  }
}
