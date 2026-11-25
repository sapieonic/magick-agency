/**
 * Calls the customer never answers never reach an agent: busy, no answer and a carrier failure
 * are each filed with what happened, and the agent's station stays waiting the whole time
 * (sampled while the calls ring, not only once they are over).
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

  const onCall = page.getByText('On call', { exact: true });
  const waiting = page.getByRole('button', { name: /^Start work|^Start calls again/ });
  const deadline = Date.now() + 90_000;
  let samples = 0;
  for (;;) {
    // Every sample: no call put through, and the agent still at work (not knocked back to the
    // start screen).
    expect(await onCall.isVisible(), 'a call the customer never answered reached the agent').toBe(false);
    expect(await waiting.isVisible(), 'the agent left work').toBe(false);
    samples += 1;
    const states = await Promise.all([busy, noAnswer, failed].map(async (p) => (await sim.calls(p))[0]?.state));
    if (states.every((s) => s === 'ended')) break;
    expect(Date.now(), `calls still not over: ${states.join(', ')}`).toBeLessThan(deadline);
    await page.waitForTimeout(250);
  }
  expect(samples).toBeGreaterThan(3);

  const log = new CampaignPages(await newUserPage(world.supervisor), world, campaign.id);
  await log.expectCallLogRow(busy, 'Busy');
  await log.expectCallLogRow(noAnswer, 'No answer');
  await log.expectCallLogRow(failed, 'Failed');
});
