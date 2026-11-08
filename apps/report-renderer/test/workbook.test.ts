/**
 * The workbook, read back with exceljs: sheet names and order per kind, header rows, typed cells
 * and number formats, detail sheets' row counts, and the truncation note.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ReportDataset } from '@magick-agency/contracts/reports';
import { definitionText, type DefinitionKey } from '../src/definitions';
import { detailReaderFromIO } from '../src/io';
import { detailSheetNames, FIXED_SHEETS, writeWorkbook } from '../src/xlsx/workbook';
import { accountFixture } from './fixtures/account';
import { agentFixture } from './fixtures/agent';
import { campaignFixture } from './fixtures/campaign';
import { MemoryIO } from './helpers/memory-io';
import { headerOf, readWorkbook, serial } from './helpers/xlsx';

async function build(dataset: ReportDataset, details: Map<string, Buffer>): Promise<Buffer> {
  const io = new MemoryIO(undefined, undefined, details);
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c: Buffer) => chunks.push(c));
  const ended = new Promise((r) => out.on('end', r));
  await writeWorkbook(dataset, detailReaderFromIO(io), out);
  await ended;
  return Buffer.concat(chunks);
}

/** The Summary's Definition cell (column C) per metric (column A). */
function summaryDefinitions(wb: import('exceljs').Workbook): Map<string, unknown> {
  const out = new Map<string, unknown>();
  wb.getWorksheet('Summary')!.eachRow((r, n) => {
    if (n > 1) out.set(String(r.getCell(1).value), r.getCell(3).value);
  });
  return out;
}

/** Every Summary metric the workbook gives a definition, with the key it reads: each cell holds that definition's text. */
function expectDefinitions<D extends ReportDataset>(wb: import('exceljs').Workbook, d: D, expected: Array<[string, DefinitionKey<D['kind']>]>): void {
  const cells = summaryDefinitions(wb);
  for (const [metric, key] of expected) {
    const text = definitionText(d, key);
    expect(text, key).toBeTruthy();
    expect(cells.get(metric), metric).toBe(text);
  }
  // No other metric has one (but the time zone, whose sentence is the workbook's own).
  const filled = [...cells].filter(([, v]) => v !== null && v !== undefined && v !== '').map(([m]) => m);
  expect(filled.sort()).toEqual([...expected.map(([m]) => m), 'Time zone'].sort());
}

describe('agent workbook', async () => {
  const { dataset: d, details } = agentFixture();
  const wb = await readWorkbook(await build(d, details));

  it('has the agent sheets in order, Benchmark included for a supervisor', () => {
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Summary', 'Daily', 'Sessions', 'State log', 'Breaks', 'Calls', 'Outcomes', 'Callbacks', 'Campaigns', 'Benchmark', 'Definitions',
    ]);
  });

  it('writes the Summary as metric, value, definition with typed values', () => {
    const ws = wb.getWorksheet('Summary')!;
    expect(headerOf(ws)).toEqual(['Metric', 'Value', 'Definition']);
    const rowOf = (metric: string) => {
      let found: import('exceljs').Row | undefined;
      ws.eachRow((r) => {
        if (r.getCell(1).value === metric) found = r;
      });
      return found!;
    };
    const station = rowOf('Time on station').getCell(2);
    expect(serial(station.value)).toBeCloseTo(d.presence.station_seconds / 86400, 6);
    expect(station.numFmt).toBe('[h]:mm:ss');
    const rate = rowOf('Connect rate').getCell(2);
    expect(rate.value).toBeCloseTo(d.record.connect_rate_pct! / 100, 9);
    expect(rate.numFmt).toBe('0.0%');
    expect(rowOf('Dials').getCell(2).value).toBe(d.record.attempts);
    expect(rowOf('Time zone').getCell(2).value).toBe('Asia/Kolkata');
    const q = d.quality!;
    expect(q.sentiment.mixed).toBeGreaterThan(0);
    expect(rowOf('Sentiment: mixed').getCell(2).value).toBe(q.sentiment.mixed);
    expect(rowOf('Sentiment: neutral').getCell(2).value).toBe(q.sentiment.neutral);
    expect(q.sentiment.positive + q.sentiment.neutral + q.sentiment.negative + q.sentiment.mixed).toBe(q.analysed_calls);
  });

  it('fills the Summary’s Definition cells from the dataset’s definitions', () => {
    expectDefinitions(wb, d, [
      ['Time on station', 'logged_in_time'],
      ['Talking (agent leg)', 'talk_time'],
      ['Occupancy (talk + wrap-up ÷ station)', 'occupancy'],
      ['On a call, share of station time', 'on_call_share'],
      ['Connect rate', 'connect_rate'],
      ['Success rate', 'success_rate'],
      ['Average handle time', 'aht'],
      ['Drops', 'drops'],
      ['Callbacks booked', 'callbacks_booked'],
      ['Analysed calls', 'sentiment'],
    ]);
  });

  it('writes the detail sheets with every row, a frozen header and an autofilter', () => {
    for (const f of d.detail_files) {
      const ws = wb.getWorksheet(f.label)!;
      expect(headerOf(ws)).toEqual(f.columns.map((c) => c.label));
      expect(ws.actualRowCount).toBe(f.rows + 1);
      expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
      expect(ws.autoFilter).toBeTruthy();
    }
  });

  it('converts datetimes to the dataset’s zone and durations to time values', () => {
    const ws = wb.getWorksheet('Calls')!;
    const cols = d.detail_files.find((f) => f.sheet === 'calls')!.columns;
    const row = ws.getRow(2);
    const dialled = row.getCell(cols.findIndex((c) => c.key === 'dialed_at') + 1);
    expect(dialled.value).toBeInstanceOf(Date);
    expect(dialled.numFmt).toBe('yyyy-mm-dd hh:mm:ss');
    // The first call of 9 Oct, IST: the cell's wall clock is Kolkata's, not UTC's.
    const wall = (dialled.value as Date).toISOString();
    expect(wall.startsWith('2026-10-09T09:')).toBe(true);
    const talkCol = cols.findIndex((c) => c.key === 'talk_s') + 1;
    let talkCell: import('exceljs').Cell | undefined;
    ws.eachRow((r, n) => {
      if (!talkCell && n > 1 && r.getCell(talkCol).value !== null) talkCell = r.getCell(talkCol);
    });
    expect(talkCell!.numFmt).toBe('[h]:mm:ss');
    expect(serial(talkCell!.value)).toBeLessThan(1);
    expect(serial(talkCell!.value)).toBeGreaterThan(0);
    const recorded = cols.findIndex((c) => c.key === 'recorded') + 1;
    expect(typeof ws.getRow(2).getCell(recorded).value).toBe('boolean');
  });

  it('writes a withheld campaign rate as words in its percentage column', () => {
    const ws = wb.getWorksheet('Campaigns')!;
    const legacy = d.per_campaign.find((r) => !r.rates_reportable)!;
    let cell: unknown;
    ws.eachRow((r) => {
      if (r.getCell(1).value === legacy.campaign_name) cell = r.getCell(7).value;
    });
    expect(cell).toBe('Not enough calls to rate');
  });
});

describe('agent workbook, self audience', async () => {
  const { dataset: d, details } = agentFixture({ audience: 'self' });
  const wb = await readWorkbook(await build(d, details));
  it('has no Benchmark sheet and no sentiment or recording column', () => {
    expect(wb.worksheets.map((w) => w.name)).not.toContain('Benchmark');
    expect(headerOf(wb.getWorksheet('Calls')!)).not.toContain('Sentiment');
    expect(headerOf(wb.getWorksheet('Calls')!)).not.toContain('Recorded');
  });
});

describe('a truncated detail sheet', async () => {
  const { dataset: d, details } = agentFixture({ callsCap: 500 });
  const wb = await readWorkbook(await build(d, details));
  it('says so in its first row, with the header on row 2 frozen under it', () => {
    const file = d.detail_files.find((f) => f.sheet === 'calls')!;
    expect(file.truncated).toBe(true);
    const ws = wb.getWorksheet('Calls')!;
    expect(String(ws.getCell('A1').value)).toContain('stops at 500 rows');
    expect(headerOf(ws, 2)).toEqual(file.columns.map((c) => c.label));
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 2 });
    expect(ws.actualRowCount).toBe(500 + 2);
    // Untruncated sheets have no note.
    expect(headerOf(wb.getWorksheet('Sessions')!)[0]).toBe('Campaign');
  });
});

describe('campaign workbook', async () => {
  const { dataset: d, details } = campaignFixture();
  const wb = await readWorkbook(await build(d, details));
  it('has the campaign sheets in order', () => {
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Summary', 'Daily', 'By hour', 'Outcomes', 'Agents', 'Callbacks', 'Health', 'Caller IDs', 'Attempts', 'Sessions', 'Definitions',
    ]);
  });
  it('fills the Summary’s Definition cells from the dataset’s definitions', () => {
    expectDefinitions(wb, d, [
      ['Dials', 'dials'],
      ['Connected', 'connected'],
      ['Connect rate', 'connect_rate'],
      ['Success rate', 'success_rate'],
      ['Abandonment', 'abandonment_rate'],
      ['Callbacks booked', 'callbacks_booked'],
    ]);
  });
  it('writes one Daily row per day and every attempt', () => {
    expect(wb.getWorksheet('Daily')!.actualRowCount).toBe(d.range.days + 1);
    expect(wb.getWorksheet('Attempts')!.actualRowCount).toBe(d.activity.calls.dials + 1);
    const date = wb.getWorksheet('Daily')!.getCell('A2');
    expect(date.value).toEqual(new Date('2026-10-09T00:00:00Z'));
    expect(date.numFmt).toBe('yyyy-mm-dd');
  });
  it('writes an auto-pause’s measured rate with the report’s percentage format', async () => {
    const paused = structuredClone(d);
    paused.health.abandonment.auto_pauses = [{ at: '2026-10-22T06:42:00Z', measured_pct: 3.41666, ceiling_pct: 3 }];
    const health = (await readWorkbook(await build(paused, details))).getWorksheet('Health')!;
    const cells: string[] = [];
    health.eachRow((r) => {
      if (r.getCell(1).value === 'Auto-pause') cells.push(String(r.getCell(2).value));
    });
    expect(cells).toEqual(['Measured 3.4%']);
  });

  it('dates each Daily row by its bucket_start, not by counting from range.from', async () => {
    const late = structuredClone(d);
    late.trends.buckets = late.trends.buckets.slice(2);
    const first = late.trends.buckets[0]!.bucket_start;
    expect(first).not.toBe(late.range.from);
    const daily = (await readWorkbook(await build(late, details))).getWorksheet('Daily')!;
    expect(daily.getCell('A2').value).toEqual(new Date(`${first}T00:00:00Z`));
    expect(daily.getCell('B2').value).toBe(late.trends.buckets[0]!.dials);
  });
});

describe('account workbook', async () => {
  const { dataset: d, details } = accountFixture();
  const wb = await readWorkbook(await build(d, details));
  it('has the account sheets in order, the totals row and the truncated attempts', () => {
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Campaigns', 'Agents', 'Daily', 'Health', 'Attempts', 'Definitions']);
    const campaigns = wb.getWorksheet('Campaigns')!;
    expect(campaigns.actualRowCount).toBe(d.campaigns.length + 2);
    expect(campaigns.getCell(`A${d.campaigns.length + 2}`).value).toBe('All campaigns');
    expect(campaigns.getCell(`D${d.campaigns.length + 2}`).value).toBe(d.totals.calls.dials);
    const attempts = wb.getWorksheet('Attempts')!;
    expect(String(attempts.getCell('A1').value)).toContain('stops at 5,000 rows');
    expect(attempts.actualRowCount).toBe(5000 + 2);
  });
  it('fills the Summary’s Definition cells from the dataset’s definitions', () => {
    expectDefinitions(wb, d, [
      ['Connect rate', 'connect_rate'],
      ['Success rate', 'success_rate'],
      ['Abandonment', 'abandonment_rate'],
      ['Recorded share of connected calls', 'recording_share'],
    ]);
  });
});

describe('detail sheet names', async () => {
  it('every sheet a workbook writes from the dataset itself is a fixed sheet of its kind', async () => {
    const sets: Array<[ReportDataset, Map<string, Buffer>]> = [
      [agentFixture().dataset, agentFixture().details],
      [campaignFixture().dataset, campaignFixture().details],
      [accountFixture().dataset, accountFixture().details],
    ];
    for (const [d, details] of sets) {
      const names = (await readWorkbook(await build(d, details))).worksheets.map((w) => w.name);
      const detail = new Set(detailSheetNames(d).values());
      expect(names.filter((n) => !detail.has(n)).every((n) => (FIXED_SHEETS[d.kind] as readonly string[]).includes(n))).toBe(true);
      // The fixtures' own labels never collide: their sheets keep their labels.
      expect([...detail]).toEqual(d.detail_files.map((f) => f.label));
    }
  });

  it('renames a label that collides with a fixed sheet (any case) or breaks Excel’s rules', async () => {
    const { dataset, details } = agentFixture();
    const d = structuredClone(dataset);
    const label = (sheet: string, l: string) => (d.detail_files.find((f) => f.sheet === sheet)!.label = l);
    label('sessions', 'daily');
    label('state_log', "'State log: every change [in/out]? of the whole window'");
    label('calls', 'Definitions');
    const wb = await readWorkbook(await build(d, details));
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toEqual([
      'Summary', 'Daily', 'daily (2)', 'State log  every change  in out', 'Breaks', 'Definitions (2)', 'Outcomes', 'Callbacks', 'Campaigns', 'Benchmark', 'Definitions',
    ]);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
    for (const n of names) {
      expect(n.length).toBeLessThanOrEqual(31);
      expect(n).not.toMatch(/[[\]:*?/\\]|^'|'$/);
    }
    // Every row still lands in its renamed sheet, and Definitions names the sheets as written.
    const calls = d.detail_files.find((f) => f.sheet === 'calls')!;
    expect(wb.getWorksheet('Definitions (2)')!.actualRowCount).toBe(calls.rows + 1);
    const sheetsNamed = new Set<string>();
    wb.getWorksheet('Definitions')!.eachRow((r, n) => {
      if (n > 1) sheetsNamed.add(String(r.getCell(1).value));
    });
    expect(sheetsNamed).toContain('Definitions (2)');
    expect(sheetsNamed).toContain('daily (2)');
    expect(sheetsNamed).not.toContain('Definitions');
  });

  it('numbers two labels that are the same once cut to 31 characters, within 31', () => {
    const { dataset } = campaignFixture();
    const d = structuredClone(dataset);
    d.detail_files[0]!.label = 'Every attempt placed in the window, in full';
    d.detail_files[1]!.label = 'Every attempt placed in the window, by agent';
    const names = [...detailSheetNames(d).values()];
    expect(names).toEqual(['Every attempt placed in the win', 'Every attempt placed in the (2)']);
    for (const n of names) expect(n.length).toBeLessThanOrEqual(31);
  });
});
