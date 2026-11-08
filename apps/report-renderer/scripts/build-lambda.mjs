// Builds the Lambda: esbuild bundles src/lambda.ts with every dependency into
// dist/lambda/index.mjs (ESM, Node 22), copies the IBM Plex woff2 files beside it (fonts.ts
// looks for ./fonts next to the bundle), and zips both into dist/report-renderer-lambda.zip with
// index.mjs AT THE ZIP ROOT (handler setting `index.handler`).
//
// `@sparticuz/chromium` is NOT bundled: it ships as a Lambda layer, mounted at
// /opt/nodejs/node_modules/@sparticuz/chromium, and src/lambda/chromium.ts resolves it there.
// Layer version and puppeteer-core version must match (see apps/report-renderer/CLAUDE.md).
//
// The zip is written by the small writer below (Node's zlib, no system `zip`), with fixed
// timestamps so the same input gives the same bytes.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist', 'lambda');
const zipPath = join(root, 'dist', 'report-renderer-lambda.zip');
const require = createRequire(join(root, 'package.json'));

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'fonts'), { recursive: true });

const result = await build({
  entryPoints: { index: join(root, 'src', 'lambda.ts') },
  outdir: outDir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: false,
  sourcemap: 'linked',
  legalComments: 'none',
  metafile: true,
  // The layer provides it; see src/lambda/chromium.ts.
  external: ['@sparticuz/chromium'],
  define: { 'process.env.NODE_ENV': '"production"' },
  // Bundled CommonJS dependencies call require() for Node built-ins.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'warning',
});

// The fonts: the list src/pdf/fonts.ts embeds (test/build-lambda.test.ts holds the two equal).
const faces = [
  ...[400, 500, 600].flatMap((w) => ['latin', 'latin-ext'].map((s) => ['@fontsource/ibm-plex-sans', `ibm-plex-sans-${s}-${w}-normal.woff2`])),
  ...[400, 500].map((w) => ['@fontsource/ibm-plex-mono', `ibm-plex-mono-latin-${w}-normal.woff2`]),
];
for (const [pkg, file] of faces) {
  copyFileSync(require.resolve(`${pkg}/files/${file}`), join(outDir, 'fonts', file));
}

// ── Minimal zip writer (stored paths relative to dist/lambda, deflated) ──────
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const locals = [];
const centrals = [];
let offset = 0;
for (const file of walk(outDir).sort()) {
  const name = Buffer.from(relative(outDir, file).split('\\').join('/'), 'utf8');
  const data = readFileSync(file);
  const deflated = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  locals.push(local, name, deflated);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30); // extra
  central.writeUInt16LE(0, 32); // comment
  central.writeUInt16LE(0, 34); // disk
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
  central.writeUInt32LE(offset, 42);
  centrals.push(central, name);
  offset += local.length + name.length + deflated.length;
}
const centralSize = centrals.reduce((s, b) => s + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(centrals.length / 2, 8);
end.writeUInt16LE(centrals.length / 2, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);
writeFileSync(zipPath, Buffer.concat([...locals, ...centrals, end]));

const bundleBytes = Object.values(result.metafile.outputs).reduce((s, o) => s + o.bytes, 0);
console.log(`built dist/lambda/index.mjs (${(bundleBytes / 1e6).toFixed(1)} MB with its map), ${faces.length} fonts, dist/report-renderer-lambda.zip (${(statSync(zipPath).size / 1e6).toFixed(1)} MB)`);
