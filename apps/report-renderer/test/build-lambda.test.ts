/**
 * The Lambda package: index.mjs at the ZIP ROOT exporting `handler` (Terraform's handler setting
 * is `index.handler`), the fonts fonts.ts embeds beside it, and `@sparticuz/chromium` left out
 * (it is the layer's).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { fontFileNames } from '../src/pdf/fonts';

const root = join(__dirname, '..');

/** Names and contents from a zip's central directory (deflate or stored entries only). */
function readZip(buf: Buffer): Map<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const entries = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < entries; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    out.set(name, method === 8 ? inflateRawSync(data) : data);
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

describe('build:lambda', () => {
  it('zips index.mjs at the root with the fonts, leaving the layer’s Chromium out', async () => {
    execFileSync(process.execPath, [join(root, 'scripts', 'build-lambda.mjs')], { cwd: root, stdio: 'pipe' });
    const zip = readZip(readFileSync(join(root, 'dist', 'report-renderer-lambda.zip')));
    expect(zip.has('index.mjs')).toBe(true);
    expect([...zip.keys()].filter((k) => k.startsWith('fonts/')).sort()).toEqual(fontFileNames().map((f) => `fonts/${f}`).sort());
    const index = zip.get('index.mjs')!.toString('utf8');
    expect(index).toEqual(readFileSync(join(root, 'dist', 'lambda', 'index.mjs'), 'utf8'));
    expect(index).toMatch(/export\s*\{[^}]*\bhandler\b/);
    // The layer package is imported, not bundled.
    expect(index).toContain('"@sparticuz/chromium"');
    expect(index).not.toContain('chromium.br');
    const mod = (await import(join(root, 'dist', 'lambda', 'index.mjs'))) as { handler: unknown };
    expect(typeof mod.handler).toBe('function');
  }, 120_000);
});
