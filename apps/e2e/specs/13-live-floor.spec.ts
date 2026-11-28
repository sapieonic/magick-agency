/**
 * The supervisor's Live floor follows the agent: ready (waiting for a call), on a call, choosing
 * an outcome, on break. The customer rings for a while first, so the agent is seen waiting.
 */
import { test, expect, signIn } from '../src/fixtures/test.js';
import { phoneWithPersona } from '../src/fixtures/console-api.js';
import { sim } from '../src/fixtures/sim-client.js';
import { Station } from '../src/pages/station.js';

test("the Live floor shows each agent's state as it changes", async ({ page, world, supervisorApi, newUserPage }) => {
  const phone = phoneWithPersona('01');
  await sim.setPersona(phone, 'answer', { ringMs: 12_000 });
  await supervisorApi.createCampaign(world, {
    name: 'Floor campaign',
    contacts: [{ name: 'Gita Menon', phone }],
    agents: [world.agents[0]],
  });
  const sup = await newUserPage(world.supervisor);
  await expect(sup).toHaveURL(/\/agency\/home$/);
  const agentRow = sup.getByText(world.agents[0].name).first();

  await signIn(page, world.agents[0]);
  const station = new Station(page);
  await station.startWork();
  await expect(agentRow).toBeVisible({ timeout: 30_000 });
  // Dialled and ringing, not yet answered: the agent is still waiting.
  await expect.poll(async () => (await sim.calls(phone))[0]?.state, { timeout: 30_000 }).toBe('ringing');
  await expect(sup.getByText(/Ready\s*1/).first()).toBeVisible({ timeout: 10_000 });

  await station.expectOnCallWith('Gita Menon');
  await expect(sup.getByText(/On a call\s*1/).first()).toBeVisible({ timeout: 30_000 });

  await station.endCall();
  await station.expectWrapUp();
  await expect(sup.getByText(/Choosing outcome\s*1/).first()).toBeVisible({ timeout: 30_000 });

  await station.fileOutcome('Voicemail', 'break');
  await expect(sup.getByText(/Break\s*1/).first()).toBeVisible({ timeout: 30_000 });
});
