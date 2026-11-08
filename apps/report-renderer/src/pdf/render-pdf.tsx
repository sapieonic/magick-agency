/**
 * The PDF path (RP15): React server rendering of the kind's template to one HTML document with
 * inline CSS, inline SVG charts and embedded fonts, printed by headless Chromium to A4 with a
 * running header and a "Page X of Y" footer.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import type { Browser } from 'puppeteer-core';
import type { ReportDataset } from '@magick-agency/contracts/reports';
import { dateTime, rangeLabel } from '../format';
import { launchBrowser, type ChromeOptions } from './chrome';
import { Doc } from './components';
import { loadFonts, type FontSet } from './fonts';
import { AccountReport } from './templates/account';
import { AgentReview } from './templates/agent';
import { CampaignReport } from './templates/campaign';

export interface HtmlOptions {
  /** The embedded fonts; defaults to {@link loadFonts}. Pass `{ css: '', embedded: false }` to skip them (tests). */
  fonts?: FontSet;
}

export interface PdfOptions extends ChromeOptions, HtmlOptions {
  /** A browser to reuse (it is left open); otherwise one is launched and closed per call. */
  browser?: Browser;
  /** Milliseconds to wait for the page to load and print. */
  timeoutMs?: number;
}

const TITLES = { agent: 'Agent performance review', campaign: 'Campaign report', account: 'Account report' } as const;

/** The report's document title, e.g. "Agent performance review · Priya Sharma". */
export function reportTitle(dataset: ReportDataset): string {
  return `${TITLES[dataset.kind]} · ${dataset.subject.name}`;
}

/** The whole HTML document for a dataset. Pure: no clock, no I/O beyond reading the font files once. */
export function renderReportHtml(dataset: ReportDataset, options: HtmlOptions = {}): string {
  const fonts = options.fonts ?? loadFonts();
  let body;
  switch (dataset.kind) {
    case 'agent':
      body = <AgentReview d={dataset} />;
      break;
    case 'campaign':
      body = <CampaignReport d={dataset} />;
      break;
    case 'account':
      body = <AccountReport d={dataset} />;
      break;
    default: {
      const never: never = dataset;
      throw new TypeError(`unknown report kind ${(never as { kind: string }).kind}`);
    }
  }
  return `<!doctype html>${renderToStaticMarkup(
    <Doc title={reportTitle(dataset)} fontsCss={fonts.css}>
      {body}
    </Doc>,
  )}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Chromium's header and footer templates: small, mono, in the margins. */
export function headerFooter(dataset: ReportDataset, fonts: FontSet): { headerTemplate: string; footerTemplate: string } {
  const zone = dataset.range.timezone;
  // The header and footer are separate documents: they get the mono face again (one weight).
  const mono = fonts.css
    .split('\n')
    .filter((r) => r.includes("'IBM Plex Mono'") && r.includes('font-weight:400'))
    .join('\n');
  const style = `<style>${mono} .hf{font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:7.5px;color:#7a8391;width:100%;padding:0 14mm;display:flex;justify-content:space-between;-webkit-print-color-adjust:exact}</style>`;
  const headerTemplate = `${style}<div class="hf"><span>${escapeHtml(reportTitle(dataset))}</span><span>${escapeHtml(rangeLabel(dataset.range.from, dataset.range.to))} · ${escapeHtml(zone)}</span></div>`;
  const footerTemplate = `${style}<div class="hf"><span>Magick Agency · generated ${escapeHtml(dateTime(dataset.generated_at, zone))} (${escapeHtml(zone)})</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
  return { headerTemplate, footerTemplate };
}

/** Render a dataset to PDF bytes. Closes any browser it launched, whatever happens. */
export async function renderPdf(dataset: ReportDataset, options: PdfOptions = {}): Promise<Buffer> {
  const fonts = options.fonts ?? loadFonts();
  const html = renderReportHtml(dataset, { fonts });
  const timeout = options.timeoutMs ?? 60_000;
  const owned = options.browser ? null : await launchBrowser(options);
  const browser = options.browser ?? owned!;
  try {
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load', timeout });
      // Wait for the embedded faces to decode before printing (a string, so no DOM types are needed here).
      await page.evaluate('document.fonts.ready.then(() => true)');
      const { headerTemplate, footerTemplate } = headerFooter(dataset, fonts);
      const pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate,
        footerTemplate,
        margin: { top: '15mm', bottom: '15mm', left: '14mm', right: '14mm' },
        timeout,
      });
      return Buffer.from(pdf);
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    if (owned) {
      await owned.close().catch(() => {
        owned.process()?.kill('SIGKILL');
      });
    }
  }
}
