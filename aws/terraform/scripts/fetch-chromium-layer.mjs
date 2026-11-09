// Terraform `external` program (reports.tf, data "external" "chromium_layer"): makes sure the
// @sparticuz/chromium x86_64 layer zip for one version is at `path`, with the pinned SHA-256, and
// prints {"sha256_base64": "<the same hash, base64>"} (the form source_code_hash takes).
//
// Query (JSON on stdin): {"version": "153.0.0", "sha256": "<hex>", "path": "<where the zip goes>"},
// from apps/report-renderer/chromium-layer.json. A file already there whose hash matches is used
// as it is; otherwise the zip is downloaded from the project's GitHub release, hashed while it
// streams, and moved into place only if the hash matches. A mismatch, a network error or a
// download slower than 15 minutes fails the plan and leaves nothing behind. Progress goes to
// stderr: stdout is the protocol and carries only the JSON answer.
//
// Node's fetch connects directly: behind a proxy, put the zip at `path` by hand (it is used once
// its hash matches).
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

function fail(message) {
  process.stderr.write(`fetch-chromium-layer: ${message}\n`);
  process.exit(1);
}

async function readQuery() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const q = JSON.parse(raw);
  if (!/^\d+\.\d+\.\d+$/.test(q.version ?? '')) fail(`bad version ${JSON.stringify(q.version)}`);
  if (!/^[0-9a-f]{64}$/.test(q.sha256 ?? '')) fail(`bad sha256 ${JSON.stringify(q.sha256)}`);
  if (!q.path) fail('no path');
  return q;
}

async function sha256Of(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

const q = await readQuery();
const path = q.path;
const name = basename(path);
mkdirSync(dirname(path), { recursive: true });

if (!existsSync(path) || (await sha256Of(path)) !== q.sha256) {
  const url = `https://github.com/Sparticuz/chromium/releases/download/v${q.version}/chromium-v${q.version}-layer.x64.zip`;
  process.stderr.write(`fetch-chromium-layer: downloading ${url}\n`);
  const partial = `${path}.partial`;
  const hash = createHash('sha256');
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15 * 60 * 1000) });
    if (!res.ok || !res.body) throw new Error(`answered ${res.status}`);
    const body = Readable.fromWeb(res.body);
    body.on('data', (chunk) => hash.update(chunk));
    await pipeline(body, createWriteStream(partial));
  } catch (error) {
    rmSync(partial, { force: true });
    fail(`GET ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const got = hash.digest('hex');
  if (got !== q.sha256) {
    rmSync(partial, { force: true });
    fail(`${name} has SHA-256 ${got}, expected ${q.sha256}: refusing it (apps/report-renderer/chromium-layer.json)`);
  }
  renameSync(partial, path);
}

process.stdout.write(JSON.stringify({ sha256_base64: Buffer.from(q.sha256, 'hex').toString('base64') }));
