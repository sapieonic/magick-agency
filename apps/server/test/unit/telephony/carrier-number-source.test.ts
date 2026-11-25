// Where a carrier's tenant-account numbers come from (docs/carriers.md §2.2, CR6): from its
// account modes and its credential spec, never its name. A catalogue double names each mode:
// `svc` service only, `both` both modes, `own` tenant accounts only; Plivo is real (tenant
// accounts, a spec that lists numbers).
import { describe, expect, it, vi } from 'vitest';

const carriers = vi.hoisted(() => ({
  svc: { accounts: { service: true, tenant: false } },
  both: { accounts: { service: true, tenant: true } },
  own: { accounts: { service: false, tenant: true } },
}));
vi.mock('../../../src/telephony/carrier-catalog.js', async (importOriginal) =>
  (await import('../../helpers/carrier-catalog-double.js')).catalogDouble(await importOriginal(), carriers));

import { carrierNumberSource } from '../../../src/telephony/carrier-number-source.js';
import { findCredentialSpec } from '../../../src/telephony/credentials/credential-specs.js';

describe('carrierNumberSource', () => {
  it('a carrier whose credential spec lists the account`s numbers is `sync` (Plivo)', () => {
    expect(findCredentialSpec('plivo')?.listNumbers).toBeTypeOf('function');
    expect(carrierNumberSource('plivo')).toBe('sync');
  });

  it('a carrier on tenant accounts that cannot list them is `manual`, with or without a service account', () => {
    expect(carrierNumberSource('both')).toBe('manual');
    expect(carrierNumberSource('own')).toBe('manual');
  });

  it('a carrier without tenant accounts, or one the catalogue does not know, has none', () => {
    expect(carrierNumberSource('svc')).toBeNull();
    expect(carrierNumberSource('nobody')).toBeNull();
  });
});
