/**
 * Real PDFs from a real Chromium (found by findChrome; GitHub's runners have
 * /usr/bin/google-chrome): page counts, the running footer, and the key figures in the text.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'puppeteer-core';
import { count, duration, pct } from '../src/format';
import { findChrome, launchBrowser } from '../src/pdf/chrome';
import { loadFonts } from '../src/pdf/fonts';
import { isInlineUrl, renderPdf } from '../src/pdf/render-pdf';
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
    // The definitions come last; the server's run onto a second page, with the run's notes after them.
    const defs = text.findIndex((t) => t.includes('DEFINITIONS'));
    expect(defs).toBeGreaterThan(text.findIndex((t) => t.includes('AGAINST THE FLOOR')));
    expect(text.slice(defs).join(' ')).toContain('NOTES ON THIS RUN');
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

  it('still embeds IBM Plex in the PDF itself with requests intercepted', async () => {
    const pdf = await renderPdf(campaignFixture().dataset, { browser });
    // Font names are written in the PDF's font dictionaries, subset-prefixed: `ABCDEF+IBMPlexSans-…`.
    const latin = pdf.toString('latin1');
    expect(latin).toMatch(/\+IBMPlexSans/);
    expect(latin).toMatch(/\+IBMPlexMono/);
  });

  it('fetches nothing off the page, whatever the document names', async () => {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'text/css' });
      res.end('');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      // A stylesheet naming outside URLs four ways: an import, a face the body uses, a background, an image.
      const fonts = {
        embedded: true,
        css:
          `@import url(${base}/import.css);\n` +
          `@font-face{font-family:'IBM Plex Sans';src:url(${base}/plex.woff2) format('woff2')}\n` +
          `body{background-image:url(${base}/bg.png)}\n` +
          `h1::after{content:url(${base}/after.png)}`,
      };
      const pdf = await renderPdf(campaignFixture().dataset, { browser, fonts });
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(hits).toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('allows only inline URLs', () => {
    expect(isInlineUrl('data:font/woff2;base64,AAAA')).toBe(true);
    expect(isInlineUrl('about:blank')).toBe(true);
    expect(isInlineUrl('http://127.0.0.1/x')).toBe(false);
    expect(isInlineUrl('https://fonts.example/x.woff2')).toBe(false);
    expect(isInlineUrl('file:///etc/passwd')).toBe(false);
  });

  it('launches and closes its own browser when none is passed', async () => {
    const pdf = await renderPdf(campaignFixture().dataset);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
