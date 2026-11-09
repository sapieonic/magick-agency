import { Readable } from 'node:stream';
import type { ReportDataset } from '@magick-agency/contracts/reports';
import type { RendererIO } from '../../src/io';

/** An in-memory bucket implementing RendererIO, recording writes. */
export class MemoryIO implements RendererIO {
  readonly objects = new Map<string, Buffer>();
  readonly writes: Array<{ key: string; contentType: string; bytes: number }> = [];
  failWrites = false;

  constructor(dataset?: ReportDataset, datasetKey = 'report-datasets/t/a/run/dataset.json', details?: Map<string, Buffer>) {
    if (dataset) this.objects.set(datasetKey, Buffer.from(JSON.stringify(dataset)));
    for (const [k, v] of details ?? []) this.objects.set(k, v);
  }

  async readObject(key: string): Promise<Buffer> {
    const b = this.objects.get(key);
    if (!b) throw new Error(`NoSuchKey: ${key}`);
    return b;
  }

  async readStream(key: string): Promise<Readable> {
    return Readable.from([await this.readObject(key)]);
  }

  async writeObject(key: string, body: Buffer | Readable, contentType: string, bytes: number): Promise<{ bytes: number }> {
    if (this.failWrites) throw new Error('AccessDenied: simulated');
    const chunks: Buffer[] = [];
    if (Buffer.isBuffer(body)) chunks.push(body);
    else for await (const c of body) chunks.push(Buffer.from(c as Buffer));
    const buf = Buffer.concat(chunks);
    if (buf.length !== bytes) throw new Error(`declared ${bytes} bytes, got ${buf.length}`);
    this.objects.set(key, buf);
    this.writes.push({ key, contentType, bytes: buf.length });
    return { bytes: buf.length };
  }
}

export const DATASET_KEY = 'report-datasets/t/a/run/dataset.json';
