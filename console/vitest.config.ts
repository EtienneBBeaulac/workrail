import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    // Hook integration tests need jsdom for React rendering (renderHook).
    // Pure function tests (use cases, reducers) would work in node but
    // jsdom is a superset -- one environment covers both.
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: true,
  },
});
