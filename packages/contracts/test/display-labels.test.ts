import { describe, expect, it } from 'vitest';
import * as Root from '../src/index';
import { AgencyApi, PlatformApi } from '../src/index';
import { ATTEMPT_STATE_LABELS, CONTACT_STATE_LABELS } from '../src/api/agency/agency-spine';

/**
 * Display labels in this package are user-facing copy, so they are British English
 * (root CLAUDE.md): dialled, dialling, cancelled. The KEYS are wire codes and are
 * never respelled (`dialing`, `canceled`), which is why only the values are read.
 *
 * Every export named `*_LABEL` or `*_LABELS` is scanned, across the root, `AgencyApi`
 * and `PlatformApi`, so a label map added later is covered without a line here. The
 * word list is the console's own British-spelling guard's.
 */
const AMERICAN = /\b(dialing|dialed|dialer|dialers|redialing|redialed|canceled|canceling|utilization|recognize|recognized|organization|organizations|behavior)\b/i;

function labelStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(labelStrings);
  return [];
}

const namespaces: Record<string, Record<string, unknown>> = {
  root: Root as unknown as Record<string, unknown>,
  AgencyApi: AgencyApi as unknown as Record<string, unknown>,
  PlatformApi: PlatformApi as unknown as Record<string, unknown>,
};

const labelExports = Object.entries(namespaces).flatMap(([ns, mod]) => Object.entries(mod)
  .filter(([name]) => /_LABELS?$/.test(name))
  .map(([name, value]) => ({ name: `${ns}.${name}`, value })));

describe('display labels are British English', () => {
  it('finds the label maps, the spine state maps among them', () => {
    expect(labelExports.length).toBeGreaterThan(3);
    expect(labelExports.map((e) => e.value)).toContain(CONTACT_STATE_LABELS);
    expect(labelExports.map((e) => e.value)).toContain(ATTEMPT_STATE_LABELS);
  });

  it('no label carries an American spelling', () => {
    const offenders = labelExports.flatMap(({ name, value }) => labelStrings(value)
      .filter((text) => AMERICAN.test(text))
      .map((text) => `${name}: ${JSON.stringify(text)}`));
    expect(offenders).toEqual([]);
  });

  it('names the contact being called and the dialling state in British English', () => {
    expect(CONTACT_STATE_LABELS.in_flight).toBe('Being dialled');
    expect(ATTEMPT_STATE_LABELS.dialing).toBe('Dialling');
  });
});
