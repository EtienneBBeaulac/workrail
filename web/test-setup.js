/**
 * Vitest Test Setup
 * 
 * Global setup for all tests
 */

// Polyfill for fetch if needed
if (!global.fetch) {
  global.fetch = async () => ({ ok: true, json: async () => ({}) });
}

// Mock lucide icons
if (typeof window !== 'undefined') {
  window.lucide = {
    createIcons: () => {}
  };
}

// Add custom matchers if needed
export {};

