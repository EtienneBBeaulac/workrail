import { container, DependencyContainer } from 'tsyringe';
import { DI } from '../../src/di/tokens.js';
import { FakeLoggerFactory } from './FakeLoggerFactory.js';

/**
 * Create a test container with fakes.
 * 
 * CTC MCP Pattern: Isolated test container with controlled dependencies.
 */
export function createTestContainer(): {
  container: DependencyContainer;
  loggerFactory: FakeLoggerFactory;
} {
  // Create child container for isolation
  const testContainer = container.createChildContainer();
  
  // Register fake logger factory
  const loggerFactory = new FakeLoggerFactory();
  testContainer.register(DI.Logging.Factory, { useValue: loggerFactory });
  
  return { container: testContainer, loggerFactory };
}
