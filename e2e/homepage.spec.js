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

    // Console heading is visible
    await expect(page.locator('h1')).toContainText('WorkRail Console');
  });

  test('should display the Workspace view by default', async ({ page }) => {
    await page.goto('/console');

    // Workspace is the sole view -- no tab buttons, just the heading
    await expect(page.locator('h1')).toContainText('WorkRail Console');

    // Scope toggle (Active / All) confirms the Workspace view is loaded
    await expect(
      page.getByRole('button', { name: 'Active' })
        .or(page.locator('text=Active'))
        .or(page.locator('text=No branches match'))
        .or(page.locator('text=Ready when you are'))
    ).toBeVisible({ timeout: 10_000 });
  });
});

