import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['experiments/answer-driven-execution/cross-version.fixture.ts'], environment: 'node', fileParallelism: false, retry: 0, testTimeout: 30000 } });
