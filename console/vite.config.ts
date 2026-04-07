import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { execSync } from 'child_process';

// Use the latest git tag as the version (semantic-release manages tags,
// not package.json version which stays at a dev value on feature branches).
function getVersion(): string {
  try {
    return execSync('git describe --tags --abbrev=0', { encoding: 'utf8' }).trim().replace(/^v/, '');
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(getVersion()),
  },
  // Base path must match the Express mount point (/console)
  // so asset URLs resolve correctly in production.
  base: '/console/',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3456',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist/console',
    emptyOutDir: true,
  },
});
