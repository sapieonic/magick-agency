/**
 * Run by `test/unit/agency/agency-xlsx-runner.test.ts` in a process of its own under a low
 * `ulimit -n`: it uses up its file descriptors, asks for a conversion (the fork then has no
 * pipes, EMFILE), and prints what happened as one JSON line. The process surviving to print
 * it is half the point: a runner that signalled the unstarted child's pid 0 killed its whole
 * process group.
 */
import fs from 'node:fs';
import { convertXlsxInChild, xlsxConversionRunning } from '../../src/agency/agency-xlsx-runner.js';

const fds: number[] = [];
try {
  for (;;) fds.push(fs.openSync('/dev/null', 'r'));
} catch { /* exhausted */ }
let outcome = 'pending';
convertXlsxInChild(Buffer.alloc(100), { maxDataRows: 10, maxColumns: 10, maxCsvBytes: 1_000 }, { deadlineMs: 1_000 })
  .then(() => { outcome = 'resolved'; }, (err: Error) => { outcome = `rejected: ${err.message}`; });
setTimeout(() => {
  for (const fd of fds) fs.closeSync(fd);
  process.stdout.write(`${JSON.stringify({ outcome, slotTaken: xlsxConversionRunning() })}\n`);
  process.exit(0);
}, 1_500);
