import { test, expect } from '@playwright/test';

test('bootstrap page displays live API and database status', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Mentor Booking' })).toBeVisible();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  await expect(page.getByText('Reachable', { exact: true })).toBeVisible();
});
