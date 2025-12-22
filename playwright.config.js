import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  
  // Run tests in parallel
  fullyParallel: true,
  
  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,
  
  // Retry on CI only
  retries: process.env.CI ? 2 : 0,
  
  // Reporter
  reporter: 'html',
  
  // Shared settings
  use: {
    // Base URL to use in actions like `await page.goto('/')`
    baseURL: 'http://localhost:3456',
    
    // Collect trace when retrying the failed test
    trace: 'on-first-retry',
    
    // Screenshot on failure
    screenshot: 'only-on-failure',
  },

  // Configure projects for major browsers
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],

  // Run your local dev server before starting the tests
  webServer: {
    // CI should not rebuild; it should run against the pre-built dist artifact.
    // Local dev stays ergonomic.
    command: process.env.CI ? 'node dist/mcp-server.js' : 'npm run web:dev',
    url: 'http://localhost:3456',
    reuseExistingServer: !process.env.CI,
  },
});

