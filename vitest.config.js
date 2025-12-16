/**
 * Vitest configuration for Workrail tests
 */

import { defineConfig } from 'vitest/config';

const shared = {
  // Setup files
  setupFiles: ['./tests/setup.ts'],

  // Globals (like jest)
  globals: true,

  // Clear mocks between tests
  clearMocks: true,

  // Increase timeouts for Git integration tests (slow cloning + file I/O)
  testTimeout: 10000,  // 10s for tests (default is 5s)
  hookTimeout: 30000,  // 30s for beforeAll/afterAll hooks
};

export default defineConfig({
  test: {
    // Split into projects so we can run most tests in node (low memory),
    // while keeping web UI tests in jsdom.
    //
    // Vitest runs test files in parallel workers by default.
    // Cap worker count to avoid spawning many heavy environments at once.
    // Override locally with VITEST_MAX_THREADS=... when needed.
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          pool: 'threads',
          poolOptions: {
            threads: {
              minThreads: 1,
              maxThreads: Number(process.env.VITEST_MAX_THREADS ?? 4),
            },
          },
          ...shared,
        },
      },
      {
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['web/**/*.test.js'],
          pool: 'threads',
          poolOptions: {
            threads: {
              minThreads: 1,
              maxThreads: Number(process.env.VITEST_MAX_THREADS_WEB ?? 2),
            },
          },
          ...shared,
        },
      },
    ],
    
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
  }
});
