/**
 * Customer history: after a call, searching the number shows it, with its campaign and outcome
 * (the supervisor's search across campaigns, and the agent's own).
 */
import { test, expect, scoped, signIn } from '../src/fixtures/test.js';
import { phoneWithPersona } from '../src/fixtures/console-api.js';
import { Station } from '../src/pages/station.js';

test('a called number shows in customer history with its campaign and outcome', async ({ page, world, supervisorApi, newUserPage }) => {
  const phone = phoneWithPersona('01');
  await supervisorApi.createCampaign(world, {
    name: 'History campaign',
    contacts: [{ name: 'Farah Khan', phone, city: 'Hyderabad' }],
    agents: [world.agents[0]],
  });

  await signIn(page, world.agents[0]);
  const station = new Station(page);
  await station.startWork();
  await station.expectOnCallWith('Farah Khan');
  await station.endCall();
  await station.expectWrapUp();
  await station.fileOutcome('Voicemail', 'break');

  // The agent's own search.
  await page.goto(scoped(world, '/dialer/customers'));
  await page.locator('input[type=tel]').fill(phone);
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByText('History campaign').first()).toBeVisible();
  await expect(page.getByText('Voicemail').first()).toBeVisible();

  // The supervisor's search from the top bar.
  const sup = await newUserPage(world.supervisor);
  await sup.getByRole('button', { name: /Search pages, campaigns, settings or a number/ }).click();
  await sup.keyboard.type(phone);
  await sup.keyboard.press('Enter');
  await expect(sup.getByText('History campaign').first()).toBeVisible();
  await expect(sup.getByText('Voicemail').first()).toBeVisible();
});
