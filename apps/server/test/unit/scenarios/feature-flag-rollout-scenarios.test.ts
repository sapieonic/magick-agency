import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── The authoritative rollout through-line (Quinn's IE sequence) ────────────
//
// Anchored at CORE's authoritative path: the REAL FeatureFlagService driving the
// REAL resolution + cache + invalidation, over a MOCKED repository whose override
// rows are an in-memory set we mutate between steps. This is the cross-service
// *logic* through-line — the master proxy and cusui render layers are already
// covered per-layer (master super-admin route tests, cusui FeatureFlagsContext
// tests); here we prove service → cache → invalidate → resolve → GATE for real,
// since that gate (connection-create + dispatch) is what whatsapp_personal hangs
// on regardless of the UI.

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mocks = vi.hoisted(() => ({
  findGlobal: vi.fn(),
  findByTenant: vi.fn(),
  evalInc: vi.fn(),
}));

vi.mock('@magick-agency/db/repositories/feature-flag.repository', () => ({
  featureFlagRepository: { findGlobal: mocks.findGlobal, findByTenant: mocks.findByTenant },
}));
vi.mock('@magick-agency/observability/metrics/shared', () => ({
  featureFlagEvaluationsTotal: { inc: mocks.evalInc },
}));

import { FeatureFlagService } from '../../../src/feature-flags/feature-flag.service.js';
import type { FeatureFlagOverrideRecord } from '@magick-agency/db/models/feature-flag.model';
import { FIXTURE_FLAGS } from '../../helpers/fixture-flags.js';

// PORT NOTE (magick-agency): ported from core
// test/unit/scenarios/feature-flag-rollout-scenarios.test.ts@4850d1d9. The
// through-line under test (service → cache → invalidate → resolve → gate) is the
// service's; the flag is an UNREGISTERED copy of core's `whatsapp_personal`
// (`test/helpers/fixture-flags.ts`) because agency's registry does not carry it
// and `isEnabled` resolves the definition it is handed. Mocks target agency
// module specifiers. Otherwise verbatim.
const PREFIX = 'mvc:';
const WA = FIXTURE_FLAGS.whatsapp_personal;

// ── In-memory override store the mocked repository reads from ────────────────
// Mutated between rollout steps; findGlobal/findByTenant project it like the DB.
let store: FeatureFlagOverrideRecord[];

function row(partial: Partial<FeatureFlagOverrideRecord>): FeatureFlagOverrideRecord {
  return {
    id: 'ov-' + Math.random(),
    flag_key: 'whatsapp_personal',
    scope_type: 'tenant',
    tenant_id: null,
    account_id: null,
    value: true,
    reason: null,
    expires_at: null,
    created_by: null,
    updated_by: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...partial,
  };
}

/** Simulate an S2S upsert: replace any same-scope row, then invalidate the cache. */
async function upsert(svc: FeatureFlagService, r: FeatureFlagOverrideRecord) {
  store = store.filter(
    (o) => !(o.flag_key === r.flag_key && o.scope_type === r.scope_type &&
             o.tenant_id === r.tenant_id && o.account_id === r.account_id),
  );
  store.push(r);
  if (r.scope_type === 'global') await svc.invalidate({});
  else await svc.invalidate({ tenantId: r.tenant_id! });
}

/** The gate the connection-create + dispatch paths actually call. */
async function gatePermits(svc: FeatureFlagService, tenantId: string, accountId = 'default'): Promise<boolean> {
  return svc.isEnabled(WA, { tenantId, accountId });
}

describe('whatsapp_personal rollout through-line (service → cache → invalidate → resolve → gate)', () => {
  let svc: FeatureFlagService;

  beforeEach(() => {
    vi.clearAllMocks();
    store = [];
    delete process.env['FF_WHATSAPP_PERSONAL'];
    mocks.findGlobal.mockImplementation(async () => store.filter((o) => o.scope_type === 'global'));
    mocks.findByTenant.mockImplementation(async (tenantId: string) =>
      store.filter((o) => o.tenant_id === tenantId && (o.scope_type === 'tenant' || o.scope_type === 'account')),
    );
    // null Redis → the service uses its per-replica local cache; upsert() invalidates it.
    svc = new FeatureFlagService(null, PREFIX);
  });

  it('IE1–IE4: default-off → enable A → isolation → bulk → global flip with D1 keystone', async () => {
    // ── IE1. Default off: no override, env unset → resolve false AND the gate denies.
    expect(await svc.isEnabled(WA, { tenantId: 'A' })).toBe(false);
    expect(await gatePermits(svc, 'A')).toBe(false);

    // ── IE2. Enable tenant A (tenant-scope true) + invalidate → A true AND gate permits.
    await upsert(svc, row({ scope_type: 'tenant', tenant_id: 'A', value: true }));
    expect(await svc.isEnabled(WA, { tenantId: 'A' })).toBe(true);
    expect(await gatePermits(svc, 'A')).toBe(true);
    // Isolation: tenant B has no override → still false (and gate denies).
    expect(await svc.isEnabled(WA, { tenantId: 'B' })).toBe(false);
    expect(await gatePermits(svc, 'B')).toBe(false);

    // ── IE3. Bulk-enable [A, B, C] → all three resolve true.
    for (const t of ['A', 'B', 'C']) {
      await upsert(svc, row({ scope_type: 'tenant', tenant_id: t, value: true }));
    }
    expect(await svc.isEnabled(WA, { tenantId: 'A' })).toBe(true);
    expect(await svc.isEnabled(WA, { tenantId: 'B' })).toBe(true);
    expect(await svc.isEnabled(WA, { tenantId: 'C' })).toBe(true);

    // ── IE4. Global flip true. A tenant with NO override inherits it…
    await upsert(svc, row({ scope_type: 'global', tenant_id: null, value: true }));
    expect(await svc.isEnabled(WA, { tenantId: 'D' })).toBe(true);

    // …but the D1 keystone: a tenant with an explicit FALSE override STILL resolves
    // false despite the global true (most-specific-wins), and the gate denies it.
    await upsert(svc, row({ scope_type: 'tenant', tenant_id: 'E', value: false }));
    expect(await svc.isEnabled(WA, { tenantId: 'E' })).toBe(false);
    expect(await gatePermits(svc, 'E')).toBe(false);
  });

  it('a stale cache cannot strand a tenant: without invalidate the old value persists; with it, the new value resolves', async () => {
    // Resolve once → caches A's (empty) snapshot as false.
    expect(await svc.isEnabled(WA, { tenantId: 'A' })).toBe(false);

    // Add an enabling override directly to the store WITHOUT invalidating.
    store.push(row({ scope_type: 'tenant', tenant_id: 'A', value: true }));
    expect(await svc.isEnabled(WA, { tenantId: 'A' })).toBe(false); // stale cache still false

    // Invalidate → next resolve re-reads the store → true. (This is the enablement path.)
    await svc.invalidate({ tenantId: 'A' });
    expect(await svc.isEnabled(WA, { tenantId: 'A' })).toBe(true);
  });

  it('env default rollout: FF_WHATSAPP_PERSONAL=true flips every un-overridden tenant on (staging-style)', async () => {
    process.env['FF_WHATSAPP_PERSONAL'] = 'true';
    const envSvc = new FeatureFlagService(null, PREFIX);
    expect(await envSvc.isEnabled(WA, { tenantId: 'anyone' })).toBe(true);
    // An explicit tenant false still wins over the env default.
    store.push(row({ scope_type: 'tenant', tenant_id: 'optout', value: false }));
    await envSvc.invalidate({ tenantId: 'optout' });
    expect(await envSvc.isEnabled(WA, { tenantId: 'optout' })).toBe(false);
  });
});
