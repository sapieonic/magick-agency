/**
 * chromium-layer.json is the Chromium layer aws/terraform publishes for this renderer: the
 * @sparticuz/chromium version and its x64 layer zip's SHA-256 (the GitHub release asset's
 * `digest`). Terraform fetches that version and refuses a zip with another hash, so a bump of the
 * dependency without the file (or the reverse) would fail the next plan; this fails it here first.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (name: string) => JSON.parse(readFileSync(join(root, name), 'utf8')) as Record<string, unknown>;

describe('chromium-layer.json', () => {
  it('is the layer for the @sparticuz/chromium this package pins, with a SHA-256', () => {
    const layer = read('chromium-layer.json');
    const pkg = read('package.json') as { devDependencies: Record<string, string> };
    expect(Object.keys(layer).sort()).toEqual(['sha256', 'version']);
    expect(layer.version).toBe(pkg.devDependencies['@sparticuz/chromium']);
    expect(layer.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(layer.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
