/**
 * Customer history: after a call, searching the number shows it, with its campaign and outcome
 * (the supervisor's search across campaigns, and the agent's own).
 */
import type { Page } from '@playwright/test';
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
  await expectCallInTimeline(page);

  // The supervisor's search from the top bar. It opens on the Live floor, which names the
  // campaign already: the search has to take them to the customer history and show the call there.
  const sup = await newUserPage(world.supervisor);
  await sup.getByRole('button', { name: /Search pages, campaigns, settings or a number/ }).click();
  const box = sup.getByRole('dialog', { name: 'Search' }).getByRole('combobox');
  await box.fill(phone);
  await expect(box).toHaveValue(phone);
  await box.press('Enter');
  await expect(sup).toHaveURL(/\/agency\/customers/);
  await expectCallInTimeline(sup);
});

/** The number's timeline has the call: its campaign and the outcome the agent filed. */
async function expectCallInTimeline(page: Page): Promise<void> {
  const call = page
    .getByRole('list', { name: 'Timeline, newest first' })
    .getByRole('listitem')
    .filter({ hasText: 'Campaign call · History campaign' });
  await expect(call).toHaveCount(1);
  await expect(call).toContainText('Outcome code: voicemail');
}
