/**
 * The workbook, read back with exceljs: sheet names and order per kind, header rows, typed cells
 * and number formats, detail sheets' row counts, and the truncation note.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ReportDataset } from '@magick-agency/contracts/reports';
import { detailReaderFromIO } from '../src/io';
import { writeWorkbook } from '../src/xlsx/workbook';
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
  it('writes one Daily row per day and every attempt', () => {
    expect(wb.getWorksheet('Daily')!.actualRowCount).toBe(d.range.days + 1);
    expect(wb.getWorksheet('Attempts')!.actualRowCount).toBe(d.activity.calls.dials + 1);
    const date = wb.getWorksheet('Daily')!.getCell('A2');
    expect(date.value).toEqual(new Date('2026-10-09T00:00:00Z'));
    expect(date.numFmt).toBe('yyyy-mm-dd');
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
});
