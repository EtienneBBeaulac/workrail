/**
 * Vitest setup file
 * Runs before all tests
 */

// Required for tsyringe DI decorators
import 'reflect-metadata';

import { vi } from 'vitest';

// Global test resource tracking
const globalResources = new Set();

// Helper to track resources for cleanup
export function trackResource(cleanupFn) {
  globalResources.add(cleanupFn);
}

// Helper to remove tracked resource
export function untrackResource(cleanupFn) {
  globalResources.delete(cleanupFn);
}

// Provide Jest compatibility for test files that use jest.* APIs
// This allows gradual migration from Jest to Vitest
globalThis.jest = vi;

// Mock browser APIs that aren't in jsdom
global.EventSource = class EventSource {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
  }
  
  close() {
    this.readyState = 2;
  }
};

// Mock lucide icons
global.lucide = {
  createIcons: vi.fn(),
  icons: {},
  createElement: vi.fn()
};

// Add custom matchers
expect.extend({
  toBeValidComponent(received) {
    const pass = received && 
                  typeof received === 'object' && 
                  received.component && 
                  typeof received.component === 'string' &&
                  received.props !== undefined &&
                  typeof received.priority === 'number';
    
    return {
      pass,
      message: () => pass
        ? `expected ${received} not to be a valid component spec`
        : `expected ${received} to be a valid component spec with component, props, and priority`
    };
  }
});
