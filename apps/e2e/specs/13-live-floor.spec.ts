/**
 * The supervisor's Live floor follows the agent: waiting, on a call, choosing an outcome, on
 * break.
 */
import { test, expect, signIn } from '../src/fixtures/test.js';
import { phoneWithPersona } from '../src/fixtures/console-api.js';
import { Station } from '../src/pages/station.js';

test("the Live floor shows each agent's state as it changes", async ({ page, world, supervisorApi, newUserPage }) => {
  const phone = phoneWithPersona('01');
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
  await station.expectOnCallWith('Gita Menon');
  await expect(agentRow).toBeVisible({ timeout: 30_000 });
  await expect(sup.getByText(/On a call\s*1/).first()).toBeVisible({ timeout: 30_000 });

  await station.endCall();
  await station.expectWrapUp();
  await expect(sup.getByText(/Choosing outcome\s*1/).first()).toBeVisible({ timeout: 30_000 });

  await station.fileOutcome('Voicemail', 'break');
  await expect(sup.getByText(/Break\s*1/).first()).toBeVisible({ timeout: 30_000 });
});
