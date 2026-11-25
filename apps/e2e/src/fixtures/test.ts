/**
 * The suite's `test`: Playwright's, plus
 *  - every browser context sends Firebase's identity hosts to the simulator (the console signs
 *    in against the fake, unchanged);
 *  - `world`: a fresh tenant seeded for this test (`world.ts`);
 *  - `supervisorApi`: the console API as the world's supervisor (`console-api.ts`);
 *  - `newUserPage(user)`: a page in a context of its own, signed in as `user`;
 *  - after each test, every simulated customer still on a call hangs up.
 */
import { test as base, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { urls } from '../env.js';
import { ConsoleApi } from './console-api.js';
import { sim } from './sim-client.js';
import { seedWorld, type World, type WorldUser } from './world.js';

export async function routeIdentity(context: BrowserContext): Promise<void> {
  await context.route(/^https:\/\/(identitytoolkit|securetoken)\.googleapis\.com\//, async (route) => {
    const u = new URL(route.request().url());
    const response = await route.fetch({ url: `${urls.sim}/${u.host}${u.pathname}${u.search}` });
    await route.fulfill({ response });
  });
}

/** Sign in on the console's login page; resolves once the signed-in shell (or station) shows. */
export async function signIn(page: Page, user: WorldUser): Promise<void> {
  await page.goto('/login');
  await page.locator('#agency-email').fill(user.email);
  await page.locator('#agency-password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(/\/t\/[^/]+\/a\/[^/]+\//, { timeout: 30_000 });
}

/** A signed-in console path for `world` (URLs are `/t/:tenant/a/:account/…`, B26). */
export function scoped(world: World, path: string): string {
  return `/t/${world.tenantId}/a/${world.accountId}${path.startsWith('/') ? path : `/${path}`}`;
}

async function contextFor(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL: urls.console, permissions: ['microphone'], viewport: { width: 1440, height: 900 } });
  await routeIdentity(context);
  return context;
}

interface Fixtures {
  /** After each test: every simulated customer still on a call hangs up (automatic). */
  endLiveCalls: void;
  world: World;
  supervisorApi: ConsoleApi;
  newUserPage: (user: WorldUser) => Promise<Page>;
}

export const test = base.extend<Fixtures>({
  // Set up first, so torn down last (after the test's browser contexts close): no call a test
  // left open runs on into the next one.
  endLiveCalls: [async ({}, use) => {
    await use();
    await sim.hangupAll();
  }, { auto: true }],
  context: async ({ context }, use) => {
    await routeIdentity(context);
    await use(context);
  },
  world: async ({}, use, testInfo) => {
    await use(await seedWorld(testInfo.title.replace(/[^\w ]/g, '').slice(0, 40) || 'World'));
  },
  supervisorApi: async ({ world }, use) => {
    await use(await ConsoleApi.as(world, world.supervisor));
  },
  newUserPage: async ({ browser }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (user) => {
      const context = await contextFor(browser);
      contexts.push(context);
      const page = await context.newPage();
      await signIn(page, user);
      return page;
    });
    for (const c of contexts) await c.close();
  },
});

export { expect };
