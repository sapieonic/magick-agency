import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * PORT NOTE (magick-agency): ported from magick-master@a1f0756a
 * `test/unit/agency/proxy-agency-campaign-behavioral-capabilities.routes.test.ts`
 * (14 `it` × 2 surfaces = 28 cases) and `test/unit/agency/retry-inherited-config.test.ts`
 * (6 `it` + 4 `it.each` rows = 10 cases), against
 * `src/agency/campaign-behavioral-settings.ts`.
 *
 * Changes, all forced by plan §3.2 (governance → the per-account settings row):
 *  - the capability state is the account's `account_settings` row
 *    (`allow_recording` = `agency.recording`, `analyze_calls` = `agency.analytics`),
 *    supplied through a mocked `accountSettingsRepository` instead of governance
 *    override rows. A missing row / NULL column is OFF, as the governance default was;
 *  - the two "surfaces" are a test app's `POST /campaigns` and `PATCH /campaigns/:id`
 *    that call the gate and then a `forward` stub standing where `proxyToCore` stood
 *    (lane B2 ports the real routes; Phase 8 wires them to this module). Every
 *    refusal still asserts the forward never ran;
 *  - DELETED (2 cases × 2 surfaces = 4): "the section preHandler still refuses on
 *    `agency` itself" (the section capability is always on — the app IS agency,
 *    plan §3.2) and "kill switch OFF lets an enabling body straight through"
 *    (no governance, so no GOVERNANCE_ENABLED lever);
 *  - "a repository failure under the CHILD check" becomes a failing settings read;
 *  - interface (lead's security review): the gate takes the PARSED config and the
 *    campaign's own account (`target`), never `request.body` / `X-Account-Id`;
 *  - NEW (4 × 2): no ACCOUNT context fails closed; the campaign's account is judged,
 *    not the header's; no settings row / NULL columns refuse;
 *    the ON→OFF write is allowed to
 *    an account that has LOST the permission with no settings read at all.
 */

const TENANT = 'tenant-1';
const ACCOUNT = 'account-1';

const mocks = vi.hoisted(() => ({
  findByTenantAndAccount: vi.fn(),
  forward: vi.fn(),
}));

vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: { findByTenantAndAccount: mocks.findByTenantAndAccount },
}));
vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  assertBehavioralCapabilitiesForConfig,
  behavioralRefusalForConfig,
  resolveInheritedBehavioralConfig,
} from '../../../src/agency/campaign-behavioral-settings.js';

const PREFIX = '/agency';
const PROFILE_ID = '11111111-2222-3333-4444-555555555555';

/** The account's settings row as a super-admin write would have left it. */
function settings(opts: { recording?: boolean | null; analytics?: boolean | null } | null): void {
  if (opts === null) {
    mocks.findByTenantAndAccount.mockResolvedValue(null);
    return;
  }
  mocks.findByTenantAndAccount.mockResolvedValue({
    id: 'row-1',
    tenant_id: TENANT,
    account_id: ACCOUNT,
    max_concurrent_calls: 5,
    concurrency_allocation_mode: 'legacy_total',
    concurrency_allocation_version: 1,
    allow_recording: opts.recording ?? null,
    analyze_calls: opts.analytics ?? null,
    webrtc_max_duration_seconds: null,
    created_at: new Date(),
    updated_at: new Date(),
  });
}

async function buildApp(
  ctx: { accountId?: string | undefined; targetAccountId?: string | undefined } = { accountId: ACCOUNT },
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = TENANT;
    r['accountId'] = ctx.accountId;
    r['user'] = { id: 'user-1' };
  });
  const handler = async (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    // The test app's body stands for the route's PARSED output, and the target is
    // the campaign's own account (by default the request's, as on a create).
    const target = { tenantId: TENANT, accountId: 'targetAccountId' in ctx ? ctx.targetAccountId : ctx.accountId };
    if (!(await assertBehavioralCapabilitiesForConfig(request, reply, request.body, target))) return;
    mocks.forward({ body: request.body });
    return reply.send({ id: 'c1' });
  };
  app.post(`${PREFIX}/campaigns`, handler);
  app.patch(`${PREFIX}/campaigns/:id`, handler);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  settings(null);
});

/** The two write surfaces are the same guard; every case runs against both. */
const surfaces = [
  { name: 'POST /campaigns', method: 'POST' as const, url: `${PREFIX}/campaigns` },
  { name: 'PATCH /campaigns/:id', method: 'PATCH' as const, url: `${PREFIX}/campaigns/c1` },
];

describe.each(surfaces)('$name — agency.recording is enforced, not merely declared', (surface) => {
  it('REFUSES record_calls: true when agency.recording is off, and core is never called', async () => {
    settings({ recording: false });
    const app = await buildApp();

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign', record_calls: true },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'capability_disabled', capability: 'agency.recording' });
    // The assertion that distinguishes a real gate from a decorative one: the
    // body must not have reached core, which honours `record_calls` unchecked.
    expect(mocks.forward).not.toHaveBeenCalled();
    await app.close();
  });

  it('ALLOWS record_calls: false with the capability off — losing it must not freeze the campaign', async () => {
    settings({ recording: false });
    const app = await buildApp();

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign', record_calls: false },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.forward).toHaveBeenCalledTimes(1);
    expect(mocks.forward.mock.calls[0]![0].body).toMatchObject({ record_calls: false });
    await app.close();
  });

  it('ALLOWS an absent record_calls with the capability off', async () => {
    settings({ recording: false });
    const app = await buildApp();

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign' },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.forward).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('ALLOWS record_calls: true when agency.recording is on', async () => {
    settings({ recording: true });
    const app = await buildApp();

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign', record_calls: true },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.forward).toHaveBeenCalledTimes(1);
    expect(mocks.forward.mock.calls[0]![0].body).toMatchObject({ record_calls: true });
    await app.close();
  });

  it("REFUSES a string 'true' too — core casts unchecked and Postgres coerces it", async () => {
    settings({ recording: false });
    const app = await buildApp();

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign', record_calls: 'true' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'capability_disabled', capability: 'agency.recording' });
    expect(mocks.forward).not.toHaveBeenCalled();
    await app.close();
  });
});

describe.each(surfaces)('$name — agency.analytics is enforced, not merely declared', (surface) => {
  it('REFUSES a non-null analysis_profile_id when agency.analytics is off, and core is never called', async () => {
    settings({ analytics: false });
    const app = await buildApp();

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign', analysis_profile_id: PROFILE_ID },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'capability_disabled', capability: 'agency.analytics' });
    expect(mocks.forward).not.toHaveBeenCalled();
    await app.close();
  });

  it('ALLOWS analysis_profile_id: null with the capability off — that is how you turn it OFF', async () => {
    settings({ analytics: false });
    const app = await buildApp();

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign', analysis_profile_id: null },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.forward).toHaveBeenCalledTimes(1);
    expect(mocks.forward.mock.calls[0]![0].body).toMatchObject({ analysis_profile_id: null });
    await app.close();
  });

  it('ALLOWS an absent analysis_profile_id with the capability off', async () => {
    settings({ analytics: false });
    const app = await buildApp();

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign' },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.forward).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('ALLOWS analysis_profile_id when agency.analytics is on', async () => {
    settings({ analytics: true });
    const app = await buildApp();

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign', analysis_profile_id: PROFILE_ID },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.forward).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe.each(surfaces)('$name — the two capabilities are independent', (surface) => {
  it('recording ON + analytics OFF still refuses the analysis profile, naming analytics', async () => {
    settings({ recording: true, analytics: false });
    const app = await buildApp();

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign', record_calls: true, analysis_profile_id: PROFILE_ID },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'capability_disabled', capability: 'agency.analytics' });
    expect(mocks.forward).not.toHaveBeenCalled();
    await app.close();
  });

  it('both ON forwards a body carrying both', async () => {
    settings({ recording: true, analytics: true });
    const app = await buildApp();

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign', record_calls: true, analysis_profile_id: PROFILE_ID },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.forward.mock.calls[0]![0].body).toMatchObject({
      record_calls: true,
      analysis_profile_id: PROFILE_ID,
    });
    await app.close();
  });
});

describe.each(surfaces)('$name — fail closed on a settings read error', (surface) => {
  it('a repository failure under the check refuses rather than forwarding', async () => {
    mocks.findByTenantAndAccount.mockRejectedValue(new Error('pg down'));
    const app = await buildApp();

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign', record_calls: true },
    });

    expect(res.statusCode).toBe(403);
    expect(mocks.forward).not.toHaveBeenCalled();
    await app.close();
  });
});

describe.each(surfaces)('$name — NEW: per-account settings specifics', (surface) => {
  it('no account context refuses an enabling body (the settings are per account)', async () => {
    settings({ recording: true, analytics: true });
    const app = await buildApp({ accountId: undefined });

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { name: 'Campaign', record_calls: true },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'capability_disabled', capability: 'agency.recording' });
    expect(mocks.forward).not.toHaveBeenCalled();
    expect(mocks.findByTenantAndAccount).not.toHaveBeenCalled();
    await app.close();
  });

  it("judges the CAMPAIGN's account, not the X-Account-Id header", async () => {
    // Header account would allow; the campaign's own account refuses.
    mocks.findByTenantAndAccount.mockImplementation(async (_t: string, a: string) => ({
      id: `row-${a}`, tenant_id: TENANT, account_id: a, max_concurrent_calls: 5,
      concurrency_allocation_mode: 'legacy_total', concurrency_allocation_version: 1,
      allow_recording: a === ACCOUNT, analyze_calls: a === ACCOUNT,
      webrtc_max_duration_seconds: null, created_at: new Date(), updated_at: new Date(),
    }));
    const app = await buildApp({ accountId: ACCOUNT, targetAccountId: 'campaign-account-x' });

    const res = await app.inject({ method: surface.method, url: surface.url, payload: { record_calls: true } });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'capability_disabled', capability: 'agency.recording' });
    expect(mocks.findByTenantAndAccount).toHaveBeenCalledWith(TENANT, 'campaign-account-x');
    expect(mocks.forward).not.toHaveBeenCalled();
    await app.close();
  });

  it('an account with NO settings row (or NULL columns) refuses both — the default is off', async () => {
    const app = await buildApp();
    settings(null);
    const noRow = await app.inject({ method: surface.method, url: surface.url, payload: { record_calls: true } });
    expect(noRow.statusCode).toBe(403);
    expect(noRow.json()).toEqual({ error: 'capability_disabled', capability: 'agency.recording' });

    settings({ recording: null, analytics: null });
    const nulls = await app.inject({ method: surface.method, url: surface.url, payload: { analysis_profile_id: PROFILE_ID } });
    expect(nulls.statusCode).toBe(403);
    expect(nulls.json()).toEqual({ error: 'capability_disabled', capability: 'agency.analytics' });
    expect(mocks.forward).not.toHaveBeenCalled();
    await app.close();
  });

  it('the ON→OFF write is allowed to an account that LOST both permissions, without reading settings', async () => {
    settings({ recording: false, analytics: false });
    const app = await buildApp();

    const res = await app.inject({
      method: surface.method,
      url: surface.url,
      payload: { record_calls: false, analysis_profile_id: null },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.forward).toHaveBeenCalledTimes(1);
    expect(mocks.findByTenantAndAccount).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('behavioralRefusalForConfig (NEW, the pure decision)', () => {
  const ON = { allow_recording: true, analyze_calls: true };
  const OFF = { allow_recording: false, analyze_calls: false };
  it.each([
    ['record_calls: true, recording off', { record_calls: true }, { ...ON, allow_recording: false }, 'agency.recording'],
    ['record_calls: 1, recording off', { record_calls: 1 }, OFF, 'agency.recording'],
    ['analysis_profile_id set, analytics off', { analysis_profile_id: PROFILE_ID }, { ...ON, analyze_calls: false }, 'agency.analytics'],
    ['both requested, both off — recording named first (master order)', { record_calls: true, analysis_profile_id: PROFILE_ID }, OFF, 'agency.recording'],
  ])('refuses: %s', (_label, config, s, capability) => {
    expect(behavioralRefusalForConfig(config, s)).toEqual({ error: 'capability_disabled', capability });
  });
  it.each([
    ['record_calls: false', { record_calls: false }],
    ['record_calls: null', { record_calls: null }],
    ['analysis_profile_id: null', { analysis_profile_id: null }],
    ['neither field', { name: 'x' }],
    ['not an object', 'a string'],
    ['an array', [{ record_calls: true }]],
  ])('allows with everything off: %s', (_label, config) => {
    expect(behavioralRefusalForConfig(config, OFF)).toBeNull();
  });
});

// ── master test/unit/agency/retry-inherited-config.test.ts (verbatim cases) ──

const parent = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'camp-1', name: 'Q3 Winback', status: 'completed',
  record_calls: false, analysis_profile_id: null,
  ...patch,
});

describe('an override wins in both directions, by KEY PRESENCE', () => {
  it('carries an explicit false over a recording parent', () => {
    // Turning the capability OFF must not be refused for wanting it. `??` would
    // have discarded this and refused a retry that stops recording.
    expect(resolveInheritedBehavioralConfig(
      parent({ record_calls: true }), { record_calls: false },
    )).toEqual({ record_calls: false, analysis_profile_id: null });
  });

  it('carries an explicit null over a parent that has a profile', () => {
    expect(resolveInheritedBehavioralConfig(
      parent({ analysis_profile_id: 'prof-1' }), { analysis_profile_id: null },
    )).toEqual({ record_calls: false, analysis_profile_id: null });
  });

  it('inherits when the override names something else entirely', () => {
    expect(resolveInheritedBehavioralConfig(
      parent({ record_calls: true }), { pacing_ratio: 1.5 },
    )).toEqual({ record_calls: true, analysis_profile_id: null });
  });
});

describe('membership is OWN-property, never the prototype chain', () => {
  it('ignores a record_calls inherited by the overrides object', () => {
    // `'record_calls' in overrides` is true here. Under `in`, this reads as the
    // caller turning recording OFF — the gate passes — while core copies the
    // parent's `true` and the child records anyway.
    const polluted = Object.create({ record_calls: false }) as Record<string, unknown>;
    polluted['pacing_ratio'] = 1.5;

    expect(resolveInheritedBehavioralConfig(parent({ record_calls: true }), polluted))
      .toEqual({ record_calls: true, analysis_profile_id: null });
  });

  it('ignores an analysis_profile_id inherited by the PARENT object', () => {
    // The same rule on the other input. `proxyToCore` returns parsed JSON today,
    // so this is hardening rather than a reachable path — pinned because the
    // function is exported and pure, and a caller handing it a constructed
    // object is not exotic.
    const inherited = Object.create({ analysis_profile_id: 'prof-ghost' }) as Record<string, unknown>;
    inherited['record_calls'] = false;

    const effective = resolveInheritedBehavioralConfig(inherited, undefined);
    expect(effective['analysis_profile_id']).not.toBe('prof-ghost');
  });
});

describe('an unreadable parent fails CLOSED', () => {
  it.each([
    ['a slim DTO', { id: 'camp-1', name: 'Q3', status: 'completed' }],
    ['a wrapper', { campaign: { id: 'camp-1', record_calls: false } }],
    ['not an object', 'a string'],
    ['null', null],
  ])('treats %s as enabling both capabilities', (_label, body) => {
    // The old reading was "absent means absent", which PASSED the gate. That
    // held only for a core serving neither the column nor the route; the
    // dependency is a core that serves `/retry` and reports a slimmer campaign.
    //
    // Reading absent as enabling costs a tenant that does not hold the
    // capability a 403 somebody reports, instead of a consent gate that quietly
    // stopped running. A tenant that DOES hold it is unaffected either way.
    const effective = resolveInheritedBehavioralConfig(body, undefined);
    expect(effective['record_calls']).toBe(true);
    expect(effective['analysis_profile_id']).not.toBeNull();
    expect(effective['analysis_profile_id']).not.toBeUndefined();
  });

  it('still lets an override speak for an unreadable parent', () => {
    // A caller explicitly disabling recording is an opinion, and it is the one
    // input here that is not in doubt.
    expect(resolveInheritedBehavioralConfig(null, { record_calls: false, analysis_profile_id: null }))
      .toEqual({ record_calls: false, analysis_profile_id: null });
  });
});
