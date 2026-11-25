/**
 * The customer hangs up first: the station leaves the call by itself and asks what happened.
 */
import { test, expect, signIn } from '../src/fixtures/test.js';
import { phoneWithPersona } from '../src/fixtures/console-api.js';
import { sim } from '../src/fixtures/sim-client.js';
import { CampaignPages } from '../src/pages/campaign.js';
import { Station } from '../src/pages/station.js';

test('when the customer hangs up, the agent is taken to wrap-up', async ({ page, world, supervisorApi, newUserPage }) => {
  const phone = phoneWithPersona('05'); // answers, talks ~4 s, hangs up
  const campaign = await supervisorApi.createCampaign(world, {
    name: 'Customer hangs up',
    contacts: [{ name: 'Bela Shah', phone, city: 'Delhi' }],
    agents: [world.agents[0]],
  });

  await signIn(page, world.agents[0]);
  const station = new Station(page);
  await station.startWork();
  await station.expectOnCallWith('Bela Shah');
  await station.expectWrapUp(30_000);
  await expect.poll(async () => (await sim.calls(phone))[0]?.endedBy).toBe('customer');
  await station.fileOutcome('Voicemail', 'break');

  const sup = await newUserPage(world.supervisor);
  await new CampaignPages(sup, world, campaign.id).expectCallLogRow(phone, 'Connected', 'Voicemail');
});

test('a spec can hang up for the customer at any moment', async ({ page, world, supervisorApi }) => {
  const phone = phoneWithPersona('01');
  await supervisorApi.createCampaign(world, {
    name: 'Hang up on cue',
    contacts: [{ name: 'Chetan Rao', phone }],
    agents: [world.agents[0]],
  });
  await signIn(page, world.agents[0]);
  const station = new Station(page);
  await station.startWork();
  await station.expectOnCallWith('Chetan Rao');
  expect(await sim.hangup(phone)).toBe(true);
  await station.expectWrapUp();
  await expect.poll(async () => (await sim.calls(phone))[0]?.endedBy).toBe('customer');
});
