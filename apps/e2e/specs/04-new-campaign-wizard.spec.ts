/**
 * New campaign, the four steps in the UI: name and caller ID, a CSV of customers (uploaded,
 * checked and imported through the simulated S3), outcomes, then agents and calling hours, and
 * Start. The campaign runs with its customers, and its staffed agent gets the first call.
 */
import { test, expect, scoped, signIn } from '../src/fixtures/test.js';
import { phoneWithPersona } from '../src/fixtures/console-api.js';
import { sim } from '../src/fixtures/sim-client.js';
import { Station } from '../src/pages/station.js';

test('a supervisor builds and starts a campaign in New campaign, and it dials', async ({ page, world, newUserPage }) => {
  const phones = [phoneWithPersona('01'), phoneWithPersona('03'), phoneWithPersona('02')];
  const csv = ['name,phone,city', `Anil Kumar,${phones[0]},Pune`, `Bela Shah,${phones[1]},Delhi`, `Chetan Rao,${phones[2]},Mumbai`].join('\n');

  await signIn(page, world.supervisor);
  await page.goto(scoped(world, '/agency/campaigns/new'));

  // 1. Name & number
  await page.getByLabel('Campaign name').fill('Wizard campaign');
  await page.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: 'Continue' }).click();

  // 2. Customers: the file is checked first, then imported.
  await page.locator('input[type=file]').setInputFiles({ name: 'customers.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByText('3 customers ready')).toBeVisible();
  await page.getByRole('button', { name: 'Add 3 customers' }).click();

  // 3. Purpose & buttons: the built-in outcomes.
  await expect(page.getByText('What is this campaign for?')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  // 4. Agents & timing: one agent, every hour of every day so the run dials whatever the time.
  await expect(page.getByRole('heading', { name: 'Who will call' })).toBeVisible();
  await page.getByRole('checkbox', { name: new RegExp(world.agents[0].name) }).check();
  await page.getByText('Custom', { exact: true }).click();
  await page.locator('#window-start').fill('00:00');
  await page.locator('#window-end').fill('23:59');
  for (const day of ['Saturday', 'Sunday']) {
    const pill = page.getByRole('button', { name: day, exact: true });
    if ((await pill.getAttribute('aria-pressed')) !== 'true') await pill.click();
  }
  await page.getByRole('button', { name: 'Start campaign' }).click();

  await expect(page).toHaveURL(/\/agency\/campaigns\/[0-9a-f-]+\/overview/);
  await expect(page.getByText('Running', { exact: true }).first()).toBeVisible();
  const campaignId = /campaigns\/([0-9a-f-]+)\//.exec(page.url())![1]!;
  await page.goto(scoped(world, `/agency/campaigns/${campaignId}/contacts`));
  for (const phone of phones) await expect(page.getByRole('row').filter({ hasText: phone })).toBeVisible();

  // The staffed agent starts work and the dialler works through the list; only the first
  // customer answers (the others are busy and no answer), so that is the call put through.
  const agent = await newUserPage(world.agents[0]);
  const station = new Station(agent);
  await station.startWork();
  await station.expectOnCallWith('Anil Kumar');
  await expect.poll(async () => (await sim.calls(phones[0]))[0]?.state).toBe('answered');

  await station.endCall();
  await station.expectWrapUp();
  await station.fileOutcome('Voicemail', 'break');
});
