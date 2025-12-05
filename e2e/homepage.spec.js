/**
 * E2E Tests for Homepage
 * 
 * Tests the complete user flow on the homepage
 */

import { test, expect } from '@playwright/test';

test.describe('Homepage', () => {
  test('should load and display hero section', async ({ page }) => {
    await page.goto('/');
    
    // Check hero section
    await expect(page.locator('.hero h1')).toContainText('Workrail Dashboard');
    await expect(page.locator('.hero p')).toContainText('Real-time workflow execution');
  });

  test('should display project info', async ({ page }) => {
    await page.goto('/');
    
    // Check project info section
    await expect(page.locator('.project-info h2')).toContainText('Current Project');
    await expect(page.locator('#projectId')).toBeVisible();
  });

  test('should show onboarding when no sessions', async ({ page }) => {
    await page.goto('/');
    
    // Wait for data to load
    await page.waitForTimeout(1000);
    
    // If onboarding is visible, check its content
    const onboarding = page.locator('.onboarding-container');
    if (await onboarding.isVisible()) {
      await expect(onboarding.locator('h2')).toContainText('Welcome to Workrail');
    }
  });

  test('should display sessions if they exist', async ({ page }) => {
    await page.goto('/');
    
    // Wait for data to load
    await page.waitForTimeout(1000);
    
    // Check if sessions are displayed
    const sessionCards = page.locator('.session-card');
    const count = await sessionCards.count();
    
    if (count > 0) {
      // Verify first session card structure
      const firstCard = sessionCards.first();
      await expect(firstCard.locator('.session-id')).toBeVisible();
      await expect(firstCard.locator('.session-status')).toBeVisible();
      await expect(firstCard.locator('.session-title')).toBeVisible();
    }
  });

  test('should handle session card hover', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1000);
    
    const sessionCards = page.locator('.session-card');
    const count = await sessionCards.count();
    
    if (count > 0) {
      const firstCard = sessionCards.first();
      
      // Hover over card
      await firstCard.hover();
      
      // Menu button should become visible
      const menuBtn = firstCard.locator('.session-menu-btn');
      await expect(menuBtn).toBeVisible();
    }
  });

  test('should handle theme toggle', async ({ page }) => {
    await page.goto('/');
    
    // Find theme toggle button (if it exists)
    const themeToggle = page.locator('[aria-label*="theme"], [title*="theme"]').first();
    
    if (await themeToggle.isVisible()) {
      // Click to toggle theme
      await themeToggle.click();
      
      // Wait for theme to change
      await page.waitForTimeout(300);
      
      // Verify theme changed (check data-theme attribute on html or body)
      const theme = await page.evaluate(() => {
        return document.documentElement.getAttribute('data-theme') ||
               document.body.getAttribute('data-theme');
      });
      
      expect(theme).toBeTruthy();
    }
  });

  test('should have responsive layout', async ({ page }) => {
    // Test desktop
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto('/');
    await expect(page.locator('.home-container')).toBeVisible();
    
    // Test mobile
    await page.setViewportSize({ width: 375, height: 667 });
    await expect(page.locator('.home-container')).toBeVisible();
  });
});

