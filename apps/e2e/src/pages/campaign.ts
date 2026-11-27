/** A campaign's supervisor screens. */
import { expect, type Locator, type Page } from '@playwright/test';
import { scoped } from '../fixtures/test.js';
import type { World } from '../fixtures/world.js';

export class CampaignPages {
  constructor(readonly page: Page, readonly world: World, readonly campaignId: string) {}

  async openCallLog(): Promise<void> {
    await this.page.goto(scoped(this.world, `/agency/campaigns/${this.campaignId}/attempts`));
    await expect(this.page.getByRole('row').first()).toBeVisible();
  }

  async openOverview(): Promise<void> {
    await this.page.goto(scoped(this.world, `/agency/campaigns/${this.campaignId}/overview`));
  }

  /** The Call log's row for a national number (shown as +91 and the number). */
  callLogRow(nationalNumber: string): Locator {
    return this.page.getByRole('row').filter({ hasText: nationalNumber });
  }

  /** Reload the Call log until the row for `nationalNumber` shows `text` (the log refreshes on demand). */
  async expectCallLogRow(nationalNumber: string, ...texts: string[]): Promise<void> {
    await expect(async () => {
      await this.openCallLog();
      const row = this.callLogRow(nationalNumber).first();
      for (const t of texts) await expect(row).toContainText(t, { timeout: 2_000 });
    }).toPass({ timeout: 45_000 });
  }
}
