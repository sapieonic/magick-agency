/**
 * A new organisation, start to finish: the super-admin adds a tenant in their console, its owner
 * gets the invitation by mail, sets a password on the join page and arrives in the organisation.
 */
import { randomBytes } from 'node:crypto';
import { test, expect } from '../src/fixtures/test.js';
import { linkInMail } from '../src/fixtures/sim-client.js';
import { signInSuperAdmin } from '../src/pages/super-admin.js';

test('the super-admin adds a tenant and its owner joins from the invitation', async ({ page, context }) => {
  const tag = randomBytes(3).toString('hex');
  const tenantName = `Onboarded ${tag}`;
  const ownerEmail = `founder.${tag}@e2e.test`;

  await signInSuperAdmin(page);
  await page.getByRole('button', { name: 'Add tenant' }).click();
  await page.locator('#tenant-name').fill(tenantName);
  await page.locator('#tenant-owner-email').fill(ownerEmail);
  await page.locator('#tenant-owner-name').fill(`Founder ${tag}`);
  await page.getByRole('button', { name: 'Create tenant' }).click();
  await expect(page.getByText(tenantName).first()).toBeVisible();

  await expect.poll(() => linkInMail(ownerEmail)).not.toBeNull();
  const link = (await linkInMail(ownerEmail))!;

  const owner = await context.newPage();
  await owner.goto(link);
  await expect(owner.getByText(tenantName)).toBeVisible();
  await owner.getByText('Create a password instead').click();
  await owner.locator('#join-password').fill(`Kite-${tag}-Harbour-7`);
  await owner.getByRole('button', { name: 'Create my sign-in' }).click();
  await owner.waitForURL(/\/t\/[^/]+\/a\/[^/]+\//, { timeout: 30_000 });
  await expect(owner.getByText(tenantName).first()).toBeVisible();
});
