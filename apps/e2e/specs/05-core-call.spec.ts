/**
 * The heart of the product: a running campaign dials, the simulated customer answers, the call
 * is put through to the agent's browser with the customer's card, audio flows both ways, the
 * agent ends the call and files what happened, and the campaign's call log shows it.
 */
import { test, expect, signIn } from '../src/fixtures/test.js';
import { phoneWithPersona } from '../src/fixtures/console-api.js';
import { sim } from '../src/fixtures/sim-client.js';
import { CampaignPages } from '../src/pages/campaign.js';
import { Station } from '../src/pages/station.js';

test('an answered call reaches the agent, carries audio both ways and is filed', async ({ page, world, supervisorApi, newUserPage }) => {
  const phone = phoneWithPersona('01');
  const campaign = await supervisorApi.createCampaign(world, {
    name: 'Core call',
    contacts: [{ name: 'Anil Kumar', phone, city: 'Pune' }],
    agents: [world.agents[0]],
  });

  const station = new Station(page);
  await signIn(page, world.agents[0]);
  await station.startWork();
  await station.expectOnCallWith('Anil Kumar');
  await expect(page.getByText('Pune').first()).toBeVisible();

  // The carrier placed one call to the contact, answered it, and hears the agent's microphone;
  // the agent's browser receives the customer's audio on the station socket.
  await expect.poll(async () => (await sim.calls(phone))[0]?.state).toBe('answered');
  await expect.poll(async () => (await sim.calls(phone))[0]?.nonSilentFramesFromServer ?? 0, { timeout: 20_000 }).toBeGreaterThan(10);
  // Frames with sound, not just frames: silence or garbage relayed to the browser fails here.
  await expect.poll(() => station.audioFramesWithSound, { timeout: 20_000 }).toBeGreaterThan(25);
  // The add_lead named the campaign's caller ID and the contact's number.
  const lead = (await sim.carrierRequests()).find((r) => r.route === 'add_lead' && r.body?.['customer_number'] === phone);
  expect(lead?.body?.['did_number']).toBe(world.callerIds[0]!.replace('+', ''));

  await station.endCall();
  await station.expectWrapUp();
  await expect.poll(async () => (await sim.calls(phone))[0]?.endedBy).toBe('agent');
  await station.fileOutcome('Voicemail', 'break');
  await expect(page.getByText('On break').first()).toBeVisible();

  const sup = await newUserPage(world.supervisor);
  await new CampaignPages(sup, world, campaign.id).expectCallLogRow(phone, 'Connected', 'Voicemail', world.agents[0].name);
});
