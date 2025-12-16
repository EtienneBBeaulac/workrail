/**
 * Vitest setup file (TypeScript version)
 * Runs before all tests
 */

// Required for tsyringe DI decorators
import 'reflect-metadata';

import { config } from 'dotenv';
import { beforeAll, afterAll, vi } from 'vitest';
import { teardownTest } from './di/test-container.js';

// Load environment variables from .env file - suppress console output
config();

// Global test resource tracking
const globalResources = new Set<() => Promise<void>>();

// Provide Jest compatibility for test files that use jest.* APIs
// This allows gradual migration from Jest to Vitest
(globalThis as unknown as { jest: typeof vi }).jest = vi;

// Global test setup
beforeAll(() => {
  // Setup any global test configuration
  console.log('🧪 Vitest environment initialized');
});

afterAll(async () => {
  // Cleanup DI container
  teardownTest();
  
  // Cleanup any global test resources
  console.log('🧹 Cleaning up global test resources...');
  
  // Clean up all tracked resources
  for (const cleanup of globalResources) {
    try {
      await cleanup();
    } catch (error) {
      console.error('Error during resource cleanup:', error);
    }
  }
  
  globalResources.clear();
  console.log('✅ Global test cleanup completed');
});

// Helper to track resources for cleanup
export function trackResource(cleanupFn: () => Promise<void>): void {
  globalResources.add(cleanupFn);
}

// Helper to remove tracked resource
export function untrackResource(cleanupFn: () => Promise<void>): void {
  globalResources.delete(cleanupFn);
}

// Mock browser APIs that aren't in jsdom
(global as unknown as { EventSource: unknown }).EventSource = class EventSource {
  url: string;
  readyState: number;
  
  constructor(url: string) {
    this.url = url;
    this.readyState = 0;
  }
  
  close(): void {
    this.readyState = 2;
  }
};

// Mock lucide icons
(global as unknown as { lucide: unknown }).lucide = {
  createIcons: vi.fn(),
  icons: {},
  createElement: vi.fn()
};

// NOTE: Do not register process-level signal handlers in tests.
// Vitest owns the process lifecycle; cleanup should happen via test hooks above.
