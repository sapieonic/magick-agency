/**
 * Every role reaches its own landing page through the real sign-in: the super-admin console,
 * a supervisor's Live floor, and an agent's work list.
 */
import { test, expect, signIn } from '../src/fixtures/test.js';
import { signInSuperAdmin } from '../src/pages/super-admin.js';

test('the super-admin signs in to the tenant list', async ({ page, world }) => {
  await signInSuperAdmin(page);
  await page.getByPlaceholder('Search tenants by name or slug…').fill(world.tag);
  await expect(page.getByText(world.tenantName)).toBeVisible();
});

test('a supervisor signs in to the Live floor', async ({ page, world }) => {
  await signIn(page, world.supervisor);
  await expect(page).toHaveURL(/\/agency\/home$/);
  await expect(page.getByRole('heading', { name: 'Live floor', level: 1 })).toBeVisible();
  await expect(page.getByText('Agents working')).toBeVisible();
  await expect(page.getByText(world.supervisor.name).first()).toBeVisible();
});

test('an agent with no campaign signs in to an empty work list', async ({ page, world }) => {
  await signIn(page, world.agents[0]);
  await expect(page).toHaveURL(/\/dialer$/);
  await expect(page.getByText('No work for you yet')).toBeVisible();
});

test('a wrong password is refused', async ({ page, world }) => {
  await page.goto('/login');
  await page.locator('#agency-email').fill(world.agents[0].email);
  await page.locator('#agency-password').fill('Not-the-password-1');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.locator('#agency-password')).toBeVisible();
});
