/**
 * Not a check: writes every fixture's HTML and PDF for a person to look at. Runs only when
 * REPORT_PREVIEW_DIR is set (page images: `pdftoppm -r 80 -png <name>.pdf <name>`).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { launchBrowser } from '../src/pdf/chrome';
import { renderPdf, renderReportHtml } from '../src/pdf/render-pdf';
import { accountFixture } from './fixtures/account';
import { agentFixture } from './fixtures/agent';
import { campaignFixture } from './fixtures/campaign';

const dir = process.env.REPORT_PREVIEW_DIR;

describe.runIf(Boolean(dir))('preview', () => {
  it('writes HTML and PDF per fixture', async () => {
    mkdirSync(dir!, { recursive: true });
    const sets = { agent: agentFixture().dataset, 'agent-self': agentFixture({ audience: 'self' }).dataset, campaign: campaignFixture().dataset, account: accountFixture().dataset };
    const browser = await launchBrowser();
    try {
      for (const [name, ds] of Object.entries(sets)) {
        writeFileSync(join(dir!, `${name}.html`), renderReportHtml(ds));
        writeFileSync(join(dir!, `${name}.pdf`), await renderPdf(ds, { browser }));
      }
    } finally {
      await browser.close();
    }
  }, 180_000);
});
