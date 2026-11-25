/**
 * An agent marks a customer Do not call from the station; the number is on the supervisor's Do
 * Not Call list.
 */
import { test, expect, scoped, signIn } from '../src/fixtures/test.js';
import { phoneWithPersona } from '../src/fixtures/console-api.js';
import { Station } from '../src/pages/station.js';

test('an agent files Do not call and the number lands on the Do Not Call list', async ({ page, world, supervisorApi, newUserPage }) => {
  const phone = phoneWithPersona('01');
  await supervisorApi.createCampaign(world, {
    name: 'Do not call',
    contacts: [{ name: 'Esha Gupta', phone }],
    agents: [world.agents[0]],
  });

  await signIn(page, world.agents[0]);
  const station = new Station(page);
  await station.startWork();
  await station.expectOnCallWith('Esha Gupta');
  await station.endCall();
  await station.expectWrapUp();
  await station.fileOutcome('Do not call', 'break');

  const sup = await newUserPage(world.supervisor);
  await expect(async () => {
    await sup.goto(scoped(world, '/agency/dnc'));
    await expect(sup.getByText(phone.slice(-4)).first()).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await expect(sup.getByText('Nothing on the list')).toBeHidden();
});
