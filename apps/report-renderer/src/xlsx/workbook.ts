/**
 * The workbook (RP15): exceljs' streaming writer, one sheet at a time, committed as written.
 * Sheets per kind, in order (summary sheets from the dataset, detail sheets from its gzipped
 * NDJSON files through the {@link DetailReader}):
 * - agent: Summary, Daily, Sessions, State log, Breaks, Calls, Outcomes, Callbacks, Campaigns,
 *   Benchmark (only when the dataset carries one: never for `self`), Definitions;
 * - campaign: Summary, Daily, By hour, Outcomes, Agents, Callbacks, Health, Caller IDs, Attempts,
 *   Sessions, Definitions;
 * - account: Summary, Campaigns, Agents, Daily, Health, Attempts, Definitions.
 * Rates withheld below their floor are written as words, never as 0.
 */
import type { Writable } from 'node:stream';
import ExcelJS from 'exceljs';
import type {
  AccountReportDataset,
  AccountReportFigures,
  AgentReviewDataset,
  CampaignReportDataset,
  ReportDataset,
  ReportDetailFile,
  ReportDetailSheet,
} from '@magick-agency/contracts/reports';
import { average, bucketDate, count, pct, rate, rateText, servedRate, share, type Rate } from '../format';
import type { DetailReader } from '../io';
import { agentConnectRate, agentSuccessRate } from '../rates';
import { excelValue, NUM_FMT, writeTable, type SheetColumn } from './sheet';

type Row = unknown[];

/** A rate as a cell: the percentage (0–100, formatted by the column), or the words. */
function rateCell(r: Rate): number | string {
  return r.kind === 'value' ? r.pct : rateText(r);
}

/** Summary rows are metric, value, unit-typed value; one column per type keeps formats right. */
interface Metric {
  metric: string;
  value: number | string | null;
  type: 'int' | 'percent' | 'duration_s' | 'text' | 'date' | 'datetime';
  definition?: string;
}

const SUMMARY_COLUMNS: SheetColumn[] = [
  { header: 'Metric', type: 'text', width: 34 },
  { header: 'Value', type: 'text', width: 22 },
  { header: 'Definition', type: 'text', width: 90 },
];

async function writeSummary(wb: ExcelJS.stream.xlsx.WorkbookWriter, d: ReportDataset, title: string, metrics: Metric[]): Promise<void> {
  const zone = d.range.timezone;
  const head: Metric[] = [
    { metric: 'Report', value: title, type: 'text' },
    { metric: d.kind === 'agent' ? 'Agent' : d.kind === 'campaign' ? 'Campaign' : 'Account', value: d.subject.name, type: 'text' },
    ...(d.account && d.kind !== 'account' ? [{ metric: 'Account', value: d.account.name, type: 'text' as const }] : []),
    { metric: 'From', value: d.range.from, type: 'date' },
    { metric: 'To', value: d.range.to, type: 'date' },
    { metric: 'Days', value: d.range.days, type: 'int' },
    { metric: 'Time zone', value: zone, type: 'text', definition: 'Every date and time in this workbook is in this zone.' },
    { metric: 'Generated', value: d.generated_at, type: 'datetime' },
    ...(d.kind === 'agent' ? [{ metric: 'Copy', value: d.audience === 'self' ? 'The agent’s own copy' : 'Supervisor’s copy', type: 'text' as const }] : []),
  ];
  const all = [...head, ...metrics];
  // A typed value per row: the Value column holds numbers, dates and text side by side, so each
  // cell is converted with its own row's type.
  const sheet = wb.addWorksheet('Summary', { views: [{ state: 'frozen', ySplit: 1, xSplit: 0 }] });
  sheet.columns = SUMMARY_COLUMNS.map((c) => ({ width: c.width }));
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 3 } };
  const header = sheet.addRow(SUMMARY_COLUMNS.map((c) => c.header));
  header.eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F3F6' } };
  });
  header.commit();
  for (const m of all) {
    const v = typeof m.value === 'string' && m.type !== 'text' && m.type !== 'date' && m.type !== 'datetime' ? m.value : excelValue(m.value, m.type, zone);
    const row = sheet.addRow([m.metric, v, m.definition ?? null]);
    const fmt = NUM_FMT[m.type];
    if (fmt && (typeof v === 'number' || v instanceof Date)) row.getCell(2).numFmt = fmt;
    row.getCell(2).alignment = { horizontal: 'right' };
    row.getCell(3).alignment = { wrapText: true, vertical: 'top' };
    row.commit();
  }
  sheet.commit();
}

function def(d: ReportDataset, key: string): string | undefined {
  return d.definitions.find((x) => x.key === key)?.text;
}

function detailFile(d: ReportDataset, sheet: ReportDetailSheet): ReportDetailFile | undefined {
  return d.detail_files.find((f) => f.sheet === sheet);
}

/** The truncation note on a detail sheet's first row (RP12). */
export function truncationNote(file: ReportDetailFile): string {
  return `This sheet stops at ${count(file.rows)} rows: the report’s limit was reached, so later rows are not listed. The report’s totals count every row.`;
}

async function writeDetail(wb: ExcelJS.stream.xlsx.WorkbookWriter, d: ReportDataset, file: ReportDetailFile | undefined, read: DetailReader): Promise<void> {
  if (!file) return;
  await writeTable(
    wb,
    file.label,
    file.columns.map((c) => ({ header: c.label, type: c.type, width: c.type === 'text' ? Math.max(14, Math.min(28, c.label.length + 10)) : undefined })),
    read(file),
    { zone: d.range.timezone, note: file.truncated ? truncationNote(file) : undefined },
  );
}

async function writeDefinitions(wb: ExcelJS.stream.xlsx.WorkbookWriter, d: ReportDataset): Promise<void> {
  const typeWords: Record<string, string> = {
    text: 'Text',
    int: 'Whole number',
    number: 'Number',
    percent: 'Percentage',
    duration_s: 'Duration (hours:minutes:seconds)',
    datetime: `Date and time in ${d.range.timezone}`,
    date: `Date in ${d.range.timezone}`,
    bool: 'TRUE or FALSE',
  };
  const rows: Row[] = [
    ...d.definitions.map((x) => ['All sheets', x.label, x.text]),
    ['All sheets', 'Rates', 'A rate without enough calls behind it is written in words (“Not enough calls to rate”), never as 0.'],
    ...d.detail_files.flatMap((f) => f.columns.map((c) => [f.label, c.label, typeWords[c.type] ?? c.type])),
    ...d.notes.map((n) => ['Notes', 'This run', n]),
  ];
  await writeTable(
    wb,
    'Definitions',
    [
      { header: 'Sheet', type: 'text', width: 14 },
      { header: 'Column or figure', type: 'text', width: 26 },
      { header: 'Definition', type: 'text', width: 100 },
    ],
    rows,
    { zone: d.range.timezone },
  );
}

// ── Agent ──────────────────────────────────────────────────────────────────────

async function agentWorkbook(wb: ExcelJS.stream.xlsx.WorkbookWriter, d: AgentReviewDataset, read: DetailReader): Promise<void> {
  const zone = d.range.timezone;
  const firstDials = d.daily.reduce((s, r) => s + r.first_dials, 0);
  const humans = d.daily.reduce((s, r) => s + r.human_connects, 0);
  const conversations = d.daily.reduce((s, r) => s + r.conversations, 0);
  const ft = d.follow_through;
  const metrics: Metric[] = [
    { metric: 'Time on station', value: d.presence.station_seconds, type: 'duration_s', definition: def(d, 'station_time') },
    { metric: 'Days worked', value: d.presence.days_worked, type: 'int' },
    { metric: 'On a call (state time)', value: d.presence.by_state.on_call, type: 'duration_s' },
    { metric: 'Wrap-up (state time)', value: d.presence.by_state.wrapup, type: 'duration_s' },
    { metric: 'Idle, waiting', value: d.presence.by_state.available, type: 'duration_s' },
    { metric: 'Break', value: d.presence.by_state.break, type: 'duration_s' },
    { metric: 'Talking (agent leg)', value: d.record.talk_seconds, type: 'duration_s', definition: def(d, 'talk_time') },
    { metric: 'Occupancy (talk + wrap-up ÷ station)', value: d.occupancy.handling_pct ?? 'Not measured', type: 'percent', definition: def(d, 'occupancy') },
    { metric: 'On a call, share of station time', value: d.occupancy.on_call_pct ?? 'Not measured', type: 'percent', definition: def(d, 'on_call_share') },
    { metric: 'On a call, share excluding breaks', value: d.occupancy.on_call_pct_excl_break ?? 'Not measured', type: 'percent' },
    { metric: 'Dials', value: d.record.attempts, type: 'int' },
    { metric: 'First dials', value: firstDials, type: 'int' },
    { metric: 'Connected', value: d.record.connected, type: 'int' },
    { metric: 'Conversations', value: conversations, type: 'int', definition: def(d, 'conversations') },
    { metric: 'People reached', value: humans, type: 'int' },
    { metric: 'Connect rate', value: rateCell(agentConnectRate(d)), type: 'percent', definition: def(d, 'connect_rate') },
    { metric: 'Successes', value: d.record.successes, type: 'int' },
    { metric: 'Success rate', value: rateCell(agentSuccessRate(d)), type: 'percent', definition: def(d, 'success_rate') },
    { metric: 'Average handle time', value: d.record.aht_seconds ?? 'No connected calls', type: 'duration_s', definition: def(d, 'aht') },
    { metric: 'Drops', value: d.presence.drops, type: 'int', definition: def(d, 'drops') },
    { metric: 'Callbacks booked', value: ft.callbacks.booked, type: 'int', definition: def(d, 'callbacks') },
    { metric: 'Wrap-up redials placed', value: ft.redials_placed, type: 'int' },
    { metric: 'Wrap-up redials connected', value: ft.redials_connected, type: 'int' },
    { metric: 'Agent retries', value: ft.agent_retries, type: 'int' },
    { metric: 'Outcome overrides used', value: ft.overrides_used, type: 'int' },
    { metric: 'Numbers marked Do Not Call', value: ft.dnc_marked, type: 'int' },
    { metric: 'Soft-phone calls', value: ft.softphone_calls, type: 'int' },
  ];
  if (d.quality) {
    metrics.push(
      { metric: 'Analysed calls', value: d.quality.analysed_calls, type: 'int', definition: def(d, 'sentiment') },
      { metric: 'Sentiment: positive', value: d.quality.sentiment.positive, type: 'int' },
      { metric: 'Sentiment: neutral', value: d.quality.sentiment.neutral, type: 'int' },
      { metric: 'Sentiment: negative', value: d.quality.sentiment.negative, type: 'int' },
      { metric: 'Sentiment: mixed', value: d.quality.sentiment.mixed, type: 'int' },
    );
  }
  await writeSummary(wb, d, 'Agent performance review', metrics);

  await writeTable(
    wb,
    'Daily',
    [
      { header: 'Date', type: 'date' },
      { header: 'First in', type: 'datetime' },
      { header: 'Last out', type: 'datetime' },
      { header: 'Sessions', type: 'int' },
      { header: 'Drops', type: 'int' },
      { header: 'Station', type: 'duration_s' },
      { header: 'On a call', type: 'duration_s' },
      { header: 'Wrap-up', type: 'duration_s' },
      { header: 'Idle', type: 'duration_s' },
      { header: 'Break', type: 'duration_s' },
      { header: 'Dials', type: 'int' },
      { header: 'First dials', type: 'int' },
      { header: 'Connected', type: 'int' },
      { header: 'Conversations', type: 'int' },
      { header: 'People reached', type: 'int' },
      { header: 'Successes', type: 'int' },
      { header: 'Talk', type: 'duration_s' },
    ],
    d.daily.map((r) => [r.date, r.first_in, r.last_out, r.sessions, r.drops, r.station_s, r.on_call_s, r.wrapup_s, r.available_s, r.break_s, r.dials, r.first_dials, r.connected, r.conversations, r.human_connects, r.successes, r.talk_s]),
    { zone },
  );
  await writeDetail(wb, d, detailFile(d, 'sessions'), read);
  await writeDetail(wb, d, detailFile(d, 'state_log'), read);
  await writeTable(
    wb,
    'Breaks',
    [
      { header: 'Reason', type: 'text' },
      { header: 'Code', type: 'text' },
      { header: 'Time', type: 'duration_s' },
      { header: 'Share of breaks', type: 'percent' },
    ],
    d.presence.break_by_reason.map((b) => [b.label, b.reason, b.seconds, share(b.seconds, d.presence.by_state.break)]),
    { zone },
  );
  await writeDetail(wb, d, detailFile(d, 'calls'), read);
  await writeTable(
    wb,
    'Outcomes',
    [
      { header: 'Outcome', type: 'text' },
      { header: 'Code', type: 'text' },
      { header: 'Success', type: 'bool' },
      { header: 'Conversations', type: 'int' },
      { header: 'Share', type: 'percent' },
      { header: 'Average talk', type: 'duration_s' },
    ],
    d.outcomes.map((o) => [o.label, o.code, o.is_success, o.conversations, o.share_pct, o.avg_talk_s]),
    { zone },
  );
  const cb = ft.callbacks;
  await writeTable(
    wb,
    'Callbacks',
    [
      { header: 'Class', type: 'text' },
      { header: 'Callbacks', type: 'int' },
    ],
    [
      ['Booked in the window', cb.booked],
      ['Kept on time', cb.on_time],
      ['Kept late', cb.late],
      ['Missed', cb.missed],
      ['Not dialled yet, overdue', cb.pending_due],
      ['Not dialled yet, booked time ahead', cb.pending_future],
    ],
    { zone },
  );
  const zoneOf = (id: string) => d.campaigns.find((c) => c.id === id)?.timezone ?? null;
  await writeTable(
    wb,
    'Campaigns',
    [
      { header: 'Campaign', type: 'text' },
      { header: 'Time zone', type: 'text' },
      { header: 'Dials', type: 'int' },
      { header: 'Connected', type: 'int' },
      { header: 'First dials', type: 'int' },
      { header: 'People reached', type: 'int' },
      { header: 'Connect rate', type: 'percent' },
      { header: 'Successes', type: 'int' },
      { header: 'Talk', type: 'duration_s' },
      { header: 'Wrap-up', type: 'duration_s' },
      { header: 'Handle time', type: 'duration_s' },
      { header: 'Rates reportable', type: 'bool' },
    ],
    d.per_campaign.map((r) => [
      r.campaign_name,
      zoneOf(r.campaign_id),
      r.attempts,
      r.connected,
      r.first_dials,
      r.human_connects,
      rateCell(servedRate(r.connect_rate_pct, r.rates_reportable)),
      r.successes,
      r.talk_seconds,
      r.wrapup_seconds,
      average(r.talk_seconds + r.wrapup_seconds, r.connected),
      r.rates_reportable,
    ]),
    { zone },
  );
  if (d.benchmark) {
    const c = d.benchmark.cohort;
    const r = d.roster_row;
    const succOk = r ? (r.success_rate_reportable ?? r.rates_reportable) : false;
    const rows: Row[] = [
      ['Connect rate', '%', r ? rateCell(servedRate(r.connect_rate_pct, r.rates_reportable)) : 'No dials', c.connect_rate.p25, c.connect_rate.median, c.connect_rate.p75, d.benchmark.pool_size],
      ['Occupancy', '%', d.occupancy.handling_pct ?? 'Not measured', c.occupancy_pct.p25, c.occupancy_pct.median, c.occupancy_pct.p75, d.benchmark.pool_size],
      ['Success rate', '%', r ? rateCell(servedRate(r.success_rate_pct, succOk)) : 'No dials', c.success_rate.p25, c.success_rate.median, c.success_rate.p75, null],
    ];
    if (c.aht) rows.push(['Average handle time', 'seconds', r && succOk ? r.aht_seconds : r ? 'Not enough calls to rate' : 'No dials', c.aht.p25, c.aht.median, c.aht.p75, null]);
    await writeTable(
      wb,
      'Benchmark',
      [
        { header: 'Metric', type: 'text', width: 22 },
        { header: 'Unit', type: 'text', width: 9 },
        { header: 'This agent', type: 'number' },
        { header: 'Floor 25th percentile', type: 'number' },
        { header: 'Floor median', type: 'number' },
        { header: 'Floor 75th percentile', type: 'number' },
        { header: 'Agents compared', type: 'int' },
      ],
      rows,
      { zone },
    );
  }
  await writeDefinitions(wb, d);
}

// ── Campaign ───────────────────────────────────────────────────────────────────

async function campaignWorkbook(wb: ExcelJS.stream.xlsx.WorkbookWriter, d: CampaignReportDataset, read: DetailReader): Promise<void> {
  const zone = d.range.timezone;
  const floor = d.floors.campaign_rate_min_first_dials;
  const calls = d.activity.calls;
  const firstDials = calls.dials - calls.redials.placed;
  const answered = d.trends.buckets.reduce((s, b) => s + b.answered, 0);
  const abandoned = d.trends.buckets.reduce((s, b) => s + b.abandoned, 0);
  const talk = average(calls.talk_seconds, calls.connected);
  const wrap = average(calls.wrapup_seconds, calls.wrapup_measured);
  const roster = d.summary.roster;
  await writeSummary(wb, d, 'Campaign report', [
    { metric: 'Status (as of generation)', value: d.campaign.status, type: 'text' },
    { metric: 'Contacts in the list (as of generation)', value: roster.total, type: 'int' },
    { metric: 'Contacts attempted (as of generation)', value: roster.attempted, type: 'int' },
    { metric: 'Contacts completed (as of generation)', value: roster.completed, type: 'int' },
    { metric: 'Dials', value: calls.dials, type: 'int', definition: def(d, 'dials') },
    { metric: 'First dials', value: firstDials, type: 'int' },
    { metric: 'Connected', value: calls.connected, type: 'int', definition: def(d, 'connected') },
    { metric: 'Conversations', value: calls.conversations, type: 'int' },
    { metric: 'People reached', value: calls.human_connects, type: 'int', definition: def(d, 'human_connects') },
    { metric: 'Connect rate', value: rateCell(rate(calls.human_connects, firstDials, floor)), type: 'percent', definition: def(d, 'connect_rate') },
    { metric: 'Successes', value: calls.successes, type: 'int' },
    { metric: 'Success rate', value: rateCell(rate(calls.successes, calls.conversations, floor)), type: 'percent', definition: def(d, 'success_rate') },
    { metric: 'Answered', value: answered, type: 'int' },
    { metric: 'Abandoned', value: abandoned, type: 'int' },
    { metric: 'Abandonment', value: rateCell(rate(abandoned, answered, floor)), type: 'percent', definition: def(d, 'abandonment') },
    { metric: 'Average talk', value: talk ?? 'No connected calls', type: 'duration_s' },
    { metric: 'Average wrap-up', value: wrap ?? 'Not measured', type: 'duration_s' },
    { metric: 'Average handle time', value: talk === null ? 'No connected calls' : talk + (wrap ?? 0), type: 'duration_s', definition: def(d, 'aht') },
    { metric: 'Wrap-up redials placed', value: calls.redials.placed, type: 'int' },
    { metric: 'Callbacks booked', value: d.activity.callbacks.booked, type: 'int', definition: def(d, 'callbacks') },
    { metric: 'Numbers marked Do Not Call', value: d.activity.dnc_marked.total, type: 'int' },
  ]);
  const dates = d.trends.buckets.map((b) => bucketDate(b.bucket_start, d.range.timezone));
  await writeTable(
    wb,
    'Daily',
    [
      { header: 'Date', type: 'date' },
      { header: 'Dials', type: 'int' },
      { header: 'First dials', type: 'int' },
      { header: 'Connected', type: 'int' },
      { header: 'Conversations', type: 'int' },
      { header: 'People reached', type: 'int' },
      { header: 'Successes', type: 'int' },
      { header: 'Abandoned', type: 'int' },
      { header: 'Answered', type: 'int' },
      { header: 'Agents online at peak', type: 'int' },
      { header: 'Connect rate', type: 'percent' },
    ],
    d.trends.buckets.map((b, i) => [dates[i], b.dials, b.first_dials, b.connected, b.conversations, b.human_connects, b.successes, b.abandoned, b.answered, b.agents_online_peak, rateCell(rate(b.human_connects, b.first_dials, floor))]),
    { zone },
  );
  await writeTable(
    wb,
    'By hour',
    [
      { header: 'Hour', type: 'int' },
      { header: 'Dials', type: 'int' },
      { header: 'First dials', type: 'int' },
      { header: 'Connected', type: 'int' },
      { header: 'People reached', type: 'int' },
      { header: 'Connect rate', type: 'percent' },
    ],
    d.trends.best_hours.map((h) => [h.hour, h.dials, h.first_dials, h.connected, h.human_connects, rateCell(rate(h.human_connects, h.first_dials, floor))]),
    { zone },
  );
  await writeTable(
    wb,
    'Outcomes',
    [
      { header: 'Outcome', type: 'text' },
      { header: 'Code', type: 'text' },
      { header: 'Success', type: 'bool' },
      { header: 'Conversations', type: 'int' },
      { header: 'Share', type: 'percent' },
    ],
    d.activity.outcomes.map((o) => [o.label ?? (o.code === null ? 'No outcome written' : `${o.code} (retired)`), o.code, o.is_success, o.count, share(o.count, calls.conversations)]),
    { zone },
  );
  const name = (id: string | null, served?: string | null) => (id === null ? 'Not reserved to an agent' : (served ?? d.agent_names[id] ?? `Unknown user ${id.slice(0, 8)}`));
  await writeTable(
    wb,
    'Agents',
    [
      { header: 'Agent', type: 'text' },
      { header: 'Dials', type: 'int' },
      { header: 'Connected', type: 'int' },
      { header: 'Conversations', type: 'int' },
      { header: 'People reached', type: 'int' },
      { header: 'Connect rate', type: 'percent' },
      { header: 'Successes', type: 'int' },
      { header: 'Success rate', type: 'percent' },
      { header: 'Talk', type: 'duration_s' },
      { header: 'Wrap-up', type: 'duration_s' },
      { header: 'Online', type: 'duration_s' },
      { header: 'On a call', type: 'duration_s' },
      { header: 'Idle', type: 'duration_s' },
      { header: 'Wrap-up (state)', type: 'duration_s' },
      { header: 'Break', type: 'duration_s' },
      { header: 'Redials', type: 'int' },
      { header: 'Retries', type: 'int' },
      { header: 'Overrides', type: 'int' },
    ],
    d.activity.agents.map((a) => [
      name(a.agent_user_id, a.agent_name),
      a.dials,
      a.connected,
      a.conversations,
      a.human_connects,
      a.agent_user_id ? rateCell(rate(a.human_connects, a.dials - a.redials, floor)) : null,
      a.successes,
      a.agent_user_id ? rateCell(rate(a.successes, a.conversations, floor)) : null,
      a.talk_seconds,
      a.wrapup_seconds,
      a.online_seconds,
      a.state_seconds.on_call,
      a.state_seconds.available,
      a.state_seconds.wrapup,
      Object.values(a.state_seconds.break_by_reason).reduce((s, v) => s + v, 0),
      a.redials,
      a.retries,
      a.overrides,
    ]),
    { zone },
  );
  const cb = d.activity.callbacks;
  await writeTable(
    wb,
    'Callbacks',
    [
      { header: 'Owner', type: 'text' },
      { header: 'Booked', type: 'int' },
      { header: 'Kept on time', type: 'int' },
      { header: 'Kept late', type: 'int' },
      { header: 'Missed', type: 'int' },
      { header: 'Overdue', type: 'int' },
      { header: 'Open', type: 'int' },
    ],
    [
      ['Whole campaign', cb.booked, cb.kept_on_time, cb.kept_late, cb.missed, cb.pending_due, cb.pending_due + cb.pending_future],
      ...cb.by_owner.map((o) => [o.agent_user_id ? name(o.agent_user_id) : 'No owner (pool)', null, null, null, null, o.overdue, o.open]),
    ],
    { zone },
  );
  const h = d.health;
  const healthRows: Row[] = [
    ['Abandonment', 'Abandoned in the window', abandoned, null, null],
    ['Abandonment', 'Answered in the window', answered, null, null],
    ['Abandonment', 'Ceiling (%)', h.abandonment.ceiling_pct, null, null],
    ...h.abandonment.auto_pauses.map((p) => ['Auto-pause', p.measured_pct === null ? 'Measured rate not recorded' : `Measured ${pct(p.measured_pct)}`, null, p.at, null]),
    ...Object.entries(h.stalls.minutes_by_reason).map(([k, m]) => ['Stall minutes', k, m, null, null]),
    ...h.stalls.episodes.map((e) => ['Stall episode', e.reason, e.minutes, e.started_at, e.ended_at]),
    ['Concurrency', 'Minutes at the concurrency limit', h.concurrency_limit_minutes, null, null],
    ['Carrier', 'Carrier failures', h.carrier_failures, null, null],
    ...h.carrier_failures_by_code.map((c) => ['Carrier', `Failure code ${c.error_code ?? 'none'}`, c.count, null, null]),
    ['Carrier', 'Retired, our fault', h.our_fault_retired, null, null],
    ['Blocked before dialling', 'Do Not Call', h.predial_blocks.dnc, null, null],
    ['Blocked before dialling', 'Invalid number', h.predial_blocks.invalid, null, null],
    ['Blocked before dialling', 'Deferred to calling hours', h.predial_blocks.outside_calling_hours_deferrals, null, null],
    ['Recording', 'Connected calls', h.recording.connected, null, null],
    ['Recording', 'Recorded', h.recording.recorded, null, null],
  ];
  await writeTable(
    wb,
    'Health',
    [
      { header: 'Section', type: 'text' },
      { header: 'Key', type: 'text', width: 34 },
      { header: 'Value', type: 'number' },
      { header: 'Started at', type: 'datetime' },
      { header: 'Ended at', type: 'datetime' },
    ],
    healthRows,
    { zone },
  );
  await writeTable(
    wb,
    'Caller IDs',
    [
      { header: 'Caller ID', type: 'text' },
      { header: 'Dials', type: 'int' },
      { header: 'First dials', type: 'int' },
      { header: 'Connected', type: 'int' },
      { header: 'People reached', type: 'int' },
      { header: 'Connect rate', type: 'percent' },
    ],
    h.caller_ids.map((c) => [c.caller_id, c.dials, c.first_dials, c.connected, c.human_connects, rateCell(rate(c.human_connects, c.first_dials, floor))]),
    { zone },
  );
  await writeDetail(wb, d, detailFile(d, 'attempts'), read);
  await writeDetail(wb, d, detailFile(d, 'sessions'), read);
  await writeDefinitions(wb, d);
}

// ── Account ────────────────────────────────────────────────────────────────────

async function accountWorkbook(wb: ExcelJS.stream.xlsx.WorkbookWriter, d: AccountReportDataset, read: DetailReader): Promise<void> {
  const zone = d.range.timezone;
  const floor = d.floors.campaign_rate_min_first_dials;
  const t = d.totals;
  const fd = (f: AccountReportFigures) => f.calls.dials - f.calls.redials.placed;
  await writeSummary(wb, d, 'Account report', [
    { metric: 'Campaigns', value: d.campaigns.length, type: 'int' },
    ...['running', 'paused', 'completed', 'stopped', 'stopping', 'draft']
      .map((s) => ({ s, n: d.campaigns.filter((c) => c.status === s).length }))
      .filter((x) => x.n > 0)
      .map((x) => ({ metric: `Campaigns ${x.s} (as of generation)`, value: x.n, type: 'int' as const })),
    { metric: 'Dials', value: t.calls.dials, type: 'int' },
    { metric: 'First dials', value: fd(t), type: 'int' },
    { metric: 'Connected', value: t.calls.connected, type: 'int' },
    { metric: 'Conversations', value: t.calls.conversations, type: 'int' },
    { metric: 'People reached', value: t.calls.human_connects, type: 'int' },
    { metric: 'Connect rate', value: rateCell(rate(t.calls.human_connects, fd(t), floor)), type: 'percent', definition: def(d, 'connect_rate') },
    { metric: 'Successes', value: t.calls.successes, type: 'int' },
    { metric: 'Success rate', value: rateCell(rate(t.calls.successes, t.calls.conversations, floor)), type: 'percent', definition: def(d, 'success_rate') },
    { metric: 'Abandonment', value: rateCell(rate(t.abandoned, t.answered, floor)), type: 'percent', definition: def(d, 'abandonment') },
    { metric: 'Talk', value: t.calls.talk_seconds, type: 'duration_s' },
    { metric: 'Callbacks booked', value: t.callbacks_booked, type: 'int' },
    { metric: 'Recorded share of connected calls', value: rateCell(rate(t.recorded, t.recording_connected, 1)), type: 'percent', definition: def(d, 'recording') },
  ]);
  const figures = (f: AccountReportFigures): Row => {
    const talk = average(f.calls.talk_seconds, f.calls.connected);
    const wrap = average(f.calls.wrapup_seconds, f.calls.wrapup_measured);
    return [
      f.calls.dials,
      f.calls.connected,
      rateCell(rate(f.calls.human_connects, fd(f), floor)),
      f.calls.conversations,
      f.calls.successes,
      rateCell(rate(f.calls.successes, f.calls.conversations, floor)),
      f.calls.talk_seconds,
      talk === null ? null : talk + (wrap ?? 0),
      rateCell(rate(f.abandoned, f.answered, floor)),
      f.callbacks_booked,
      f.recorded,
    ];
  };
  await writeTable(
    wb,
    'Campaigns',
    [
      { header: 'Campaign', type: 'text' },
      { header: 'Status', type: 'text' },
      { header: 'Time zone', type: 'text' },
      { header: 'Dials', type: 'int' },
      { header: 'Connected', type: 'int' },
      { header: 'Connect rate', type: 'percent' },
      { header: 'Conversations', type: 'int' },
      { header: 'Successes', type: 'int' },
      { header: 'Success rate', type: 'percent' },
      { header: 'Talk', type: 'duration_s' },
      { header: 'Handle time', type: 'duration_s' },
      { header: 'Abandoned', type: 'percent' },
      { header: 'Callbacks booked', type: 'int' },
      { header: 'Recorded', type: 'int' },
    ],
    [...d.campaigns.map((c) => [c.name, c.status, c.timezone, ...figures(c)]), ['All campaigns', null, null, ...figures(t)]],
    { zone },
  );
  const c = d.benchmark.cohort;
  await writeTable(
    wb,
    'Agents',
    [
      { header: 'Agent', type: 'text' },
      { header: 'Campaigns', type: 'int' },
      { header: 'Dials', type: 'int' },
      { header: 'Connected', type: 'int' },
      { header: 'Successes', type: 'int' },
      { header: 'Connect rate', type: 'percent' },
      { header: 'Success rate', type: 'percent' },
      { header: 'Handle time', type: 'duration_s' },
      { header: 'Occupancy', type: 'percent' },
      { header: 'On station', type: 'duration_s' },
      { header: 'Break', type: 'duration_s' },
      { header: 'Last dialled', type: 'datetime' },
      { header: 'Rates reportable', type: 'bool' },
    ],
    [
      ['Floor 25th percentile', null, null, null, null, c.connect_rate.p25, c.success_rate.p25, c.aht?.p25 ?? null, c.occupancy_pct.p25, null, null, null, null],
      ['Floor median', null, null, null, null, c.connect_rate.median, c.success_rate.median, c.aht?.median ?? null, c.occupancy_pct.median, null, null, null, null],
      ['Floor 75th percentile', null, null, null, null, c.connect_rate.p75, c.success_rate.p75, c.aht?.p75 ?? null, c.occupancy_pct.p75, null, null, null, null],
      ...d.agents.map((a) => {
        const succOk = a.success_rate_reportable ?? a.rates_reportable;
        return [
          a.agent_name ?? `Unknown user ${a.agent_user_id.slice(0, 8)}`,
          a.campaigns,
          a.attempts,
          a.connected,
          a.successes,
          rateCell(servedRate(a.connect_rate_pct, a.rates_reportable)),
          rateCell(servedRate(a.success_rate_pct, succOk)),
          a.aht_seconds === null ? null : succOk ? a.aht_seconds : 'Not enough calls to rate',
          a.occupancy_pct ?? 'Not measured',
          a.shift_seconds,
          a.break_seconds,
          a.last_dialed_at,
          a.rates_reportable,
        ];
      }),
    ],
    { zone },
  );
  await writeTable(
    wb,
    'Daily',
    [
      { header: 'Date', type: 'date' },
      { header: 'Dials', type: 'int' },
      { header: 'First dials', type: 'int' },
      { header: 'Connected', type: 'int' },
      { header: 'Conversations', type: 'int' },
      { header: 'People reached', type: 'int' },
      { header: 'Successes', type: 'int' },
      { header: 'Agents online at peak', type: 'int' },
      { header: 'Connect rate', type: 'percent' },
    ],
    d.daily.map((r) => [r.date, r.dials, r.first_dials, r.connected, r.conversations, r.human_connects, r.successes, r.agents_online_peak ?? 'Not measured', rateCell(rate(r.human_connects, r.first_dials, floor))]),
    { zone },
  );
  const campaignName = (id: string) => d.campaigns.find((x) => x.id === id)?.name ?? id;
  await writeTable(
    wb,
    'Health',
    [
      { header: 'Campaign', type: 'text' },
      { header: 'Section', type: 'text' },
      { header: 'Key', type: 'text', width: 30 },
      { header: 'Value', type: 'int' },
    ],
    d.health.flatMap((h) => [
      [campaignName(h.campaign_id), 'Abandonment', 'Auto-pauses', h.auto_pauses],
      ...Object.entries(h.stall_minutes_by_reason).map(([k, m]) => [campaignName(h.campaign_id), 'Stall minutes', k, m]),
      [campaignName(h.campaign_id), 'Concurrency', 'Minutes at the limit', h.concurrency_limit_minutes],
      [campaignName(h.campaign_id), 'Carrier', 'Carrier failures', h.carrier_failures],
      [campaignName(h.campaign_id), 'Carrier', 'Retired, our fault', h.our_fault_retired],
      [campaignName(h.campaign_id), 'Blocked before dialling', 'Do Not Call', h.predial_blocks.dnc],
      [campaignName(h.campaign_id), 'Blocked before dialling', 'Invalid number', h.predial_blocks.invalid],
      [campaignName(h.campaign_id), 'Blocked before dialling', 'Deferred to calling hours', h.predial_blocks.outside_calling_hours_deferrals],
    ]),
    { zone },
  );
  await writeDetail(wb, d, detailFile(d, 'attempts'), read);
  await writeDefinitions(wb, d);
}

/**
 * Write the dataset's workbook to `out`. Resolves once the last byte is handed to `out` (the
 * caller waits for `out` to finish, e.g. a file stream's `close`). A detail file that will not
 * read rejects with a `RenderFailure('dataset_unreadable')`.
 */
export async function writeWorkbook(dataset: ReportDataset, detailReader: DetailReader, out: Writable): Promise<void> {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true, useSharedStrings: false });
  wb.creator = 'Magick Agency';
  wb.created = new Date(dataset.generated_at);
  wb.modified = new Date(dataset.generated_at);
  switch (dataset.kind) {
    case 'agent':
      await agentWorkbook(wb, dataset, detailReader);
      break;
    case 'campaign':
      await campaignWorkbook(wb, dataset, detailReader);
      break;
    case 'account':
      await accountWorkbook(wb, dataset, detailReader);
      break;
  }
  await wb.commit();
}

