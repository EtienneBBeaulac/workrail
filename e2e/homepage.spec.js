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

  test('should display the Sessions tab by default', async ({ page }) => {
    await page.goto('/console');

    // Sessions tab is the default active tab
    await expect(page.getByRole('button', { name: 'sessions' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'worktrees' })).toBeVisible();
  });

  test('should navigate to the Worktrees tab', async ({ page }) => {
    await page.goto('/console');

    await page.getByRole('button', { name: 'worktrees' }).click();

    // Worktrees content loads (either the list or the empty state)
    await expect(
      page.locator('h2').filter({ hasText: 'Worktrees' })
        .or(page.locator('text=No worktrees found'))
        .or(page.locator('text=Loading worktrees'))
    ).toBeVisible({ timeout: 10_000 });
  });
});
