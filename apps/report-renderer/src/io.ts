/**
 * What the renderer needs from storage, and the detail-file reader built on it. The Lambda
 * implements {@link RendererIO} over S3 (`src/lambda/s3-io.ts`); the server's inline adapter
 * implements it over its own S3 module; tests use memory.
 */
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import type { ReportDetailFile } from '@magick-agency/contracts/reports';
import { RenderFailure, errorMessage } from './errors';

export interface RendererIO {
  /** The whole object (used for `dataset.json`). Rejects when it is missing or unreadable. */
  readObject(key: string): Promise<Buffer>;
  /** The object as a stream (used for the gzipped detail files, read once, front to back). */
  readStream(key: string): Promise<Readable>;
  /**
   * Store `body` at `key` (same bucket as the dataset). A `Readable` body is a file the renderer
   * wrote to local disk; `bytes` is its size, known before the write.
   */
  writeObject(key: string, body: Buffer | Readable, contentType: string, bytes: number): Promise<{ bytes: number }>;
}

/** The rows of one detail file, in file order: one array of cell values per line. */
export type DetailReader = (file: ReportDetailFile) => AsyncIterable<unknown[]>;

/** A {@link DetailReader} over gzipped NDJSON objects read through `io.readStream`. */
export function detailReaderFromIO(io: Pick<RendererIO, 'readStream'>): DetailReader {
  return (file) => ndjsonGzRows(() => io.readStream(file.key), file.key);
}

/**
 * Gunzip and parse a detail file line by line, never holding more than one line. Every failure
 * (missing object, bad gzip, a line that is not a JSON array) is `dataset_unreadable`.
 */
export async function* ndjsonGzRows(open: () => Promise<Readable>, label: string): AsyncGenerator<unknown[]> {
  let source: Readable;
  try {
    source = await open();
  } catch (error) {
    throw new RenderFailure('dataset_unreadable', `detail file ${label} could not be opened: ${errorMessage(error)}`, { cause: error });
  }
  const gunzip = createGunzip();
  let streamError: unknown = null;
  source.on('error', (e) => {
    streamError = e;
    gunzip.destroy(e);
  });
  const lines = createInterface({ input: source.pipe(gunzip), crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of lines) {
      n += 1;
      if (line === '') continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch (error) {
        throw new RenderFailure('dataset_unreadable', `detail file ${label} line ${n} is not JSON`, { cause: error });
      }
      if (!Array.isArray(row)) throw new RenderFailure('dataset_unreadable', `detail file ${label} line ${n} is not an array`);
      yield row;
    }
  } catch (error) {
    if (error instanceof RenderFailure) throw error;
    throw new RenderFailure('dataset_unreadable', `detail file ${label} could not be read: ${errorMessage(streamError ?? error)}`, { cause: error });
  } finally {
    lines.close();
    source.destroy();
  }
}
