/**
 * Vitest configuration for Workrail tests
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Use jsdom for browser-like environment
    environment: 'jsdom',
    
    // Test file patterns - only TypeScript tests (*.ts), not compiled JS outputs
    // The *.test.js files in tests/ are compiled outputs that use Jest globals
    include: ['tests/**/*.test.ts', 'web/**/*.test.js'],
    
    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['web/assets/**/*.js'],
      exclude: [
        'web/assets/**/*.test.js',
        'node_modules/**'
      ],
      thresholds: {
        branches: 70,
        functions: 75,
        lines: 80,
        statements: 80
      }
    },
    
    // Setup files
    setupFiles: ['./tests/setup.js'],
    
    // Globals (like jest)
    globals: true,
    
    // Clear mocks between tests
    clearMocks: true
  }
});
