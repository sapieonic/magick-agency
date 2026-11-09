/**
 * The "report ready" email (`agency.report.ready`, docs/reports.md RP6): a run finished, ready or
 * failed, and someone asked to be told (the requester with `email_me`, or a subscription's
 * recipients). It carries a link to the run's console page and nothing else: no attachment, no
 * figures (the report is the place for those, behind sign-in).
 *
 * A pure function of the facts and the console origin, so the copy and the link are tested
 * without a transport. British English throughout.
 */
import { consoleScopePrefix } from '@magick-agency/contracts/api/platform/console-urls';
import type { ReportKind } from '@magick-agency/contracts/api/agency/reports';
import { escapeHtml } from '../escape-html.js';
import { DEFAULT_BRAND_ACCENT } from './invite-email.layout.js';

/** What the email is about. */
export interface ReportReadyEmailInput {
  tenantId: string;
  accountId: string | null;
  runId: string;
  kind: ReportKind;
  /** The subject's display name; falls back to "the selected period" wording when null. */
  subjectName: string | null;
  /** `YYYY-MM-DD`, both inclusive. */
  from: string;
  to: string;
  timezone: string;
  outcome: 'ready' | 'failed';
  truncated: boolean;
  /** Set for a subscription's run: the email says it is a scheduled report. */
  scheduled: boolean;
  /** `AGENCY_REPORTS_RETENTION_DAYS`: how long the files stay downloadable. */
  retentionDays: number;
  brandName: string;
  brandAccent?: string;
}

export interface RenderedReportEmail {
  subject: string;
  textBody: string;
  htmlBody: string;
  /** The console link, or null without a configured console origin. */
  url: string | null;
}

/** What each kind is called in the email. */
const KIND_NOUNS: Record<ReportKind, string> = {
  agent: 'agent review',
  campaign: 'campaign report',
  account: 'account report',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-10-09` → `9 Oct 2026`. */
export function formatReportDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** `9 Oct 2026 to 7 Nov 2026`, or the one day. */
export function formatReportWindow(from: string, to: string): string {
  return from === to ? formatReportDate(from) : `${formatReportDate(from)} to ${formatReportDate(to)}`;
}

/**
 * `/t/:tenant/a/:account/agency/reports/:runId` under the console origin: the run page, in the
 * run's own tenant and account (B26, `consoleScopePrefix`, the builder the console's router parses
 * against). Unscoped with no account. Null with no origin rather than a guessed one.
 */
export function reportRunUrl(
  target: { tenantId: string; accountId: string | null; runId: string },
  consoleBaseUrl: string | undefined,
): string | null {
  if (!consoleBaseUrl) return null;
  const origin = consoleBaseUrl.replace(/\/+$/, '');
  const path = `/agency/reports/${encodeURIComponent(target.runId)}`;
  return target.accountId
    ? `${origin}${consoleScopePrefix({ tenantId: target.tenantId, accountId: target.accountId })}${path}`
    : `${origin}${path}`;
}

export function renderReportReadyEmail(input: ReportReadyEmailInput, consoleBaseUrl: string | undefined): RenderedReportEmail {
  const noun = KIND_NOUNS[input.kind];
  const lead = input.scheduled ? `Your scheduled ${noun}` : `Your ${noun}`;
  const about = input.subjectName?.trim() ? ` for ${input.subjectName.trim()}` : '';
  const window = formatReportWindow(input.from, input.to);
  const url = reportRunUrl(input, consoleBaseUrl);
  const accent = input.brandAccent ?? DEFAULT_BRAND_ACCENT;

  const subject = input.outcome === 'ready'
    ? `${lead}${about} is ready`
    : `${lead}${about} could not be prepared`;

  const lines: string[] = input.outcome === 'ready'
    ? [
      `${lead}${about}, covering ${window} (${input.timezone}), is ready to download.`,
      ...(input.truncated ? ['Some detail sheets reached their row limit and were cut short; the report says which.'] : []),
      `The files can be downloaded for ${input.retentionDays} days.`,
    ]
    : [
      `${lead}${about}, covering ${window} (${input.timezone}), could not be prepared.`,
      'Open the report to see why and to run it again.',
    ];
  const action = input.outcome === 'ready' ? 'Open the report' : 'View the report';

  const textBody = [
    ...lines,
    '',
    ...(url ? [`${action}: ${url}`, ''] : []),
    `Sent by ${input.brandName}`,
  ].join('\n');

  const htmlBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a2e; background-color: #ffffff;">
      <h2 style="margin: 0 0 16px; color: #1a1a2e;">${escapeHtml(subject)}</h2>
      ${lines.map((line) => `<p style="margin: 0 0 12px; font-size: 14px; color: #333333;">${escapeHtml(line)}</p>`).join('\n      ')}
      ${url ? `<p style="margin-top: 20px;"><a href="${escapeHtml(url)}" style="color: ${accent}; text-decoration: none; font-weight: 500;">${action} &rarr;</a></p>` : ''}
      <p style="margin-top: 24px; font-size: 12px; color: #999999;">Sent by ${escapeHtml(input.brandName)}</p>
    </div>
  `.trim();

  return { subject, textBody, htmlBody, url };
}
