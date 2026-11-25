/**
 * The process an Excel upload is converted in (IM8): `agency-xlsx-runner.ts` forks it with
 * its own heap cap, the limits (JSON) and the workbook's size as its arguments and the
 * workbook's bytes on stdin. It opens
 * the workbook (`openXlsxWorkbook`: the first pass), says what it found over IPC, then
 * writes the CSV to stdout, waiting on the pipe (the runner reads only as fast as S3 takes
 * it), so the CSV is never whole in either process.
 *
 * IPC to the runner: `opened` (the sheet, rows, columns), `end`, `error` (a refusal or limit
 * as `{ name, kind, columns, message }`).
 *
 * Its own entry in the production build (`scripts/build.mjs`: `dist/xlsx-worker.js`); under
 * tsx and vitest the runner forks this file with `--import tsx`. Imports nothing that starts
 * the server (no logger, no config, no secrets in its environment): only the converter.
 */
import { once } from 'node:events';
import { openXlsxWorkbook, XlsxLimitError, XlsxRefusal, type XlsxLimits } from './agency-xlsx.js';

export type XlsxWorkerMessage =
  | { t: 'opened'; sheet: { name: string; other_sheet_names: string[] }; rows: number; columns: number }
  | { t: 'end' }
  | { t: 'error'; error: { name: string; kind?: string; columns?: number; message: string } };

function send(message: XlsxWorkerMessage): Promise<void> {
  return new Promise((resolve) => {
    if (!process.send) {
      resolve();
      return;
    }
    process.send(message, undefined, {}, () => resolve());
  });
}

/** The workbook from stdin, into one buffer of the size the runner announced (no second copy). */
async function readStdin(size: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(size);
  let at = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    if (at + chunk.length > size) throw new Error('The workbook is longer than announced.');
    chunk.copy(bytes, at);
    at += chunk.length;
  }
  if (at !== size) throw new Error('The workbook is shorter than announced.');
  return bytes;
}

/** Set once this process disconnects itself at the end, so that disconnect is not taken for the server's going. */
let finishing = false;

async function main(): Promise<void> {
  if (!process.send) throw new Error('agency-xlsx-worker runs as a child of the server (IPC)');
  // The server went away (outside Docker nothing else would stop this process): stop too.
  process.on('disconnect', () => {
    if (!finishing) process.exit(1);
  });
  const limits = JSON.parse(process.argv[2] ?? '{}') as XlsxLimits;
  const bytes = await readStdin(Number(process.argv[3]));
  try {
    const workbook = await openXlsxWorkbook(bytes, limits);
    await send({ t: 'opened', sheet: workbook.sheet, rows: workbook.rows, columns: workbook.columns });
    for await (const chunk of workbook.toCsv() as AsyncIterable<Buffer>) {
      if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');
    }
    await send({ t: 'end' });
  } catch (err) {
    const e = err as Error & { kind?: string; columns?: number };
    await send({
      t: 'error',
      error: {
        name: err instanceof XlsxRefusal ? 'XlsxRefusal' : err instanceof XlsxLimitError ? 'XlsxLimitError' : e?.name ?? 'Error',
        ...(e?.kind !== undefined ? { kind: e.kind } : {}),
        ...(e?.columns !== undefined ? { columns: e.columns } : {}),
        message: String(e?.message ?? err),
      },
    });
    process.exitCode = 1;
  }
  finishing = true;
  process.disconnect();
}

void main();
