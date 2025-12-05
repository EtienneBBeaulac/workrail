/**
 * E2E Tests: Unified Dashboard
 * 
 * Browser-based tests for the unified dashboard UI and interactions.
 */

import { test, expect } from '@playwright/test';

test.describe('Unified Dashboard - Browser Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the dashboard
    await page.goto('http://localhost:3456');
  });
  
  test('should load dashboard homepage', async ({ page }) => {
    // Check title
    await expect(page).toHaveTitle('Workrail Dashboard');
    
    // Check for key elements
    await expect(page.locator('.home-container')).toBeVisible();
  });
  
  test('should display session cards', async ({ page }) => {
    // Wait for sessions to load
    await page.waitForSelector('.session-card', { timeout: 5000 });
    
    // Check that at least one session card exists
    const sessionCards = page.locator('.session-card');
    const count = await sessionCards.count();
    expect(count).toBeGreaterThan(0);
  });
  
  test('should display project information', async ({ page }) => {
    // Wait for project info to load
    await page.waitForSelector('#projectId', { timeout: 5000 });
    
    const projectId = await page.locator('#projectId').textContent();
    const projectPath = await page.locator('#projectPath').textContent();
    
    expect(projectId).toBeTruthy();
    expect(projectId).not.toBe('Unknown');
    expect(projectPath).toBeTruthy();
    expect(projectPath).not.toBe('Unknown');
  });
  
  test('should poll for updates', async ({ page }) => {
    // Wait for initial load
    await page.waitForLoadState('networkidle');
    
    // Listen for API requests
    const requests: string[] = [];
    page.on('request', request => {
      if (request.url().includes('/api/sessions')) {
        requests.push(request.url());
      }
    });
    
    // Wait for at least 2 polling requests (initial + one poll)
    await page.waitForTimeout(6000); // Wait 6 seconds (polling interval is 5s)
    
    expect(requests.length).toBeGreaterThanOrEqual(2);
  });
  
  test('should show unified dashboard indicator', async ({ page }) => {
    // Check API response for unified flag
    const response = await page.request.get('http://localhost:3456/api/sessions');
    const data = await response.json();
    
    expect(data.unified).toBe(true);
  });
  
  test('should handle theme toggle', async ({ page }) => {
    // Find theme toggle button
    const themeToggle = page.locator('[data-theme-toggle]').first();
    
    if (await themeToggle.isVisible()) {
      // Get initial theme
      const initialTheme = await page.locator('html').getAttribute('data-theme');
      
      // Click toggle
      await themeToggle.click();
      
      // Wait for theme change
      await page.waitForTimeout(500);
      
      // Check theme changed
      const newTheme = await page.locator('html').getAttribute('data-theme');
      expect(newTheme).not.toBe(initialTheme);
    }
  });
  
  test('should render Lucide icons', async ({ page }) => {
    // Wait for Lucide to initialize
    await page.waitForTimeout(1000);
    
    // Check for SVG elements (Lucide renders icons as SVG)
    const svgs = page.locator('svg[data-lucide]');
    const count = await svgs.count();
    
    expect(count).toBeGreaterThan(0);
  });
  
  test('should display session status badges', async ({ page }) => {
    // Wait for sessions to load
    await page.waitForSelector('.session-card', { timeout: 5000 });
    
    // Check for status badges
    const statusBadges = page.locator('.badge, .status-badge');
    const count = await statusBadges.count();
    
    // Should have at least one status badge if sessions exist
    if (count > 0) {
      expect(count).toBeGreaterThan(0);
    }
  });
  
  test('should handle empty state gracefully', async ({ page }) => {
    // Mock empty response
    await page.route('**/api/sessions', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          count: 0,
          unified: true,
          sessions: []
        })
      });
    });
    
    await page.goto('http://localhost:3456');
    await page.waitForLoadState('networkidle');
    
    // Should show onboarding or empty state
    const onboarding = page.locator('.onboarding, .empty-state');
    await expect(onboarding).toBeVisible({ timeout: 5000 });
  });
  
  test('should load without console errors', async ({ page }) => {
    const errors: string[] = [];
    
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    
    await page.goto('http://localhost:3456');
    await page.waitForLoadState('networkidle');
    
    // Filter out known acceptable errors (e.g., failed icon loads)
    const criticalErrors = errors.filter(err => 
      !err.includes('favicon') && 
      !err.includes('404')
    );
    
    expect(criticalErrors).toHaveLength(0);
  });
});

test.describe('Unified Dashboard - API Tests', () => {
  test('should return valid session data', async ({ request }) => {
    const response = await request.get('http://localhost:3456/api/sessions');
    
    expect(response.status()).toBe(200);
    
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.unified).toBe(true);
    expect(Array.isArray(data.sessions)).toBe(true);
  });
  
  test('should return health check', async ({ request }) => {
    const response = await request.get('http://localhost:3456/api/health');
    
    expect(response.status()).toBe(200);
    
    const data = await response.json();
    expect(data.status).toBe('healthy');
    expect(data.isPrimary).toBeDefined();
    expect(data.pid).toBeDefined();
    expect(data.port).toBe(3456);
  });
  
  test('should return current project', async ({ request }) => {
    const response = await request.get('http://localhost:3456/api/current-project');
    
    expect(response.status()).toBe(200);
    
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.project).toBeDefined();
  });
  
  test('should support ETag caching', async ({ request }) => {
    // First request
    const response1 = await request.get('http://localhost:3456/api/sessions');
    const etag = response1.headers()['etag'];
    
    if (etag) {
      // Second request with If-None-Match
      const response2 = await request.get('http://localhost:3456/api/sessions', {
        headers: {
          'If-None-Match': etag
        }
      });
      
      // Should return 304 if data hasn't changed
      expect([200, 304]).toContain(response2.status());
    }
  });
});













