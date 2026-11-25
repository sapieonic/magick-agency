import { fork as forkProcess, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import {
  XlsxLimitError,
  XlsxRefusal,
  type XlsxLimitKind,
  type XlsxLimits,
  type XlsxRefusalKind,
  type XlsxSheetChoice,
} from './agency-xlsx.js';
import type { XlsxWorkerMessage } from './agency-xlsx-worker.js';

/**
 * Runs an Excel upload's conversion (`agency-xlsx.ts`, IM8) in a child process
 * (`agency-xlsx-worker.ts`), so a workbook built to be expensive costs a capped heap, a
 * capped time and one core, never the event loop that paces calls and serves the API:
 *
 *  - **Heap:** the child runs with `--max-old-space-size` = {@link XLSX_WORKER_HEAP_MB}; a
 *    workbook that needs more ends the child ("heap out of memory", SIGABRT), refused
 *    `too_much_memory`. Its `oom_score_adj` is raised to 1000, so if the host runs out the
 *    kernel kills the child rather than the server; a SIGKILL this module did not send is read
 *    the same way. A process and not a worker thread, because a worker's `resourceLimits` do
 *    not hold in this server: the image starts the primary with its own
 *    `--max-old-space-size` (`docker/entrypoint.sh`), and V8 applies that process-wide flag
 *    to every isolate, a worker's included (measured: a worker capped at 32 MB grew past
 *    300 MB under `--max-old-space-size=4096`).
 *  - **Time:** {@link XLSX_WORKER_DEADLINE_MS} for the whole upload. Past it while the child
 *    runs, the child is killed (`too_slow`); past it once the child has finished and only the
 *    upload of its CSV to S3 is left, {@link XlsxStorageTimeoutError}. The deadline aborts the
 *    conversion's `signal`, which the caller hands to the S3 upload.
 *  - **The client and shutdown:** the caller's `signal` (the request closed) and
 *    {@link abortXlsxConversions} (the server is closing) stop it the same way.
 *  - **One at a time:** a second Excel upload while one converts is refused at once
 *    ({@link XlsxBusyError}), so two hostile files cannot hold two cores and two heaps.
 *  - **The CSV** comes back on the child's stdout, a pipe: the child waits whenever the
 *    caller's reader (the S3 upload) has not taken what it wrote, so the CSV is never whole
 *    in memory and a slow upload slows the child rather than queueing chunks.
 *  - **Nothing to leak:** the child gets no environment but `PATH` (no database or S3
 *    credentials), and the workbook only on stdin.
 *
 * Every way it can end frees the slot when the child exits (or never started), whether or not
 * anyone reads the CSV: a failure destroys the CSV and the child's stdout at once, so nothing
 * waits on an unread pipe. A child that dies is a refusal or an error for this upload, never
 * the server's.
 */

/**
 * The child's old-space cap, in MiB. The primary runs with a 4 GB heap
 * (`docker/entrypoint.sh`) and each media worker 768 MB (`MEDIA_WORKER_HEAP_MB`); one
 * conversion at a time adds at most this, and its process. 1 GiB holds a realistic
 * million-row list's shared strings (about 100 characters of unique text a row, as
 * two-byte strings, with their per-string overhead) with room to spare, and stops a
 * hostile workbook far short of the host's memory. The workbook's own bytes are outside
 * the heap (a Buffer), at most the upload's 512 MiB.
 */
export const XLSX_WORKER_HEAP_MB = 1024;

/**
 * How long a conversion may take, both passes and the upload of its CSV to S3 included.
 * A realistic sheet converts at about 20,000 rows a second per pass on one core (a
 * million rows of ten columns: under a minute), and the largest CSV the upload allows
 * (512 MiB) about four minutes; five minutes covers that, and a hostile workbook holds
 * one core for no longer.
 */
export const XLSX_WORKER_DEADLINE_MS = 5 * 60 * 1000;

/** The last bytes of the child's stderr kept, to tell a heap exhaustion from another crash. */
const STDERR_TAIL_BYTES = 16 * 1024;

/** Another Excel upload is being converted: try again shortly (429, `Retry-After`). */
export class XlsxBusyError extends Error {
  constructor() {
    super('Another workbook is being converted.');
    this.name = 'XlsxBusyError';
  }
}

/** The server is closing: the conversion was stopped so shutdown does not wait for it. */
export class XlsxShutdownError extends Error {
  constructor(reason = 'The server is shutting down.') {
    super(reason);
    this.name = 'XlsxShutdownError';
  }
}

/** The workbook was read in time, but storing its CSV was not finished by the deadline. */
export class XlsxStorageTimeoutError extends Error {
  constructor() {
    super('The converted CSV could not be stored before the deadline.');
    this.name = 'XlsxStorageTimeoutError';
  }
}

export interface XlsxConversion {
  sheet: XlsxSheetChoice;
  rows: number;
  columns: number;
  /** The CSV. Ends with the conversion's failure, if it fails; destroying it stops the child. */
  csv: Readable;
  /** Aborted (with the failure as its reason) when the conversion fails: the deadline, shutdown, the child. */
  signal: AbortSignal;
  /** The conversion's own failure, once it has one: what to answer when the upload of `csv` fails. */
  failure(): unknown;
  /** Stop everything this conversion holds (the timer, the child, the CSV): call once the upload is answered. */
  dispose(): void;
}

/** For tests: how a child is started (`fork`). */
export type XlsxFork = (modulePath: string, args: readonly string[], options: Parameters<typeof forkProcess>[2]) => ChildProcess;

export interface XlsxConversionOptions {
  /** Aborts the conversion (the request closed). */
  signal?: AbortSignal;
  deadlineMs?: number;
  heapMb?: number;
  /** For tests: a stand-in for `child_process.fork`. */
  fork?: XlsxFork;
}

/** The running conversion's stop, or null: the one slot. */
let current: ((err: Error) => void) | null = null;

/** For tests: whether the slot is taken. */
export function xlsxConversionRunning(): boolean {
  return current !== null;
}

/**
 * Stop the conversion that is running, if any, with {@link XlsxShutdownError}: the upload
 * route's `preClose` hook calls it, so the request answers at once and closing the server
 * does not wait out a conversion's deadline.
 */
export function abortXlsxConversions(reason?: string): void {
  current?.(new XlsxShutdownError(reason));
}

/**
 * The child's entry: from the build, `dist/xlsx-worker.js` beside the bundle; from source
 * (tsx, vitest), the TypeScript file through tsx. A bundle without its worker is a broken
 * build, said plainly rather than worked around.
 */
export function xlsxWorkerEntry(): { file: string; execArgv: string[] } {
  if (__filename.endsWith('.ts')) {
    return { file: path.join(__dirname, 'agency-xlsx-worker.ts'), execArgv: ['--import', 'tsx'] };
  }
  const built = path.join(__dirname, 'xlsx-worker.js');
  if (!existsSync(built)) {
    throw new Error(`The Excel conversion's worker is missing (${built}): the build did not include dist/xlsx-worker.js.`);
  }
  return { file: built, execArgv: [] };
}

function revive(error: { name: string; kind?: string; columns?: number; message: string }): Error {
  if (error.name === 'XlsxRefusal') return new XlsxRefusal(error.kind as XlsxRefusalKind, error.message);
  if (error.name === 'XlsxLimitError') return new XlsxLimitError(error.kind as XlsxLimitKind, error.columns);
  return Object.assign(new Error(error.message), { name: error.name });
}

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

/**
 * Convert a workbook in a child process. Resolves once the first pass is done (the sheet,
 * rows and columns known, nothing stored yet) with the CSV to stream; rejects with the
 * refusal or limit the first pass met, {@link XlsxBusyError} while another conversion runs,
 * or the deadline, the heap cap, shutdown or the signal. The slot is free again once the
 * child has exited; the caller calls `dispose()` when it has answered.
 */
export function convertXlsxInWorker(
  buf: Buffer,
  limits: XlsxLimits,
  options: XlsxConversionOptions = {},
): Promise<XlsxConversion> {
  if (current !== null) return Promise.reject(new XlsxBusyError());
  if (options.signal?.aborted) return Promise.reject(asError(options.signal.reason));

  let entry: { file: string; execArgv: string[] };
  try {
    entry = xlsxWorkerEntry();
  } catch (err) {
    return Promise.reject(err);
  }

  const heapMb = options.heapMb ?? XLSX_WORKER_HEAP_MB;
  const start = options.fork ?? (forkProcess as XlsxFork);
  let child: ChildProcess;
  try {
    child = start(entry.file, [JSON.stringify(limits), String(buf.length)], {
      execArgv: [...entry.execArgv, `--max-old-space-size=${heapMb}`],
      // Nothing of the server's environment (credentials, NODE_OPTIONS' heap flag): PATH only.
      env: { PATH: process.env['PATH'] ?? '' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
    });
  } catch (err) {
    return Promise.reject(err);
  }

  return new Promise<XlsxConversion>((resolve, reject) => {
    const aborter = new AbortController();
    const csv = new PassThrough();
    let failure: unknown = null;
    let opened = false;
    let ended = false;
    let exited = false;
    let killedByUs = false;
    let settled = false;
    let stderr = '';
    let deadline: NodeJS.Timeout | null = null;

    const kill = () => {
      // No pid: the fork never started (EMFILE). Its handle would then signal pid 0, the
      // server's whole process group, so there is nothing to kill and it is not tried.
      if (child.pid === undefined || exited || child.exitCode !== null || child.signalCode !== null) return;
      killedByUs = true;
      try {
        child.kill('SIGKILL');
      } catch { /* already gone */ }
    };
    const release = () => {
      if (current === stop) current = null;
    };
    const cleanup = () => {
      if (deadline) clearTimeout(deadline);
      deadline = null;
      options.signal?.removeEventListener('abort', onAbort);
    };
    /** Tell the caller once: a rejection before `opened`, the CSV's error after it. */
    const settle = () => {
      if (settled || failure === null) return;
      settled = true;
      cleanup();
      const err = asError(failure);
      if (!aborter.signal.aborted) aborter.abort(err);
      if (!opened) reject(err);
      else if (!csv.destroyed) csv.destroy(err);
      child.stdout?.destroy();
    };
    // A failure kills the child and, once the caller has the CSV, ends it and the child's
    // stdout at once, so nothing waits on a pipe nobody reads. Before `opened` the caller
    // hears of it when the child has exited (its slot free by then).
    const fail = (err: unknown) => {
      if (failure !== null) return;
      failure = err;
      kill();
      if (opened) settle();
    };
    const stop = (err: Error) => fail(err);
    const onAbort = () => fail(asError(options.signal?.reason ?? new Error('The upload was abandoned.')));

    current = stop;

    // Settling first: a fork that could not start (EMFILE) emits `error` and then `close`.
    child.on('error', (err) => {
      fail(err);
      if (child.pid === undefined) onGone(null, null);
    });
    // The child has exited (or never started): the slot is free. A clean finish keeps the
    // deadline running, since the S3 upload of the CSV may still be under way.
    const onGone = (code: number | null, signal: NodeJS.Signals | null) => {
      if (exited) return;
      exited = true;
      release();
      if (failure === null && !(ended && code === 0)) {
        failure = /heap out of memory|Reached heap limit/i.test(stderr) || signal === 'SIGABRT'
          || (signal === 'SIGKILL' && !killedByUs)
          ? new XlsxLimitError('too_much_memory')
          : new Error(`The workbook reader stopped before it finished (${signal ?? `exit code ${code}`}): ${stderr.slice(-500)}`);
      }
      settle();
    };
    child.on('exit', onGone);
    child.on('close', (code, signal) => {
      onGone(code, signal);
      if (failure === null) csv.end();
    });

    const { stdin, stdout, stderr: errStream } = child;
    if (!stdin || !stdout || !errStream) {
      fail(new Error('The workbook reader could not be started (no pipes: too many open files?).'));
      return;
    }

    // Best effort: if the host runs out of memory, the kernel's OOM killer takes the child.
    if (child.pid !== undefined) writeFile(`/proc/${child.pid}/oom_score_adj`, '1000').catch(() => {});

    deadline = setTimeout(() => {
      // The child finished and only the S3 upload is left: that is storage being slow.
      fail(ended && exited ? new XlsxStorageTimeoutError() : new XlsxLimitError('too_slow'));
    }, options.deadlineMs ?? XLSX_WORKER_DEADLINE_MS);
    deadline.unref();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    csv.on('close', () => {
      // The reader stopped early (the S3 upload failed or was abandoned): stop the child.
      if (failure === null && !csv.readableEnded) fail(new Error('The CSV stream was closed before the workbook was read.'));
      else child.stdout?.destroy();
    });
    // Whoever reads the CSV hears its error; this keeps one with no reader yet from being unhandled.
    csv.on('error', () => {});
    stdout.pipe(csv, { end: false });
    errStream.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });
    // The child may die before it has read all of its input: that is its failure, reported on exit.
    stdin.on('error', () => {});
    stdin.end(buf);

    child.on('message', (message: XlsxWorkerMessage) => {
      if (failure !== null) return;
      switch (message.t) {
        case 'opened':
          opened = true;
          resolve({
            sheet: message.sheet,
            rows: message.rows,
            columns: message.columns,
            csv,
            signal: aborter.signal,
            failure: () => failure,
            dispose() {
              cleanup();
              if (!exited) fail(new Error('The conversion was disposed of before it finished.'));
              if (!csv.destroyed && !csv.readableEnded) csv.destroy();
              child.stdout?.destroy();
            },
          });
          break;
        case 'end':
          ended = true;
          break;
        case 'error':
          fail(revive(message.error));
          break;
      }
    });
  });
}
