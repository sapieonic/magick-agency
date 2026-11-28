/**
 * The soft phone: an agent dials a number by hand, the simulated customer answers, the agent
 * ends the call, and it is in My calls.
 */
import { test, expect, signIn } from '../src/fixtures/test.js';
import { phoneWithPersona } from '../src/fixtures/console-api.js';
import { sim } from '../src/fixtures/sim-client.js';

test('an agent places a manual call from the soft phone', async ({ page, world }) => {
  const phone = phoneWithPersona('01');
  await signIn(page, world.agents[0]);
  await page.getByRole('link', { name: 'Soft phone' }).click();
  const gotIt = page.getByRole('button', { name: 'Got it' });
  if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
  await page.getByRole('textbox', { name: 'Number' }).or(page.locator('input[type=tel]')).first().fill(phone);
  await page.getByRole('button', { name: /^Call/ }).click();

  await expect.poll(async () => (await sim.calls(phone))[0]?.state, { timeout: 30_000 }).toBe('answered');
  await expect.poll(async () => (await sim.calls(phone))[0]?.nonSilentFramesFromServer ?? 0, { timeout: 20_000 }).toBeGreaterThan(10);
  await expect(page.getByRole('heading', { name: 'On call' })).toBeVisible();
  await page.keyboard.press('e');
  await page.keyboard.press('e');
  await expect.poll(async () => (await sim.calls(phone))[0]?.state, { timeout: 30_000 }).toBe('ended');
  // The soft phone asks what happened too, then the agent can leave the screen.
  await expect(page.getByText('What happened?')).toBeVisible();
  await page.getByRole('button', { name: 'Voicemail', exact: true }).click();
  await page.getByRole('button', { name: /^Save/ }).click();
  await expect(page.getByText('What happened?')).toBeHidden();

  await page.getByRole('link', { name: 'My calls' }).click();
  await expect(page.getByRole('row').filter({ hasText: phone.slice(-5) }).first()).toBeVisible();
});
