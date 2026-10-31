import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT } from '../setup/factories.js';

/**
 * ─── `AgencySoftphoneSettingsRepository` AGAINST REAL POSTGRES ──────────────
 *
 * docs/softphone.md §3: one optional row per account, the defaults when there is
 * none, a whole-row replace on PUT, element shapes validated on the way in and
 * sanitised on the way out (the columns CHECK only "is an array").
 */

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));
vi.mock('../../../src/config/index.js', () => ({
  config: { redis: { keyPrefix: '' }, telephony: {} },
}));
vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  agencySoftphoneSettingsRepository: repo, SoftphoneSettingsInvalidError, validateSoftphoneSettings,
} = await import('../../../src/db/repositories/agency.repository.js');

const TENANT = DEFAULTS.tenantId;
const ACCOUNT = DEFAULTS.accountId;

const VALID = {
  disposition_catalog: [
    { code: 'interested', label: 'Interested', is_success: true },
    { code: 'do_not_call', label: 'Do not call', suppress: true },
  ],
  call_fields: [
    { key: 'order_id', label: 'Order ID', type: 'text' as const, required: true },
    { key: 'plan', label: 'Plan', type: 'choice' as const, options: ['basic', 'pro'] },
  ],
  analysis_profile_id: randomUUID(),
  record_calls: true,
  default_caller_id: '+919000000001',
};

describe('AgencySoftphoneSettingsRepository (integration)', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('reads as the defaults when the account has no row', async () => {
    expect(await repo.get(TENANT, ACCOUNT)).toEqual({
      disposition_catalog: [], call_fields: [], analysis_profile_id: null,
      record_calls: false, default_caller_id: null, updated_at: null,
    });
  });

  it('upsert creates the row, then replaces it wholesale; another account is unaffected', async () => {
    const created = await repo.upsert(TENANT, ACCOUNT, VALID);
    expect(created).toMatchObject({ ...VALID, updated_at: expect.any(String) });
    expect(await repo.get(TENANT, ACCOUNT)).toEqual(created);

    const replaced = await repo.upsert(TENANT, ACCOUNT, {
      disposition_catalog: [], call_fields: [], analysis_profile_id: null, record_calls: false, default_caller_id: null,
    });
    expect(replaced).toMatchObject({ disposition_catalog: [], call_fields: [], analysis_profile_id: null, record_calls: false });
    const { rows } = await getTestPool().query('SELECT * FROM agency_softphone_settings');
    expect(rows).toHaveLength(1);
    expect((await repo.get(TENANT, OTHER_ACCOUNT)).updated_at).toBeNull();
  });

  it('two racing first writes do not 23505: one row', async () => {
    await Promise.all([repo.upsert(TENANT, ACCOUNT, VALID), repo.upsert(TENANT, ACCOUNT, VALID)]);
    const { rows } = await getTestPool().query('SELECT id FROM agency_softphone_settings');
    expect(rows).toHaveLength(1);
  });

  it('refuses an invalid body with per-path issues and writes nothing', async () => {
    const bad = {
      ...VALID,
      disposition_catalog: [{ code: 'Bad Code', label: '' }],
      call_fields: [
        { key: 'Order', label: 'x', type: 'text' },
        { key: 'dup', label: 'a', type: 'text' },
        { key: 'dup', label: 'b', type: 'choice' },
        { key: 'n', label: 'n', type: 'number', options: ['1'] },
        { key: 'when', label: 'When', type: 'datetime' },
      ],
      analysis_profile_id: 'not-a-uuid',
    };
    let caught: unknown;
    try {
      await repo.upsert(TENANT, ACCOUNT, bad as never);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SoftphoneSettingsInvalidError);
    const paths = (caught as InstanceType<typeof SoftphoneSettingsInvalidError>).issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining([
      'disposition_catalog[0].code', 'disposition_catalog[0].label',
      'call_fields[0].key', 'call_fields[2].key', 'call_fields[2].options', 'call_fields[3].options',
      'call_fields[4].type', 'analysis_profile_id',
    ]));
    const { rows } = await getTestPool().query('SELECT id FROM agency_softphone_settings');
    expect(rows).toHaveLength(0);
  });

  it('validateSoftphoneSettings: the valid body has no issues; the field cap and key length are enforced', () => {
    expect(validateSoftphoneSettings(VALID)).toEqual([]);
    const many = Array.from({ length: 21 }, (_, i) => ({ key: `f_${i}`, label: `F${i}`, type: 'text' }));
    expect(validateSoftphoneSettings({ ...VALID, call_fields: many }).map((i) => i.path)).toContain('call_fields');
    const longKey = [{ key: `k${'x'.repeat(50)}`, label: 'L', type: 'text' }];
    expect(validateSoftphoneSettings({ ...VALID, call_fields: longKey }).map((i) => i.path)).toContain('call_fields[0].key');
    expect(validateSoftphoneSettings(null)).toHaveLength(1);
  });

  it('validateSoftphoneSettings refuses a key a plain object answers through its prototype', () => {
    for (const key of ['constructor', 'prototype']) {
      const issues = validateSoftphoneSettings({
        ...VALID, call_fields: [{ key: 'policy_no', label: 'P', type: 'text' }, { key, label: 'X', type: 'text' }],
      });
      expect(issues, key).toEqual([{ path: 'call_fields[1].key', message: `'${key}' is reserved; choose another key.` }]);
    }
    // A key merely containing one is fine.
    expect(validateSoftphoneSettings({ ...VALID, call_fields: [{ key: 'constructor_name', label: 'X', type: 'text' }] })).toEqual([]);
  });

  it('sanitises malformed stored elements on read rather than failing', async () => {
    await getTestPool().query(
      `INSERT INTO agency_softphone_settings (tenant_id, account_id, disposition_catalog, call_fields)
       VALUES ($1, $2, $3::jsonb, $4::jsonb)`,
      [
        TENANT, ACCOUNT,
        JSON.stringify([{ code: 'ok', label: 'OK' }, { label: 'no code' }, 'junk', null]),
        JSON.stringify([{ key: 'good', label: 'Good', type: 'text' }, { key: 'BAD', label: 'x', type: 'text' }, 7]),
      ],
    );
    const settings = await repo.get(TENANT, ACCOUNT);
    expect(settings.disposition_catalog).toEqual([{ code: 'ok', label: 'OK' }]);
    expect(settings.call_fields).toEqual([{ key: 'good', label: 'Good', type: 'text' }]);
  });
});
