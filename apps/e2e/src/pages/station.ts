/**
 * The agent station (`/station`), as an agent works it: start work, take a call, end it, file
 * what happened.
 */
import { expect, type Page } from '@playwright/test';

export class Station {
  constructor(readonly page: Page) {}

  async dismissNotices(): Promise<void> {
    const gotIt = this.page.getByRole('button', { name: 'Got it' });
    if (await gotIt.isVisible().catch(() => false)) await gotIt.click();
  }

  /**
   * From the pre-work check or a break, to "Calls come to me". The station can show the check
   * screen and then settle on the break screen when its socket's `ready` arrives, so this keeps
   * pressing whichever entry button is showing until neither is.
   */
  async startWork(): Promise<void> {
    await this.page.waitForURL(/\/station/);
    const startWork = this.page.getByRole('button', { name: /^Start work/ });
    const again = this.page.getByRole('button', { name: /^Start calls again/ });
    await expect(startWork.or(again)).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
      await this.dismissNotices();
      for (const b of [again, startWork]) {
        if (await b.isVisible().catch(() => false)) await b.click({ timeout: 2_000 }).catch(() => undefined);
      }
      await this.page.waitForTimeout(500);
      await expect(startWork).toBeHidden({ timeout: 1_000 });
      await expect(again).toBeHidden({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    await this.dismissNotices();
  }

  /** Wait for a call to be put through: the "On call" screen with the customer's card. */
  async expectOnCallWith(customerName: string, timeout = 60_000): Promise<void> {
    await expect(this.page.getByText('On call', { exact: true })).toBeVisible({ timeout });
    await expect(this.page.getByText(customerName).first()).toBeVisible();
  }

  /** End the call the way the station offers on a keyboard: E twice. */
  async endCall(): Promise<void> {
    await this.page.keyboard.press('e');
    await this.page.keyboard.press('e');
  }

  async expectWrapUp(timeout = 30_000): Promise<void> {
    await expect(this.page.getByText('What happened?')).toBeVisible({ timeout });
  }

  /** Pick an outcome by its label and save, then either take the next call or go on a break. */
  async fileOutcome(label: string, then: 'next' | 'break' = 'next'): Promise<void> {
    await this.page.getByRole('button', { name: label, exact: true }).click();
    // Outcomes that cannot be undone (Do not call) ask first.
    const confirm = this.page.getByRole('dialog').getByRole('button', { name: /^Yes/ });
    if (await confirm.isVisible({ timeout: 1_500 }).catch(() => false)) await confirm.click();
    if (then === 'next') {
      await this.page.getByRole('button', { name: /^Save & next call/ }).click();
    } else {
      await this.page.getByRole('button', { name: /^Save & take break/ }).click();
      await this.page.getByRole('button', { name: 'Break', exact: true }).click();
    }
    await expect(this.page.getByText('What happened?')).toBeHidden({ timeout: 15_000 });
  }
}
