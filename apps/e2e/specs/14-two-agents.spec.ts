/**
 * Two agents on one campaign: the dialler puts a different customer through to each, at the
 * same time, each on their own audio.
 */
import { test, expect } from '../src/fixtures/test.js';
import { phoneWithPersona } from '../src/fixtures/console-api.js';
import { sim } from '../src/fixtures/sim-client.js';
import { Station } from '../src/pages/station.js';

test('two agents each get their own call at the same time', async ({ world, supervisorApi, newUserPage }) => {
  const phones = [phoneWithPersona('01'), phoneWithPersona('01')];
  await supervisorApi.createCampaign(world, {
    name: 'Two agents',
    contacts: [{ name: 'Hari Prasad', phone: phones[0]! }, { name: 'Indu Verma', phone: phones[1]! }],
  });

  const stations = [new Station(await newUserPage(world.agents[0])), new Station(await newUserPage(world.agents[1]))];
  await Promise.all(stations.map((s) => s.startWork()));
  for (const s of stations) await expect(s.page.getByText('On call', { exact: true })).toBeVisible({ timeout: 60_000 });

  // Each station shows a different customer.
  const names = await Promise.all(stations.map(async (s) =>
    (await s.page.getByText('Hari Prasad').first().isVisible()) ? 'Hari Prasad' : 'Indu Verma'));
  expect(new Set(names).size).toBe(2);

  // Both calls are live at the carrier with the agents' audio on each.
  for (const phone of phones) {
    await expect.poll(async () => (await sim.calls(phone))[0]?.state).toBe('answered');
    await expect.poll(async () => (await sim.calls(phone))[0]?.nonSilentFramesFromServer ?? 0, { timeout: 20_000 }).toBeGreaterThan(10);
  }

  for (const s of stations) {
    await s.endCall();
    await s.expectWrapUp();
    await s.fileOutcome('Voicemail', 'break');
  }
  for (const phone of phones) await expect.poll(async () => (await sim.calls(phone))[0]?.endedBy).toBe('agent');
});
