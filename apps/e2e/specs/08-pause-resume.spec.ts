/**
 * A paused campaign places no calls even with an agent waiting; resuming it dials again.
 */
import { test, expect, signIn } from '../src/fixtures/test.js';
import { phoneWithPersona } from '../src/fixtures/console-api.js';
import { sim } from '../src/fixtures/sim-client.js';
import { CampaignPages } from '../src/pages/campaign.js';
import { Station } from '../src/pages/station.js';

test('pause stops new dials and resume starts them again', async ({ page, world, supervisorApi, newUserPage }) => {
  const phone = phoneWithPersona('01');
  const campaign = await supervisorApi.createCampaign(world, {
    name: 'Pause and resume',
    contacts: [{ name: 'Deepa Nair', phone }],
    agents: [world.agents[0]],
  });

  const sup = await newUserPage(world.supervisor);
  const pages = new CampaignPages(sup, world, campaign.id);
  await pages.openOverview();
  // Pause asks nothing (only Stop does), and neither does Resume after a pause by hand: it
  // warns only when the abandonment guardrail paused the campaign.
  await sup.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(sup.getByText('Paused', { exact: true }).first()).toBeVisible();

  await signIn(page, world.agents[0]);
  const station = new Station(page);
  await station.startWork();
  // An agent is waiting, but nothing is dialled while the campaign is paused.
  await page.waitForTimeout(8_000);
  expect(await sim.calls(phone)).toHaveLength(0);

  await sup.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(sup.getByText('Running', { exact: true }).first()).toBeVisible();

  await station.expectOnCallWith('Deepa Nair');
  expect(await sim.calls(phone)).toHaveLength(1);

  await station.endCall();
  await station.expectWrapUp();
  await station.fileOutcome('Voicemail', 'break');
});
