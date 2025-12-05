import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  publicDir: false,  // We're serving assets directly, not copying them
  
  plugins: [{
    name: 'debug-middleware',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/api')) {
          console.log('[DEBUG] API request intercepted:', req.method, req.url);
        }
        next();
      });
    }
  }],
  
  server: {
    port: 3458,  // Use 3458 to avoid conflict with MCP server on 3456
    open: false,
    cors: true,
    fs: {
      strict: false  // Allow serving files outside root if needed
    },
    // Proxy API requests to the MCP server's HttpServer (runs on 3456)
    proxy: {
      '/api': {
        target: 'http://localhost:3456',
        changeOrigin: true,
        secure: false,
        ws: true,
        logLevel: 'debug'
      }
    }
  },
  
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: 'web/index.html',
        'test-formatters': 'web/test-formatters.html',
        'test-services': 'web/test-services.html',
        'test-session-list': 'web/test-session-list.html'
      }
    }
  },
  
  resolve: {
    alias: {
      '@': '/assets'
    }
  },
  
  // Support for Web Components and Lit
  optimizeDeps: {
    include: ['lit'],
    // Exclude legacy files that have syntax issues (HTML in comments)
    exclude: [
      '/assets/components.js',
      '/assets/background-interaction.js',
      '/assets/workrail-ui.js',
      '/assets/theme-manager.js',
      '/assets/theme-toggle.js',
      '/assets/time-of-day-theme.js',
      '/assets/particle-generator.js'
    ]
  }
});
