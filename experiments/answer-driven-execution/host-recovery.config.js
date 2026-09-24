import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['experiments/answer-driven-execution/host-recovery.fixture.ts'],
    environment: 'node',
    fileParallelism: false,
    retry: 0,
    testTimeout: 60000,
    hookTimeout: 30000,
  },
});
