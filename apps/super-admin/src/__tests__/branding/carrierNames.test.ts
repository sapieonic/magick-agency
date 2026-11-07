import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TELEPHONY_PROVIDER_ALIASES } from '@magick-agency/web-ui/telephonyProviders';
import { operatorCarrierName } from '../../utils/carrierName';

/**
 * How the super-admin console names a carrier (decision PL16): "Alias (Vendor)", through
 * `operatorCarrierName`, on every screen. A source scan, like `noParentBrand.test.ts`:
 *  - the alias helper is called only by `utils/carrierName.ts`, so no screen shows a bare
 *    alias (or, through its fallback, a bare slug) while another shows "Alias (Vendor)";
 *  - no vendor name is written anywhere else in shipped code (copy, placeholders): the
 *    vendor reaches the screen only through the helper, or from the server where an
 *    operator must act in the vendor's own console (a credential field's help, the
 *    carrier's own refusal).
 * Comments are stripped first; tests are not scanned.
 */

const srcRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const HELPER = join('utils', 'carrierName.ts');
const VENDOR = /twilio|plivo|exotel|vobiz|telnyx|voice\s?link/i;

function shippedFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') shippedFiles(path, out);
    } else if (['.ts', '.tsx'].includes(extname(name)) && !/\.test\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

/** Block and line comments out; a `//` right after `:` is a URL scheme and stays. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const files = shippedFiles(srcRoot).map((path) => ({
  rel: relative(srcRoot, path),
  code: stripComments(readFileSync(path, 'utf8')),
}));

describe('carrier names in the super-admin console (PL16)', () => {
  it('scans the shipped sources', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.rel === HELPER)).toBe(true);
  });

  it('only the operator name helper calls the alias helper', () => {
    const offenders = files.filter((f) => f.rel !== HELPER && /telephonyProviderAlias\s*\(/.test(f.code)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('no vendor name is written outside the helper', () => {
    const offenders = files.filter((f) => f.rel !== HELPER && VENDOR.test(f.code)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('names every aliased carrier "Alias (Vendor)", from the slug or the API display name', () => {
    expect(operatorCarrierName('plivo')).toBe('Pravah (Plivo)');
    expect(operatorCarrierName('voicelink', 'VoiceLink')).toBe('Swar (VoiceLink)');
    expect(operatorCarrierName('generic_sip')).toBe('Sanchar (Generic SIP)');
    for (const [slug, alias] of Object.entries(TELEPHONY_PROVIDER_ALIASES)) {
      expect(operatorCarrierName(slug)).toMatch(new RegExp(`^${alias} \\(.+\\)$`));
    }
    // A carrier with no alias reads as its vendor name, never "X (X)".
    expect(operatorCarrierName('acme_tel', 'Acme Tel')).toBe('Acme Tel');
    expect(operatorCarrierName('acme_tel')).toBe('acme_tel');
  });
});
