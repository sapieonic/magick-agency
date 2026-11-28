/**
 * Access: an agent cannot open supervisor pages, and nobody can open another organisation's.
 */
import { test, expect, scoped, signIn } from '../src/fixtures/test.js';
import { seedWorld } from '../src/fixtures/world.js';
import { ConsoleApi } from '../src/fixtures/console-api.js';

test('an agent is kept to their own screens', async ({ page, world }) => {
  await signIn(page, world.agents[0]);
  for (const path of ['/agency/campaigns', '/agency/dnc', '/settings/team', '/agency/home']) {
    await page.goto(scoped(world, path));
    await expect(page).toHaveURL(/\/dialer$/);
  }
  // And the API refuses them too, with the agent's own valid sign-in.
  const agentApi = await ConsoleApi.as(world, world.agents[0]);
  expect(await agentApi.statusOf('/proxy/agency/campaigns')).toBe(403);
  expect(await agentApi.statusOf('/proxy/agency/my-campaigns')).toBe(200);
});

test("a supervisor cannot open another organisation's pages", async ({ page, world }) => {
  const other = await seedWorld('Other org');
  await signIn(page, world.supervisor);
  await page.goto(scoped(other, '/agency/campaigns'));
  await expect(page.getByRole('heading', { name: 'You can’t open this organisation' })).toBeVisible();
  await expect(page.getByText(other.tenantName)).toBeHidden();
  // The API refuses the other organisation's data as well, with the supervisor's valid sign-in.
  const supApi = await ConsoleApi.as(world, world.supervisor);
  expect(await supApi.statusOf('/proxy/agency/campaigns')).toBe(200);
  expect([403, 404]).toContain(await supApi.statusOf('/proxy/agency/campaigns', other));
  await page.getByRole('button', { name: 'Go to my organisation' }).click();
  await expect(page).toHaveURL(new RegExp(world.tenantId));
});
