import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  REPORT_AUDIENCES,
  REPORT_CADENCES,
  REPORT_DOWNLOAD_URL_TTL_SECONDS,
  REPORT_FAILURE_CODES,
  REPORT_FORMATS,
  REPORT_KINDS,
  REPORT_MAX_STORED_WINDOW_MS,
  REPORT_MAX_WINDOW_DAYS,
  REPORT_PENDING_STATUSES,
  REPORT_RUN_STATUSES,
  reportWindowDays,
  reportWindowProblem,
  type AgencyUpdateReportSubscriptionRequest,
  type ReportAudience,
  type ReportCadence,
  type ReportFailureCode,
  type ReportFormat,
  type ReportKind,
  type ReportRunStatus,
} from '../src/api/agency/reports';
import * as Reports from '@magick-agency/contracts/reports';
import {
  REPORT_CALLBACK_MAX_SKEW_SECONDS,
  REPORT_DATASET_VERSION,
  REPORT_DETAIL_COLUMN_TYPES,
  REPORT_DETAIL_SHEETS,
  REPORT_DETAIL_SHEETS_BY_KIND,
  REPORT_OUTPUT_FILE_NAMES,
  REPORT_SIGNATURE_HEADER,
  REPORT_TIMELINE_STATES,
  REPORT_TIMESTAMP_HEADER,
  reportFileName,
  reportSignaturePayload,
  reportSubjectSlug,
  type AccountReportDataset,
  type AgentReviewDataset,
  type CampaignReportDataset,
  type ReportDataset,
  type ReportDatasetOf,
  type ReportDetailColumnType,
  type ReportDetailSheet,
  type ReportTimelineState,
} from '../src/reports/index';
import type { AgencyApi } from '../src/index';
import type { Equals } from './type-equals';

// ── Type-level: each list is exactly its union, and the dataset union discriminates on `kind`.
const _kinds: Equals<(typeof REPORT_KINDS)[number], ReportKind> = true;
const _formats: Equals<(typeof REPORT_FORMATS)[number], ReportFormat> = true;
const _audiences: Equals<(typeof REPORT_AUDIENCES)[number], ReportAudience> = true;
const _statuses: Equals<(typeof REPORT_RUN_STATUSES)[number], ReportRunStatus> = true;
const _cadences: Equals<(typeof REPORT_CADENCES)[number], ReportCadence> = true;
const _failures: Equals<(typeof REPORT_FAILURE_CODES)[number], ReportFailureCode> = true;
const _columns: Equals<(typeof REPORT_DETAIL_COLUMN_TYPES)[number], ReportDetailColumnType> = true;
const _sheets: Equals<(typeof REPORT_DETAIL_SHEETS)[number], ReportDetailSheet> = true;
const _timeline: Equals<(typeof REPORT_TIMELINE_STATES)[number], ReportTimelineState> = true;
const _datasetKinds: Equals<ReportDataset['kind'], ReportKind> = true;
const _agentOf: Equals<ReportDatasetOf<'agent'>, AgentReviewDataset> = true;
const _campaignOf: Equals<ReportDatasetOf<'campaign'>, CampaignReportDataset> = true;
const _accountOf: Equals<ReportDatasetOf<'account'>, AccountReportDataset> = true;
// Reused wire types, not copies: a report figure is the screen's figure.
const _record: Equals<AgentReviewDataset['record'], AgencyApi.AgencyAgentStatsTotals> = true;
const _rosterRow: Equals<AgentReviewDataset['roster_row'], AgencyApi.AgencyRosterAgentRowWithName | null> = true;
const _summary: Equals<CampaignReportDataset['summary'], AgencyApi.AgencyInsightsSummary> = true;
const _activity: Equals<CampaignReportDataset['activity'], AgencyApi.AgencyInsightsActivity> = true;
const _trends: Equals<CampaignReportDataset['trends'], AgencyApi.AgencyInsightsTrends> = true;
const _health: Equals<CampaignReportDataset['health'], AgencyApi.AgencyInsightsHealth> = true;
const _calls: Equals<AccountReportDataset['totals']['calls'], AgencyApi.AgencyInsightsActivity['calls']> = true;
// Only an agent review can be built for the agent themself (RP5).
const _campaignAudience: Equals<CampaignReportDataset['audience'], 'supervisor'> = true;
const _accountAudience: Equals<AccountReportDataset['audience'], 'supervisor'> = true;
// The update body cannot move a subscription to another subject.
const _updateKeys: Equals<Extract<keyof AgencyUpdateReportSubscriptionRequest, 'kind' | 'subject_id'>, never> = true;
void [_kinds, _formats, _audiences, _statuses, _cadences, _failures, _columns, _sheets, _timeline, _datasetKinds,
  _agentOf, _campaignOf, _accountOf, _record, _rosterRow, _summary, _activity, _trends, _health, _calls,
  _campaignAudience, _accountAudience, _updateKeys];

function rendererTitle(dataset: ReportDataset): string {
  // Narrowing on `kind` reaches each kind's own block; a fourth kind fails `never`.
  switch (dataset.kind) {
    case 'agent':
      return dataset.agent.name;
    case 'campaign':
      return dataset.campaign.name;
    case 'account':
      return dataset.account.name;
    default: {
      const unreachable: never = dataset;
      return unreachable;
    }
  }
}
void rendererTitle;

describe('report vocabularies (SNAPSHOT, written out by hand)', () => {
  it('are the values docs/reports.md names, in order', () => {
    expect([...REPORT_KINDS]).toEqual(['agent', 'campaign', 'account']);
    expect([...REPORT_FORMATS]).toEqual(['pdf', 'xlsx']);
    expect([...REPORT_AUDIENCES]).toEqual(['supervisor', 'self']);
    expect([...REPORT_RUN_STATUSES]).toEqual(['queued', 'assembling', 'rendering', 'ready', 'failed', 'expired']);
    expect([...REPORT_PENDING_STATUSES]).toEqual(['queued', 'assembling', 'rendering']);
    expect([...REPORT_CADENCES]).toEqual(['daily', 'weekly', 'monthly']);
    expect([...REPORT_DETAIL_COLUMN_TYPES]).toEqual(['text', 'int', 'number', 'percent', 'duration_s', 'datetime', 'date', 'bool']);
    expect([...REPORT_DETAIL_SHEETS]).toEqual(['sessions', 'state_log', 'calls', 'attempts']);
    expect([...REPORT_TIMELINE_STATES]).toEqual(['available', 'on_call', 'wrapup', 'break', 'offline']);
  });

  it('give every kind its detail sheets, each a known sheet', () => {
    expect(Object.keys(REPORT_DETAIL_SHEETS_BY_KIND).sort()).toEqual([...REPORT_KINDS].sort());
    for (const sheets of Object.values(REPORT_DETAIL_SHEETS_BY_KIND)) {
      for (const sheet of sheets) expect(REPORT_DETAIL_SHEETS).toContain(sheet);
    }
  });
});

describe('report constants', () => {
  it('hold RP2, the download TTL and the callback protocol', () => {
    expect(REPORT_MAX_WINDOW_DAYS).toBe(30);
    // 31 days plus the hour an autumn clock change adds.
    expect(REPORT_MAX_STORED_WINDOW_MS).toBe(745 * 3_600_000);
    expect(REPORT_DOWNLOAD_URL_TTL_SECONDS).toBe(300);
    expect(REPORT_DATASET_VERSION).toBe(1);
    expect(REPORT_SIGNATURE_HEADER).toBe('x-mgkvc-report-signature');
    expect(REPORT_TIMESTAMP_HEADER).toBe('x-mgkvc-report-timestamp');
    expect(REPORT_CALLBACK_MAX_SKEW_SECONDS).toBe(300);
    expect(REPORT_OUTPUT_FILE_NAMES).toEqual({ pdf: 'report.pdf', xlsx: 'report.xlsx' });
    expect(reportSignaturePayload(1_700_000_000, '{"a":1}')).toBe('1700000000.{"a":1}');
  });

  it('is importable as the package subpath', () => {
    expect(Reports.REPORT_DATASET_VERSION).toBe(REPORT_DATASET_VERSION);
    expect(Reports.reportFileName).toBe(reportFileName);
    expect(Reports.REPORT_KINDS).toBe(REPORT_KINDS);
  });
});

describe('reportWindowProblem (RP2)', () => {
  it('accepts up to 30 local days', () => {
    expect(reportWindowDays('2026-10-09', '2026-11-07')).toBe(30);
    expect(reportWindowProblem('2026-10-09', '2026-11-07')).toBeNull();
    expect(reportWindowProblem('2026-11-07', '2026-11-07')).toBeNull();
  });

  it('refuses 31 days that are not one calendar month', () => {
    expect(reportWindowProblem('2026-10-08', '2026-11-07')).toBe('report_window_too_long');
    expect(reportWindowProblem('2026-10-02', '2026-11-01')).toBe('report_window_too_long');
  });

  it('accepts exactly one calendar month of 31 days, and only that', () => {
    expect(reportWindowProblem('2026-10-01', '2026-10-31')).toBeNull();
    expect(reportWindowProblem('2026-12-01', '2026-12-31')).toBeNull();
    // Two months, even short ones, are too long.
    expect(reportWindowProblem('2026-02-01', '2026-03-31')).toBe('report_window_too_long');
    // A 31-day month starting on the 1st but stopping short of its end is 30 days, fine.
    expect(reportWindowProblem('2026-10-01', '2026-10-30')).toBeNull();
  });

  it('refuses malformed, impossible, inverted and future windows', () => {
    expect(reportWindowProblem('2026-10-1', '2026-10-31')).toBe('report_window_invalid');
    expect(reportWindowProblem('2026-02-30', '2026-03-01')).toBe('report_window_invalid');
    expect(reportWindowProblem('2026-11-07', '2026-11-06')).toBe('report_window_invalid');
    expect(reportWindowProblem('2026-11-01', '2026-11-09', '2026-11-08')).toBe('report_window_invalid');
    expect(reportWindowProblem('2026-11-01', '2026-11-08', '2026-11-08')).toBeNull();
    expect(reportWindowProblem('2026-11-01', '2026-11-08', 'today')).toBe('report_window_invalid');
  });
});

describe('reportFileName', () => {
  it('builds the safe ASCII name', () => {
    expect(reportFileName('agent', 'Priya S.', '2026-10-09', '2026-11-07', 'pdf')).toBe(
      'agent-review_priya-s_2026-10-09_2026-11-07.pdf',
    );
    expect(reportFileName('campaign', 'Q4 Renewals / North', '2026-10-01', '2026-10-31', 'xlsx')).toBe(
      'campaign-report_q4-renewals-north_2026-10-01_2026-10-31.xlsx',
    );
    expect(reportFileName('account', 'Acme', '2026-11-01', '2026-11-01', 'pdf')).toBe(
      'account-report_acme_2026-11-01_2026-11-01.pdf',
    );
  });

  it('strips accents, quotes and path characters, and falls back when nothing is left', () => {
    expect(reportSubjectSlug('Zoë Ölçer')).toBe('zoe-olcer');
    expect(reportSubjectSlug('../../etc/passwd"')).toBe('etc-passwd');
    expect(reportSubjectSlug('प्रिया')).toBe('report');
    expect(reportSubjectSlug('   ')).toBe('report');
  });

  it('caps the subject without a trailing dash', () => {
    const slug = reportSubjectSlug(`${'a'.repeat(47)} bcd`);
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('throws on a date that is not YYYY-MM-DD', () => {
    expect(() => reportFileName('agent', 'x', '2026-10-09T00:00:00Z', '2026-11-07', 'pdf')).toThrow(RangeError);
  });

  it('types its arguments', () => {
    expectTypeOf(reportFileName).parameter(0).toEqualTypeOf<ReportKind>();
    expectTypeOf(reportFileName).parameter(4).toEqualTypeOf<ReportFormat>();
  });
});
