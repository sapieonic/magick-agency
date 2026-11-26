import { describe, it, expect, afterEach } from 'vitest';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  abortXlsxConversions,
  convertXlsxInChild,
  reopenXlsxConversionsForTests,
  xlsxConversionRunning,
  XlsxBusyError,
  XlsxShutdownError,
  XlsxStorageTimeoutError,
  type XlsxConversion,
  type XlsxFork,
} from '../../../src/agency/agency-xlsx-runner.js';
import { openXlsxWorkbook, type XlsxLimits } from '../../../src/agency/agency-xlsx.js';
import { XlsxLimitError, XlsxRefusal } from '../../../src/agency/agency-xlsx-refusals.js';
import { handWorkbook, zipParts } from '../../helpers/xlsx-fixtures.js';

/*
 * The Excel upload's containment (IM8, `agency-xlsx-runner.ts`): the conversion runs in a
 * child process with its own heap cap and a deadline, one at a time, the client's going away
 * stops it, the CSV comes back through a pipe the child waits on, and a child that dies is
 * this upload's refusal, never the server's. The child here is the real one, forked from
 * source with tsx (`agency-xlsx-worker-build.test.ts` runs the built one).
 *
 * This suite's own process runs with whatever `--max-old-space-size` NODE_OPTIONS carries;
 * the heap case shows the child's cap holds regardless (a worker thread's did not).
 */

const LIMITS: XlsxLimits = { maxDataRows: 1_000_000, maxColumns: 100, maxCsvBytes: 512 * 1024 * 1024 };

/** `rows` rows of a phone number and a 40-character name: about 50 bytes of CSV each. */
function rowsWorkbook(rows: number): Buffer {
  const name = 'n'.repeat(40);
  const xml = Array.from({ length: rows }, (_, i) =>
    `<row r="${i + 1}"><c r="A${i + 1}"><v>${9_000_000_000 + i}</v></c><c r="B${i + 1}" t="inlineStr"><is><t>${name}</t></is></c></row>`).join('');
  return handWorkbook({ sheets: [{ name: 'S', xml: `<sheetData>${xml}</sheetData>` }] });
}

async function readAll(conversion: XlsxConversion): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of conversion.csv as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

/** Resolves once `signal` aborts; throws if it has not within `ms`. */
function aborted(signal: AbortSignal, ms: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the signal never aborted')), ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function slotFree(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (xlsxConversionRunning()) {
    if (Date.now() > deadline) throw new Error('the conversion slot was never released');
    await new Promise((r) => setTimeout(r, 10));
  }
}

afterEach(async () => {
  // Shutdown is for good in production; each case here starts with the runner open.
  abortXlsxConversions('the case is over');
  await slotFree();
  reopenXlsxConversionsForTests();
});

describe('convertXlsxInChild', () => {
  it('converts in a child process exactly as in-process, and frees its slot', async () => {
    const buf = rowsWorkbook(20_000);
    const inProcess = await openXlsxWorkbook(Buffer.from(buf), LIMITS);
    let expected = '';
    for await (const chunk of inProcess.toCsv()) expected += chunk.toString('utf8');

    const conversion = await convertXlsxInChild(Buffer.from(buf), LIMITS);
    expect(conversion).toMatchObject({ sheet: { name: 'S', other_sheet_names: [] }, rows: 20_000, columns: 2 });
    expect(await readAll(conversion)).toBe(expected);
    expect(conversion.failure()).toBeNull();
    await slotFree();
  });

  it('holds little unread: the child waits on the pipe while nobody reads', async () => {
    const conversion = await convertXlsxInChild(rowsWorkbook(40_000), LIMITS);
    // Nobody reads for a while: the child has filled the pipe and waits.
    await new Promise((r) => setTimeout(r, 500));
    expect(conversion.csv.readableLength).toBeGreaterThan(0);
    expect(conversion.csv.readableLength).toBeLessThanOrEqual(600 * 1024);
    const csv = await readAll(conversion);
    expect(csv.split('\n')).toHaveLength(40_001);
  });

  it('runs one conversion at a time: a second is refused while the first runs, and taken once it ends', async () => {
    const first = await convertXlsxInChild(rowsWorkbook(40_000), LIMITS);
    expect(await rejection(convertXlsxInChild(rowsWorkbook(10), LIMITS))).toBeInstanceOf(XlsxBusyError);
    first.csv.destroy();
    await slotFree();
    expect(first.failure()).not.toBeNull();
    const third = await convertXlsxInChild(rowsWorkbook(10), LIMITS);
    expect((await readAll(third)).split('\n')).toHaveLength(11);
  });

  it('passes a refusal or a limit through with its kind', async () => {
    const unreadable = await rejection(convertXlsxInChild(zipParts([['word/document.xml', '<w/>']]), LIMITS));
    expect(unreadable).toBeInstanceOf(XlsxRefusal);
    expect(unreadable).toMatchObject({ kind: 'unreadable' });
    const wide = await rejection(convertXlsxInChild(rowsWorkbook(10), { ...LIMITS, maxColumns: 1 }));
    expect(wide).toBeInstanceOf(XlsxLimitError);
    expect(wide).toMatchObject({ kind: 'too_many_columns', columns: 2 });
  });

  it('ends the CSV with a limit met after the first pass, and says so through failure()', async () => {
    const conversion = await convertXlsxInChild(rowsWorkbook(20_000), { ...LIMITS, maxCsvBytes: 100_000, maxSheetXmlBytes: 100_000_000 });
    const err = await rejection(readAll(conversion));
    expect(err).toMatchObject({ kind: 'too_large' });
    expect(conversion.failure()).toMatchObject({ kind: 'too_large' });
  });

  it('terminates a conversion past its deadline: too_slow', async () => {
    const err = await rejection(convertXlsxInChild(rowsWorkbook(200_000), LIMITS, { deadlineMs: 100 }));
    expect(err).toBeInstanceOf(XlsxLimitError);
    expect(err).toMatchObject({ kind: 'too_slow' });
  });

  it('ends a conversion whose heap passes the cap: too_much_memory, and the server carries on', async () => {
    const strings = Array.from({ length: 200_000 }, (_, i) => `customer ${i} ${'x'.repeat(400)}`);
    const xml = `<sheetData>${Array.from({ length: 1_000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="s"><v>${i}</v></c></row>`).join('')}</sheetData>`;
    const buf = handWorkbook({ sharedStrings: strings, sheets: [{ name: 'S', xml }] });
    const err = await rejection(convertXlsxInChild(buf, LIMITS, { heapMb: 32 }));
    expect(err).toBeInstanceOf(XlsxLimitError);
    expect(err).toMatchObject({ kind: 'too_much_memory' });
    // The slot is free and the next workbook converts.
    await slotFree();
    const conversion = await convertXlsxInChild(rowsWorkbook(10), LIMITS);
    expect((await readAll(conversion)).split('\n')).toHaveLength(11);
  }, 30_000);

  it('stops when the caller aborts (the client went away)', async () => {
    const controller = new AbortController();
    const pending = convertXlsxInChild(rowsWorkbook(200_000), LIMITS, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('client gone')), 50);
    const err = await rejection(pending);
    expect((err as Error).message).toBe('client gone');
  });

  it('keeps the event loop free while it converts', async () => {
    const buf = rowsWorkbook(150_000);
    let last = performance.now();
    let worst = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last - 10);
      last = now;
    }, 10);
    try {
      const conversion = await convertXlsxInChild(buf, LIMITS);
      await readAll(conversion);
    } finally {
      clearInterval(timer);
    }
    // In-process, this workbook held the loop for seconds at a time; a loaded CI runner can
    // still delay a 10 ms timer by a few hundred.
    expect(worst).toBeLessThan(1_000);
  });

  it('a CSV nobody reads: the deadline ends it, destroys the CSV and frees the slot (the child exits)', async () => {
    // Long enough for a tsx child to start and open the workbook on a loaded runner.
    const conversion = await convertXlsxInChild(rowsWorkbook(40_000), LIMITS, { deadlineMs: 4_000 });
    const t0 = Date.now();
    await slotFree();
    expect(Date.now() - t0).toBeLessThan(8_000);
    expect(conversion.failure()).toBeInstanceOf(XlsxLimitError);
    expect(conversion.failure()).toMatchObject({ kind: 'too_slow' });
    expect(conversion.csv.destroyed).toBe(true);
    expect(conversion.signal.aborted).toBe(true);
  }, 20_000);

  it('a reader that gives up without reading (S3 not configured): dispose() frees the slot at once', async () => {
    const conversion = await convertXlsxInChild(rowsWorkbook(40_000), LIMITS);
    conversion.dispose();
    const t0 = Date.now();
    await slotFree();
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(conversion.csv.destroyed).toBe(true);
  });

  it('only the S3 upload left at the deadline (the child finished): a storage timeout, not too_slow', async () => {
    // Long enough for a tsx child to start and finish ten rows on a loaded runner.
    const conversion = await convertXlsxInChild(rowsWorkbook(10), LIMITS, { deadlineMs: 4_000 });
    await slotFree();
    expect(conversion.failure()).toBeNull();
    await aborted(conversion.signal, 10_000);
    expect(conversion.failure()).toBeInstanceOf(XlsxStorageTimeoutError);
    expect(conversion.signal.aborted).toBe(true);
    expect(conversion.signal.reason).toBeInstanceOf(XlsxStorageTimeoutError);
  }, 20_000);

  it('shutdown stops a conversion before and after it opens: XlsxShutdownError, slot free', async () => {
    const pending = convertXlsxInChild(rowsWorkbook(200_000), LIMITS);
    setTimeout(() => abortXlsxConversions(), 50);
    expect(await rejection(pending)).toBeInstanceOf(XlsxShutdownError);
    await slotFree();
    reopenXlsxConversionsForTests();
    const conversion = await convertXlsxInChild(rowsWorkbook(40_000), LIMITS);
    abortXlsxConversions();
    expect(await rejection(readAll(conversion))).toBeInstanceOf(XlsxShutdownError);
    await slotFree();
  });

  it('once the server is closing, a conversion asked for is refused at once, before any child is forked', async () => {
    let forks = 0;
    const spy: XlsxFork = (file, args, opts) => {
      forks += 1;
      return fork(file, args, opts);
    };
    abortXlsxConversions();
    expect(await rejection(convertXlsxInChild(rowsWorkbook(10), LIMITS, { fork: spy }))).toBeInstanceOf(XlsxShutdownError);
    expect(forks).toBe(0);
    expect(xlsxConversionRunning()).toBe(false);
  });

  it('shutdown reaches a conversion whose child has exited while its CSV is still being stored', async () => {
    // Ten rows: the child writes its CSV into the pipe and exits, the slot is free, and the
    // CSV waits for a reader (S3, slow) that has not taken it.
    const conversion = await convertXlsxInChild(rowsWorkbook(10), LIMITS);
    await slotFree();
    expect(conversion.failure()).toBeNull();
    abortXlsxConversions('closing');
    expect(conversion.failure()).toBeInstanceOf(XlsxShutdownError);
    expect(conversion.signal.aborted).toBe(true);
    expect(conversion.signal.reason).toBeInstanceOf(XlsxShutdownError);
  });

  it('a conversion disposed of is no longer live: shutdown leaves it be', async () => {
    const conversion = await convertXlsxInChild(rowsWorkbook(10), LIMITS);
    await readAll(conversion);
    await slotFree();
    conversion.dispose();
    abortXlsxConversions();
    expect(conversion.failure()).toBeNull();
    expect(conversion.signal.aborted).toBe(false);
  });

  it('the child gets no environment but PATH', async () => {
    process.env['XLSX_RUNNER_TEST_SECRET'] = 'not for the child';
    let child: ChildProcess | undefined;
    let options: Parameters<XlsxFork>[2] | undefined;
    const spy: XlsxFork = (file, args, opts) => {
      options = opts;
      child = fork(file, args, opts);
      return child;
    };
    try {
      // Forty thousand rows nobody reads: the child waits on the pipe, alive to be looked at.
      const conversion = await convertXlsxInChild(rowsWorkbook(40_000), LIMITS, { fork: spy });
      expect(options?.env).toEqual({ PATH: process.env['PATH'] ?? '' });
      if (process.platform === 'linux') {
        // What the process was started with (Node adds its IPC channel's own variables).
        const names = readFileSync(`/proc/${child!.pid}/environ`, 'utf8').split('\0').filter(Boolean)
          .map((entry) => entry.slice(0, entry.indexOf('=')))
          .filter((name) => !name.startsWith('NODE_CHANNEL_'));
        expect(names).toEqual(['PATH']);
      }
      conversion.dispose();
    } finally {
      delete process.env['XLSX_RUNNER_TEST_SECRET'];
    }
  });

  describe('how it ended is decided once nothing more can come from the child', () => {
    type Step = 'opened' | 'csv' | 'exit0' | 'exit1' | 'end' | 'refusal' | 'disconnect' | 'close';
    /**
     * A child that does what `script` says, in that order, one step a tick. Node does not
     * deliver a child's last IPC message before its `exit` event, so a script can put `exit`
     * first: the order a loaded host can produce.
     */
    function scripted(script: Step[]): XlsxFork {
      return () => {
        const child = new EventEmitter() as unknown as ChildProcess & { connected: boolean };
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const stdin = new PassThrough();
        stdin.resume();
        let code: number | null = null;
        Object.assign(child, {
          stdin, stdout, stderr, pid: 2 ** 22 + 7, exitCode: null, signalCode: null, connected: true, kill: () => true,
        });
        const run = (i: number) => {
          const step = script[i];
          if (step === undefined) return;
          switch (step) {
            case 'opened':
              child.emit('message', { t: 'opened', sheet: { name: 'S', other_sheet_names: [], other_sheet_count: 0 }, rows: 2, columns: 1 });
              break;
            case 'csv':
              stdout.end('Mobile\n9876500001\n');
              break;
            case 'exit0':
            case 'exit1':
              code = step === 'exit0' ? 0 : 1;
              Object.assign(child, { exitCode: code });
              child.emit('exit', code, null);
              break;
            case 'end':
              child.emit('message', { t: 'end' });
              break;
            case 'refusal':
              child.emit('message', { t: 'error', error: { name: 'XlsxRefusal', kind: 'unreadable', message: 'unreadable' } });
              break;
            case 'disconnect':
              child.connected = false;
              child.emit('disconnect');
              break;
            case 'close':
              stderr.end();
              child.emit('close', code, null);
              break;
          }
          setImmediate(() => run(i + 1));
        };
        setImmediate(() => run(0));
        return child;
      };
    }

    it('an exit 0 before the last message (`end`) is a good workbook, not a crash', async () => {
      const conversion = await convertXlsxInChild(rowsWorkbook(1), LIMITS, {
        fork: scripted(['opened', 'csv', 'exit0', 'end', 'disconnect', 'close']),
      });
      expect(await readAll(conversion)).toBe('Mobile\n9876500001\n');
      expect(conversion.failure()).toBeNull();
      expect(xlsxConversionRunning()).toBe(false);
    });

    it('the same when `close` comes before the channel disconnects, decided at the disconnect', async () => {
      const t0 = Date.now();
      const conversion = await convertXlsxInChild(rowsWorkbook(1), LIMITS, {
        fork: scripted(['opened', 'csv', 'exit0', 'close', 'end', 'disconnect']),
      });
      expect(await readAll(conversion)).toBe('Mobile\n9876500001\n');
      expect(conversion.failure()).toBeNull();
      // At the disconnect, not the fallback for a channel that stays open (2 s).
      expect(Date.now() - t0).toBeLessThan(1_000);
    });

    it('an exit before the refusal it sent is that refusal', async () => {
      const err = await rejection(convertXlsxInChild(rowsWorkbook(1), LIMITS, {
        fork: scripted(['exit1', 'refusal', 'disconnect', 'close']),
      }));
      expect(err).toBeInstanceOf(XlsxRefusal);
      expect(err).toMatchObject({ kind: 'unreadable' });
    });

    it('an exit with no message at all is still a crash, and frees the slot', async () => {
      const pending = convertXlsxInChild(rowsWorkbook(1), LIMITS, { fork: scripted(['exit1', 'disconnect', 'close']) });
      const err = await rejection(pending);
      expect((err as Error).message).toMatch(/stopped before it finished \(exit code 1\)/);
      expect(xlsxConversionRunning()).toBe(false);
    });

    it('a CSV that ends with no `end` message is a crash, not a good workbook', async () => {
      const conversion = await convertXlsxInChild(rowsWorkbook(1), LIMITS, {
        fork: scripted(['opened', 'csv', 'exit0', 'disconnect', 'close']),
      });
      expect((await rejection(readAll(conversion)) as Error).message).toMatch(/stopped before it finished/);
    });
  });

  it('a fork that cannot start (EMFILE: no pipes, `error` then `close`) is a rejection, not a crash, and frees the slot', async () => {
    const broken: XlsxFork = () => {
      const child = new EventEmitter() as unknown as ChildProcess;
      Object.assign(child, { stdin: null, stdout: null, stderr: null, pid: undefined, exitCode: null, signalCode: null, kill: () => false });
      process.nextTick(() => {
        child.emit('error', Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' }));
        child.emit('close', -24, null);
      });
      return child;
    };
    const err = await rejection(convertXlsxInChild(rowsWorkbook(10), LIMITS, { fork: broken }));
    expect((err as Error).message).toMatch(/EMFILE|could not be started/);
    expect(xlsxConversionRunning()).toBe(false);
  });

  it.runIf(process.platform === 'linux')('out of file descriptors for real (a process of its own under ulimit -n 256): rejected, slot free, and the process (and its group) survives', () => {
    const probe = path.join(__dirname, '../../helpers/xlsx-emfile-probe.ts');
    // In a session of its own (`setsid`): a regression that signals pid 0 kills only the probe's group.
    const out = execFileSync('setsid', ['--wait', 'bash', '-c', `ulimit -n 256 && exec "${process.execPath}" --import tsx "${probe}"`], {
      cwd: path.join(__dirname, '../../..'), encoding: 'utf8', timeout: 30_000,
    });
    const result = JSON.parse(out.trim().split('\n').pop()!) as { outcome: string; slotTaken: boolean };
    expect(result.outcome).toMatch(/^rejected: .*(EMFILE|could not be started)/);
    expect(result.slotTaken).toBe(false);
  });

  it('a SIGKILL it did not send (the kernel OOM killer) is too_much_memory; the child is the OOM killer\'s first pick', async () => {
    let child: ChildProcess | undefined;
    const spy: XlsxFork = (file, args, opts) => {
      child = fork(file, args, opts);
      return child;
    };
    const conversion = await convertXlsxInChild(rowsWorkbook(40_000), LIMITS, { fork: spy });
    if (process.platform === 'linux') {
      const deadline = Date.now() + 2_000;
      let adj = '';
      while (Date.now() < deadline && adj !== '1000') {
        adj = readFileSync(`/proc/${child!.pid}/oom_score_adj`, 'utf8').trim();
        if (adj !== '1000') await new Promise((r) => setTimeout(r, 20));
      }
      expect(adj).toBe('1000');
    }
    process.kill(child!.pid!, 'SIGKILL');
    const err = await rejection(readAll(conversion));
    expect(err).toBeInstanceOf(XlsxLimitError);
    expect(err).toMatchObject({ kind: 'too_much_memory' });
  });

  it('an already aborted signal is a rejected promise, never a synchronous throw', async () => {
    let pending: Promise<unknown> | undefined;
    expect(() => { pending = convertXlsxInChild(rowsWorkbook(10), LIMITS, { signal: AbortSignal.abort(new Error('gone already')) }); }).not.toThrow();
    expect((await rejection(pending!) as Error).message).toBe('gone already');
    expect(xlsxConversionRunning()).toBe(false);
  });

  it('the child exits when the server goes (its IPC channel closes)', async () => {
    const child = fork(path.join(__dirname, '../../../src/agency/agency-xlsx-worker.ts'), [JSON.stringify(LIMITS), '100'], {
      execArgv: ['--import', 'tsx'], stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });
    await new Promise((r) => setTimeout(r, 500));
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    child.disconnect();
    expect(await Promise.race([exited, new Promise((r) => setTimeout(() => r('still running'), 5_000))])).toBe(1);
  });
});
