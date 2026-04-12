/**
 * E2E Tests for Homepage
 *
 * The root URL now redirects to /console (the React console UI).
 * These tests verify the redirect and that the console loads correctly.
 */

import { test, expect } from '@playwright/test';

test.describe('Homepage', () => {
  test('should redirect / to /console', async ({ page }) => {
    await page.goto('/');

    // Root redirects to the console
    await expect(page).toHaveURL(/\/console/);
  });

  test('should load the WorkRail Console', async ({ page }) => {
    await page.goto('/console');

    // The console always renders either the workspace sessions view (h1 "Workspace")
    // or the empty state ("Ready when you are") when no sessions exist.
    // Both are valid loaded states -- wait for either.
    await expect(
      page.locator('h1').filter({ hasText: 'Workspace' })
        .or(page.locator('text=Ready when you are'))
    ).toBeVisible({ timeout: 10_000 });
  });

  test('should display the Workspace view by default', async ({ page }) => {
    await page.goto('/console');

    // Workspace view is loaded when either the session list (h1 "Workspace") or
    // the empty state ("Ready when you are") is visible.
    await expect(
      page.locator('h1').filter({ hasText: 'Workspace' })
        .or(page.locator('text=Ready when you are'))
    ).toBeVisible({ timeout: 10_000 });
  });
});

