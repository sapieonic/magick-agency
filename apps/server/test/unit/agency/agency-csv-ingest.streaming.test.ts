import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { ingestAgencyCsv } from '../../../src/agency/agency-csv-ingest.js';

/**
 * C20 — proving the ingest actually streams.
 *
 * A row-count assertion does not prove it: the synchronous parser would also
 * produce the right count given enough heap. The test plan asks for three
 * assertions together, and each one independently falsifies "it buffers".
 *
 * The source is generated lazily rather than read from a fixture file on disk,
 * which makes the test both faster and stronger — a `Readable` that mints rows
 * on demand cannot itself be holding the file, so every byte counted below was
 * genuinely pulled by the parser.
 */

const ROWS = 250_000;

/** Bytes actually pulled from the source so far. */
interface CountingSource {
  stream: Readable;
  bytesEmitted: () => number;
  totalBytes: number;
}

function makeCsvSource(rows: number): CountingSource {
  const header =
    'Mobile,First Name,Last Name,Email,City,Branch,Policy #,Amount Due,Due Date,Agent,Status,Last Contact\n';
  // Fixed-width rows, ~160 bytes each, so 250k rows lands at the ~40MB the test
  // plan specifies and the total is known up front without generating twice.
  const rowFor = (i: number): string => {
    const id = String(i).padStart(7, '0');
    const phone = `+9198${String(76000000 + i).padStart(8, '0')}`;
    return (
      `${phone},Customer${id},Surname${id},customer${id}@example.com,Mumbai,` +
      `Andheri West Branch,POL-${id},12345.67,2026-09-01,Agent ${id},active,2026-08-01T09:30:00Z\n`
    );
  };

  let emitted = 0;
  let index = 0;

  const stream = new Readable({
    read() {
      if (index >= rows) {
        this.push(null);
        return;
      }
      // Emit in modest slabs so back-pressure has somewhere to bite.
      let slab = '';
      const end = Math.min(index + 200, rows);
      for (; index < end; index += 1) slab += rowFor(index);
      emitted += Buffer.byteLength(slab, 'utf8');
      this.push(slab);
    },
  });

  stream.push(header);
  emitted += Buffer.byteLength(header, 'utf8');

  const totalBytes = Buffer.byteLength(header, 'utf8') + rows * Buffer.byteLength(rowFor(0), 'utf8');

  return { stream, bytesEmitted: () => emitted, totalBytes };
}

describe('C20 — streaming proof', () => {
  it(
    'holds memory well under the file size, emits row 1 early, and honours back-pressure',
    async () => {
      const source = makeCsvSource(ROWS);
      // ~40MB, matching the fixture size the test plan specifies.
      expect(source.totalBytes).toBeGreaterThan(30 * 1024 * 1024);

      const heapBefore = process.memoryUsage().heapUsed;
      let heapPeak = heapBefore;
      let bytesAtFirstCallback = -1;
      let sawPaused = false;
      let rowsSeen = 0;
      let firstPhone = '';
      let lastPhone = '';

      await ingestAgencyCsv({
        source: source.stream,
        phoneColumn: 'Mobile',
        batchSize: 500,
        onBatch: async (batch) => {
          if (bytesAtFirstCallback === -1) {
            // ── Assertion 2: first-row latency ────────────────────────────
            // The direct falsifier for "buffers whole files": a buffering
            // parser cannot emit row 1 until it has read byte N.
            bytesAtFirstCallback = source.bytesEmitted();
            firstPhone = batch[0]!.phone_e164;
          }
          rowsSeen += batch.length;
          lastPhone = batch[batch.length - 1]!.phone_e164;

          const heap = process.memoryUsage().heapUsed;
          if (heap > heapPeak) heapPeak = heap;

          // ── Assertion 3: back-pressure ──────────────────────────────────
          // Awaiting here must pause the source. An implementation that reads
          // the whole stream and then iterates never pauses.
          if (rowsSeen <= 50_000) {
            await new Promise((resolve) => setTimeout(resolve, 1));
            if (source.stream.readableFlowing === false) sawPaused = true;
          }
        },
      });

      expect(rowsSeen).toBe(ROWS);
      expect(firstPhone).toBe('+919876000000');
      expect(lastPhone).toBe('+919876249999');

      // ── Assertion 1: memory ceiling ─────────────────────────────────────
      // A buffering implementation holds the file plus the parsed record array
      // — comfortably over this. What legitimately grows here is the dedupe
      // set (250k short strings), which is O(distinct phones), not O(file).
      const heapGrowth = heapPeak - heapBefore;
      expect(heapGrowth).toBeLessThan(150 * 1024 * 1024);

      // First rows arrive after a tiny fraction of the file.
      expect(bytesAtFirstCallback).toBeGreaterThan(0);
      expect(bytesAtFirstCallback).toBeLessThan(source.totalBytes * 0.05);

      expect(sawPaused).toBe(true);
    },
    120_000,
  );

  it('stops pulling from the source as soon as the file is known to be unusable', async () => {
    // A 1M-row file that names a column we cannot map should not cost a full
    // download before it fails.
    const source = makeCsvSource(ROWS);
    await expect(
      ingestAgencyCsv({ source: source.stream, phoneColumn: 'NotAColumn' }),
    ).rejects.toMatchObject({ code: 'phone_column_missing' });

    // Only the leading slab was ever pulled.
    expect(source.bytesEmitted()).toBeLessThan(source.totalBytes * 0.05);
    expect(source.stream.destroyed).toBe(true);
  });
});
