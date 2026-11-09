// Terraform `external` program (reports.tf, data "external" "report_renderer_zip"): builds the
// renderer's Lambda zip from this checkout and prints {"sha256_base64": "<the zip's hash>"} (the
// form source_code_hash takes).
//
// Query (JSON on stdin): {"repo_root": "<path of the repository>", "zip": "<the zip the build writes>"}.
// Runs `pnpm install --frozen-lockfile` every time (a second or two when nothing changed), so the
// bundle is made from exactly the dependencies the checked-out lockfile pins, never from a
// node_modules left by an older checkout; then `pnpm --filter @magick-agency/report-renderer
// build:lambda`. The build is reproducible (scripts/build-lambda.mjs writes the zip with fixed
// timestamps), so an unchanged checkout gives the same bytes, the same source_code_hash and no
// new Lambda version.
//
// Build output goes to stderr: stdout is the protocol and carries only the JSON answer.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function fail(message) {
  process.stderr.write(`build-report-renderer: ${message}\n`);
  process.exit(1);
}

function run(cwd, args) {
  const result = spawnSync('pnpm', args, { cwd, stdio: ['ignore', 2, 2], shell: process.platform === 'win32' });
  if (result.error) fail(`could not run pnpm (${result.error.message}): install Node 22 and pnpm 10 (corepack enable)`);
  if (result.status !== 0) fail(`pnpm ${args.join(' ')} exited ${result.status}`);
}

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const q = JSON.parse(raw);
const root = resolve(q.repo_root ?? '');
if (!existsSync(join(root, 'apps', 'report-renderer', 'package.json'))) fail(`no apps/report-renderer under ${root}`);
if (!q.zip) fail('no zip');

run(root, ['install', '--frozen-lockfile']);
run(root, ['--filter', '@magick-agency/report-renderer', 'build:lambda']);

if (!existsSync(q.zip)) fail(`the build wrote no ${q.zip}`);
process.stdout.write(JSON.stringify({ sha256_base64: createHash('sha256').update(readFileSync(q.zip)).digest('base64') }));
