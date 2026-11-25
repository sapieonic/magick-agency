/**
 * Calls the customer never answers never reach an agent: busy, no answer and a carrier failure
 * are each filed with what happened, and the agent stays waiting.
 */
import { test, expect, signIn } from '../src/fixtures/test.js';
import { phoneWithPersona } from '../src/fixtures/console-api.js';
import { sim } from '../src/fixtures/sim-client.js';
import { CampaignPages } from '../src/pages/campaign.js';
import { Station } from '../src/pages/station.js';

test('busy, no answer and failed calls are logged and never reach the agent', async ({ page, world, supervisorApi, newUserPage }) => {
  const busy = phoneWithPersona('02');
  const noAnswer = phoneWithPersona('03');
  const failed = phoneWithPersona('04');
  const campaign = await supervisorApi.createCampaign(world, {
    name: 'Unanswered',
    contacts: [
      { name: 'Busy Bee', phone: busy },
      { name: 'Nobody Home', phone: noAnswer },
      { name: 'Dead Line', phone: failed },
    ],
    agents: [world.agents[0]],
  });

  await signIn(page, world.agents[0]);
  await new Station(page).startWork();

  for (const [phone, persona] of [[busy, 'busy'], [noAnswer, 'no_answer'], [failed, 'failed']] as const) {
    await expect.poll(async () => (await sim.calls(phone))[0]?.state, { timeout: 60_000 }).toBe('ended');
    expect((await sim.calls(phone))[0]?.persona).toBe(persona);
  }
  // None of them was put through.
  await expect(page.getByText('On call', { exact: true })).toBeHidden();

  const log = new CampaignPages(await newUserPage(world.supervisor), world, campaign.id);
  await log.expectCallLogRow(busy, 'Busy');
  await log.expectCallLogRow(noAnswer, 'No answer');
  await log.expectCallLogRow(failed, 'Failed');
});
