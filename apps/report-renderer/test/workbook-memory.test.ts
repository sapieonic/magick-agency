/**
 * RP12's 100,000-row detail sheet through the streaming writer: rows are generated on demand and
 * the output goes to a byte-counting sink, so the heap stays flat (a non-streaming workbook
 * would hold every row and its cells, several hundred MB for this sheet).
 */
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ReportDetailFile } from '@magick-agency/contracts/reports';
import { writeWorkbook } from '../src/xlsx/workbook';
import { agentFixture } from './fixtures/agent';

const ROWS = 100_000;

describe('a 100,000-row detail sheet', () => {
  it('streams with a flat heap', async () => {
    const { dataset: base } = agentFixture();
    const d = structuredClone(base);
    const calls = d.detail_files.find((f) => f.sheet === 'calls')!;
    calls.rows = ROWS;
    calls.truncated = true;
    let peak = 0;
    const start = process.memoryUsage().heapUsed;
    async function* rows(file: ReportDetailFile): AsyncGenerator<unknown[]> {
      if (file.sheet !== 'calls') return;
      const t0 = Date.parse(d.range.start);
      for (let i = 0; i < ROWS; i++) {
        if (i % 5_000 === 0) peak = Math.max(peak, process.memoryUsage().heapUsed - start);
        yield [new Date(t0 + i * 25_000).toISOString(), 'Spring Recovery', `+91 98${String(10_000_000 + i).slice(0, 8)}`, 'connected', 'Promise to pay', 120 + (i % 200), 30, 0, null, true, i % 3 ? 'neutral' : 'positive'];
      }
    }
    let bytes = 0;
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        cb();
      },
    });
    const done = new Promise((r) => sink.on('finish', r));
    await writeWorkbook(d, rows, sink);
    await done;
    expect(bytes).toBeGreaterThan(1_000_000);
    expect(peak).toBeLessThan(150 * 1024 * 1024);
  }, 120_000);
});
