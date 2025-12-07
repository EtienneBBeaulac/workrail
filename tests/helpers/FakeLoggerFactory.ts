import type { ILoggerFactory, Logger } from '../../src/core/logging/index.js';
import { FakeLogger } from './FakeLogger.js';

/**
 * Fake logger factory for testing.
 * 
 * CTC MCP Pattern: Injectable fake for DI tests.
 */
export class FakeLoggerFactory implements ILoggerFactory {
  readonly loggers = new Map<string, FakeLogger>();
  private _root = new FakeLogger();
  
  get root(): Logger {
    return this._root as unknown as Logger;
  }
  
  create(component: string): Logger {
    let logger = this.loggers.get(component);
    if (!logger) {
      logger = new FakeLogger();
      this.loggers.set(component, logger);
    }
    return logger as unknown as Logger;
  }
  
  // Test helpers
  getLogger(component: string): FakeLogger | undefined {
    return this.loggers.get(component);
  }
  
  clearAll(): void {
    this._root.clear();
    this.loggers.forEach(l => l.clear());
  }
}
