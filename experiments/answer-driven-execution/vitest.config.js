import { defineConfig } from 'vitest/config';

// Unmet acceptance probes are opt-in; ordinary regression tests remain unchanged.
export default defineConfig({
  test: {
    include: ['experiments/answer-driven-execution/*.probe.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 30000,
    retry: 0,
  },
});
