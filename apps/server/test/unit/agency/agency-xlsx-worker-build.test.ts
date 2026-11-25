import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';
import { handWorkbook } from '../../helpers/xlsx-fixtures.js';

/*
 * The Excel upload's child process in the production build (IM8). The image runs the
 * esbuild bundle (`scripts/build.mjs`), where the runner is inside `dist/index.js` and must
 * fork `dist/xlsx-worker.js` beside it, with no tsx. This suite bundles the runner and the
 * child entry with the build's own settings (CJS, node22, third-party imports external) into
 * a directory under node_modules (so `saxes` resolves as it does from `dist/`), loads the
 * BUNDLED runner and converts a workbook with it.
 */

const SERVER = path.resolve(__dirname, '../../..');
const OUT = path.join(SERVER, 'node_modules/.cache/xlsx-worker-build');
/** The runner bundled alone: a build that left the worker out. */
const BROKEN = path.join(SERVER, 'node_modules/.cache/xlsx-worker-build-missing');

let bundled: typeof import('../../../src/agency/agency-xlsx-runner.js');
let broken: typeof import('../../../src/agency/agency-xlsx-runner.js');

const bundle = (entryPoints: Record<string, string>, outdir: string) => build({
    absWorkingDir: SERVER,
    entryPoints,
    outdir,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    logLevel: 'silent',
    plugins: [{
      name: 'externalize-third-party',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith('node:') ? undefined : { path: args.path, external: true }));
      },
    }],
  });

beforeAll(async () => {
  rmSync(OUT, { recursive: true, force: true });
  rmSync(BROKEN, { recursive: true, force: true });
  await bundle({ 'xlsx-runner': 'src/agency/agency-xlsx-runner.ts', 'xlsx-worker': 'src/agency/agency-xlsx-worker.ts' }, OUT);
  await bundle({ 'xlsx-runner': 'src/agency/agency-xlsx-runner.ts' }, BROKEN);
  bundled = createRequire(__filename)(path.join(OUT, 'xlsx-runner.js'));
  broken = createRequire(__filename)(path.join(BROKEN, 'xlsx-runner.js'));
}, 60_000);

describe('the Excel upload in the production build', () => {
  it('scripts/build.mjs builds the child entry the runner forks', () => {
    const script = readFileSync(path.join(SERVER, 'scripts/build.mjs'), 'utf8');
    expect(script).toContain("'xlsx-worker': 'src/agency/agency-xlsx-worker.ts'");
  });

  it('the bundled runner forks the bundled child and converts a workbook', async () => {
    const buf = handWorkbook({
      sheets: [
        { name: 'Hidden', state: 'hidden', xml: '<sheetData/>' },
        { name: 'Customers', xml: '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Mobile</t></is></c></row><row r="2"><c r="A2"><v>9876543210</v></c></row></sheetData>' },
      ],
    });
    const conversion = await bundled.convertXlsxInChild(buf, { maxDataRows: 1_000, maxColumns: 100, maxCsvBytes: 1_000_000 });
    expect(conversion.sheet).toEqual({ name: 'Customers', other_sheet_names: [], other_sheet_count: 0 });
    let csv = '';
    for await (const chunk of conversion.csv as AsyncIterable<Buffer>) csv += chunk.toString('utf8');
    expect(csv).toBe('Mobile\n9876543210\n');
  });

  it('a bundle without its worker says so plainly, and never falls back to tsx', async () => {
    const buf = handWorkbook({ sheets: [{ name: 'S', xml: '<sheetData/>' }] });
    expect(() => broken.xlsxWorkerEntry()).toThrow(/child's bundle is missing .*xlsx-worker\.js/);
    await expect(broken.convertXlsxInChild(buf, { maxDataRows: 10, maxColumns: 10, maxCsvBytes: 1_000 }))
      .rejects.toThrow(/the build did not include dist\/xlsx-worker\.js/);
    expect(broken.xlsxConversionRunning()).toBe(false);
  });
});
