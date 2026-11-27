/**
 * A supervisor invites an agent from Team; the agent joins from the mail and the team list shows
 * them as joined.
 */
import { randomBytes } from 'node:crypto';
import { test, expect, routeIdentity, scoped, signIn } from '../src/fixtures/test.js';
import { linkInMail } from '../src/fixtures/sim-client.js';

test('a supervisor invites an agent who joins from the mail', async ({ page, world, browser }) => {
  const email = `newagent.${world.tag}@e2e.test`;
  await signIn(page, world.supervisor);
  await page.goto(scoped(world, '/settings/team'));
  await page.getByRole('button', { name: 'Invite member' }).click();
  await page.locator('#invite-email').fill(email);
  await page.locator('#invite-role').selectOption({ label: 'Agent' });
  await page.getByRole('button', { name: 'Send invite' }).click();
  await expect(page.getByTestId('invite-emailed')).toContainText(email);

  await expect.poll(() => linkInMail(email)).not.toBeNull();
  const link = (await linkInMail(email))!;

  const agentContext = await browser.newContext({ baseURL: new URL(link).origin, permissions: ['microphone'] });
  await routeIdentity(agentContext);
  const agent = await agentContext.newPage();
  await agent.goto(link);
  await agent.getByText('Create a password instead').click();
  await agent.locator('input[type=password]').first().fill(`Lotus-${randomBytes(3).toString('hex')}-River-4`);
  await agent.getByRole('button', { name: /Create my sign-in/ }).click();
  await agent.waitForURL(/\/t\/[^/]+\/a\/[^/]+\//, { timeout: 30_000 });
  await expect(agent.getByText('No work for you yet')).toBeVisible();
  await agentContext.close();

  await page.reload();
  const row = page.getByRole('row').filter({ hasText: email });
  await expect(row).toContainText('Agent');
  await expect(row).toContainText('Joined');
});
