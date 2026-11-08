/**
 * Real PDFs from a real Chromium (found by findChrome; GitHub's runners have
 * /usr/bin/google-chrome): page counts, the running footer, and the key figures in the text.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'puppeteer-core';
import { count, duration, pct } from '../src/format';
import { findChrome, launchBrowser } from '../src/pdf/chrome';
import { loadFonts } from '../src/pdf/fonts';
import { renderPdf } from '../src/pdf/render-pdf';
import { accountFixture } from './fixtures/account';
import { agentFixture } from './fixtures/agent';
import { campaignFixture } from './fixtures/campaign';
import { pdfText } from './helpers/pdf-text';

const chrome = findChrome();

// CI must not pass by skipping: GitHub's Ubuntu runners ship /usr/bin/google-chrome.
it.runIf(!chrome && process.env.CI)('finds a Chrome in CI', () => {
  expect(chrome, 'no Chrome found: set AGENCY_REPORTS_CHROME_PATH or install google-chrome').not.toBeNull();
});

describe.runIf(chrome)('renderPdf', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('embeds IBM Plex from the fontsource packages', () => {
    expect(loadFonts().embedded).toBe(true);
  });

  it('prints the agent review with its figures and "Page X of Y"', async () => {
    const { dataset: d } = agentFixture();
    const { pages, text } = await pdfText(await renderPdf(d, { browser }));
    expect(pages).toBeGreaterThanOrEqual(4);
    const all = text.join(' ');
    expect(all).toContain('Priya Sharma');
    expect(all).toContain(duration(d.presence.station_seconds));
    expect(all).toContain(count(d.record.connected));
    expect(all).toContain(pct(d.record.connect_rate_pct!));
    // Section headings are upper-cased by the stylesheet.
    expect(all).toContain('AGAINST THE FLOOR');
    expect(text[0]).toContain(`Page 1 of ${pages}`);
    expect(text.at(-1)).toContain('DEFINITIONS');
  });

  it('prints the self copy without the floor', async () => {
    const { text } = await pdfText(await renderPdf(agentFixture({ audience: 'self' }).dataset, { browser }));
    expect(text.join(' ')).toContain('Priya Sharma');
    expect(text.join(' ')).not.toContain('AGAINST THE FLOOR');
  });

  it('prints the campaign and account reports', async () => {
    const c = campaignFixture().dataset;
    const ct = await pdfText(await renderPdf(c, { browser }));
    expect(ct.pages).toBeGreaterThan(0);
    expect(ct.text.join(' ')).toContain(count(c.activity.calls.dials));
    const a = accountFixture().dataset;
    const at = await pdfText(await renderPdf(a, { browser }));
    expect(at.pages).toBeGreaterThan(0);
    expect(at.text.join(' ')).toContain(count(a.totals.calls.dials));
    expect(at.text.join(' ')).toContain('Legacy Balances');
  });

  it('launches and closes its own browser when none is passed', async () => {
    const pdf = await renderPdf(campaignFixture().dataset);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
