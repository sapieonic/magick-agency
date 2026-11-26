import { fork as forkProcess, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import type { XlsxLimits, XlsxSheetChoice } from './agency-xlsx.js';
import { XlsxLimitError, XlsxRefusal, type XlsxLimitKind, type XlsxRefusalKind } from './agency-xlsx-refusals.js';
import type { XlsxWorkerMessage } from './agency-xlsx-worker.js';

/**
 * Runs an Excel upload's conversion (`agency-xlsx.ts`, IM8) in a child process
 * (`agency-xlsx-worker.ts`), so a workbook built to be expensive costs a capped heap, a
 * capped time and one core, never the event loop that paces calls and serves the API:
 *
 *  - **Heap:** the child runs with `--max-old-space-size` = {@link XLSX_CHILD_HEAP_MB}; a
 *    workbook that needs more ends the child ("heap out of memory", SIGABRT), refused
 *    `too_much_memory`. Its `oom_score_adj` is raised to 1000, so if the host runs out the
 *    kernel kills the child rather than the server; a SIGKILL this module did not send is read
 *    the same way. A process and not a worker thread, because a worker's `resourceLimits` do
 *    not hold in this server: the image starts the primary with its own
 *    `--max-old-space-size` (`docker/entrypoint.sh`), and V8 applies that process-wide flag
 *    to every isolate, a worker's included (measured: a worker capped at 32 MB grew past
 *    300 MB under `--max-old-space-size=4096`).
 *  - **Time:** {@link XLSX_CHILD_DEADLINE_MS} for the whole upload. Past it while the child
 *    runs, the child is killed (`too_slow`); past it once the child has finished and only the
 *    upload of its CSV to S3 is left, {@link XlsxStorageTimeoutError}. The deadline aborts the
 *    conversion's `signal`, which the caller hands to the S3 upload.
 *  - **The client and shutdown:** the caller's `signal` (the request closed) and
 *    {@link abortXlsxConversions} (the server is closing) stop it the same way. Shutdown
 *    reaches every conversion that is live, from the fork until the caller's `dispose()`
 *    (the S3 upload of a CSV whose child has already exited included), and refuses any
 *    conversion asked for after it (an upload whose body was still arriving when the server
 *    began to close).
 *  - **One at a time:** a second Excel upload while one converts is refused at once
 *    ({@link XlsxBusyError}), so two hostile files cannot hold two cores and two heaps. The
 *    slot is the child's: it is free again when the child exits.
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
const XLSX_CHILD_HEAP_MB = 1024;

/**
 * How long a conversion may take, both passes and the upload of its CSV to S3 included.
 * A realistic sheet converts at about 20,000 rows a second per pass on one core (a
 * million rows of ten columns: under a minute), and the largest CSV the upload allows
 * (512 MiB) about four minutes; five minutes covers that, and a hostile workbook holds
 * one core for no longer.
 */
const XLSX_CHILD_DEADLINE_MS = 5 * 60 * 1000;

/**
 * How long a child's IPC channel may stay open once the child has exited and its stdio has
 * closed, before how it ended is decided without the messages still owed (none should be:
 * the channel's other end died with the child).
 */
const CHANNEL_GRACE_MS = 2_000;

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

/** The running child's stop, or null: the one slot, free again when the child exits. */
let current: ((err: Error) => void) | null = null;

/**
 * Every conversion that is live, by its stop: from the fork until the caller's `dispose()`
 * (or its rejection), so shutdown reaches one whose child has exited while the S3 upload of
 * its CSV is still under way. Separate from the slot, which the child's exit frees.
 */
const live = new Set<(err: Error) => void>();

/** Set by {@link abortXlsxConversions}: the server is closing and starts no conversion. */
let closing = false;

/**
 * Whether the slot is taken (a child is converting). The upload route refuses a second
 * workbook on it before reading its body; tests wait on it.
 */
export function xlsxConversionRunning(): boolean {
  return current !== null;
}

/**
 * The server is closing: stop every live conversion with {@link XlsxShutdownError} and
 * refuse any asked for from now on. The upload route's `preClose` hook calls it, so each
 * request answers at once and closing the server does not wait out a conversion's deadline,
 * whether its child is converting, its CSV is still being stored, or its body was still
 * arriving when the server began to close.
 */
export function abortXlsxConversions(reason?: string): void {
  closing = true;
  for (const stop of [...live]) stop(new XlsxShutdownError(reason));
}

/** For tests: start conversions again after {@link abortXlsxConversions} (one process closes several apps). */
export function reopenXlsxConversionsForTests(): void {
  closing = false;
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
    throw new Error(`The Excel conversion child's bundle is missing (${built}): the build did not include dist/xlsx-worker.js.`);
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
 * refusal or limit the first pass met, {@link XlsxShutdownError} once the server is closing,
 * {@link XlsxBusyError} while another conversion runs, or the deadline, the heap cap,
 * shutdown or the signal. The slot is free again once the child has exited; the caller calls
 * `dispose()` when it has answered.
 */
export function convertXlsxInChild(
  buf: Buffer,
  limits: XlsxLimits,
  options: XlsxConversionOptions = {},
): Promise<XlsxConversion> {
  if (closing) return Promise.reject(new XlsxShutdownError());
  if (current !== null) return Promise.reject(new XlsxBusyError());
  if (options.signal?.aborted) return Promise.reject(asError(options.signal.reason));

  let entry: { file: string; execArgv: string[] };
  try {
    entry = xlsxWorkerEntry();
  } catch (err) {
    return Promise.reject(err);
  }

  const heapMb = options.heapMb ?? XLSX_CHILD_HEAP_MB;
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
      if (!opened) {
        // The caller never had it, so there is nothing to dispose of: no longer live.
        live.delete(stop);
        reject(err);
      } else if (!csv.destroyed) csv.destroy(err);
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
    live.add(stop);

    // How the child ended is decided once nothing more can arrive from it: it has exited, its
    // stdio has closed (`close`) and its IPC channel has disconnected. Node does not deliver a
    // child's last IPC message (`end`, `error`) before its `exit` event, so an exit alone,
    // even an exit 0 after the CSV, is not yet a crash. The slot is freed at `exit` all the same.
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let stdioClosed = false;
    let decided = false;
    let channelGrace: NodeJS.Timeout | null = null;
    const decide = (force = false) => {
      if (decided || !exited || !stdioClosed) return;
      if (!force && child.connected === true) {
        // Its last messages are still on the way: `disconnect` decides. A channel that stays
        // open past its process (nothing should hold it) is not waited on for long.
        channelGrace ??= setTimeout(() => decide(true), CHANNEL_GRACE_MS);
        channelGrace.unref();
        return;
      }
      decided = true;
      if (channelGrace) clearTimeout(channelGrace);
      if (failure === null && !(ended && exitCode === 0)) {
        failure = /heap out of memory|Reached heap limit/i.test(stderr) || exitSignal === 'SIGABRT'
          || (exitSignal === 'SIGKILL' && !killedByUs)
          ? new XlsxLimitError('too_much_memory')
          : new Error(`The workbook reader stopped before it finished (${exitSignal ?? `exit code ${exitCode}`}): ${stderr.slice(-500)}`);
      }
      settle();
      if (failure === null) csv.end();
    };
    // The child has exited (or never started): the slot is free. A clean finish keeps the
    // deadline running, since the S3 upload of the CSV may still be under way.
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (exited) return;
      exited = true;
      exitCode = code;
      exitSignal = signal;
      release();
      decide();
    };
    // A fork that could not start (EMFILE) emits `error` and then `close`, and has no channel.
    child.on('error', (err) => {
      fail(err);
      if (child.pid === undefined) {
        stdioClosed = true;
        onExit(null, null);
      }
    });
    child.on('exit', onExit);
    child.on('close', (code, signal) => {
      onExit(code, signal);
      stdioClosed = true;
      decide();
    });
    child.on('disconnect', () => decide());

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
    }, options.deadlineMs ?? XLSX_CHILD_DEADLINE_MS);
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
              live.delete(stop);
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
