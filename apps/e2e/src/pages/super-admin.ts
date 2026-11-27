/** The super-admin console (its own origin), signed in as the run's super-admin. */
import { expect, type Page } from '@playwright/test';
import { SUPER_ADMIN, urls } from '../env.js';

export async function signInSuperAdmin(page: Page): Promise<void> {
  await page.goto(`${urls.superAdmin}/login`);
  await page.locator('#email').fill(SUPER_ADMIN.email);
  await page.locator('#password').fill(SUPER_ADMIN.password);
  await page.getByRole('button', { name: 'Sign In as Admin' }).click();
  await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible();
}
