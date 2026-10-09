import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PERMISSION_MATRIX, type MembershipRole } from '@magick-agency/contracts/rbac';

/**
 * ─── THE AGENCY CALL READ (`proxy-agency-calls.routes.ts`) ──────────────────
 *
 * The surface whose absence made the agency workspace link its attempt rows into
 * `/app/calls/dialer/history/:id` — the primary application's shell, gated on the
 * primary application's capability (`docs/agency-dialer-design.md` §7b).
 *
 * ── What this file is actually for ─────────────────────────────────────────
 *
 * Four properties, each of which fails silently if it is only asserted by a
 * status code somewhere else:
 *
 *  1. **The plugin's three hooks run.** Session, tenant context and the `agency`
 *     entitlement gate are the three things a unit test cannot exercise for real,
 *     and also the three whose DELETION from the plugin would change nothing any
 *     other case here can see. So the doubles record that they ran and the
 *     assertion is on the double being invoked, never on a status.
 *  2. **`agency.supervise` is the floor, and it is `account_admin`.** One notch
 *     too low turns a supervisory read into peer surveillance: any agent could
 *     read a colleague's conversation. RBAC therefore runs for REAL here and the
 *     cases are written per role.
 *  3. **`agency.recording` gates HEARING the call, not configuring it.** The
 *     capability already existed but gated only the campaign config write, so a
 *     tenant who had never been granted recording could still listen to
 *     recordings that predated the grant. Gating the write and not the playback
 *     is gating the wrong end.
 *  4. **A purged call is forwarded as a 200 with a marker.** Core deliberately
 *     does not 404 it — the attempt outlives the call by design (core migration
 *     076) — so this tier must not turn it into an error either.
 *
 * PORT NOTE (magick-agency): ported from magick-master@a1f0756a
 * `test/unit/agency/proxy-agency-calls.routes.test.ts` (32 `it` + 8 `it.each` = 66
 * cases). Changes:
 *  - `proxyToCore` is `callCore` (`src/api/core-dispatch.ts`, the in-process seam),
 *    mocked under the old variable name so the assertions stay byte-identical; the
 *    `resolveCoreApiKey` mock is gone with the key. Where a case asserted the key was
 *    never decrypted ("raised before the credential is decrypted"), it now asserts the
 *    owning account's campaign and settings were never read — the same "refused before
 *    anything is resolved" property on what this route now resolves.
 *  - governance is gone (plan §3.2): the `agency` section gate is deleted, and
 *    `requireCapability('agency.recording')` / `isCapabilityEnabled` became the
 *    settings row (`allow_recording` / `analyze_calls`) of the campaign's OWNING
 *    account. The doubles are now `agencyCampaignRepository.findById` (the owner) and
 *    `accountSettingsRepository.findByTenantAndAccount` (its row); `setGrants` replaces
 *    every `isCapabilityEnabled` implementation one for one.
 *  - Modified, named: "runs session, tenant context and the agency gate, in that
 *    order" (now "runs session and tenant context, in that order") and "runs them on
 *    the recording route too" (two hooks, the gate is gone); the 12 traversal rows and
 *    the 2 "appends" rows (credential assertion → no campaign/settings read); "asks for
 *    agency.recording on the media route" (the owner's row is read before core),
 *    "does not require it for the detail read" (recording off still 200s the detail),
 *    "refuses the media route when the capability gate refuses" (the row says off →
 *    master's 403 body); the field-strip cases only change how the grant is set.
 *  - NEW: the `owning-account settings` describe at the end (the PORT NOTE function's
 *    own cases: ownership, NULL/no row, failures, no account context).
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const SUPERVISOR = '44444444-4444-4444-8444-444444444444';
const CAMPAIGN = '55555555-5555-4555-8555-555555555555';
const ATTEMPT = '66666666-6666-4666-8666-666666666666';

const ACCOUNT = 'account-1';

const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
  /** What the plugin-level hooks did, in order, on the last request. */
  hooksRan: [] as string[],
  /**
   * PORT NOTE (magick-agency): the campaign row the gates read the OWNER from
   * (replaces the governance doubles).
   */
  findCampaign: vi.fn<
    (id: string) => Promise<{ id: string; tenant_id: string; account_id: string } | null>
  >(),
  /** The owner's settings row (`allow_recording` / `analyze_calls`, NULL-able). */
  findSettings: vi.fn<
    (tenantId: string, accountId: string) => Promise<
      { allow_recording: boolean | null; analyze_calls: boolean | null } | null
    >
  >(),
}));

vi.mock('../../../src/api/core-dispatch.js', () => ({ callCore: mocks.proxyToCore }));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: async () => { mocks.hooksRan.push('session'); },
}));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async () => { mocks.hooksRan.push('tenant-context'); },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyCampaignRepository: { findById: mocks.findCampaign },
}));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: { findByTenantAndAccount: mocks.findSettings },
}));

/** PORT NOTE (magick-agency): the owner's two settings — what `isCapabilityEnabled` answered. */
function setGrants(grants: { recording: boolean; analytics: boolean }): void {
  mocks.findSettings.mockResolvedValue({
    allow_recording: grants.recording,
    analyze_calls: grants.analytics,
  });
}

// `rbac.middleware.js` and `roles.js` are deliberately NOT mocked — the floor is
// what half these cases are about, so it is the code under test.
import { proxyAgencyCallsRoutes } from '../../../src/api/routes/proxy-agency-calls.routes.js';

const PREFIX = '/proxy/agency';
const DETAIL = `${PREFIX}/campaigns/${CAMPAIGN}/attempts/${ATTEMPT}`;
const RECORDING = `${DETAIL}/recording`;

async function buildApp(
  role: MembershipRole = 'account_admin',
  // PORT NOTE (magick-agency): an absent account context is a fail-closed case now
  // (`null` here = no `request.accountId`; `undefined` would take the default).
  accountId: string | null = ACCOUNT,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    // Via `unknown`: FastifyRequest and Record do not sufficiently overlap.
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = TENANT;
    r['accountId'] = accountId ?? undefined;
    r['user'] = { id: SUPERVISOR };
    r['membership'] = { role };
  });
  await app.register(proxyAgencyCallsRoutes, { prefix: PREFIX });
  await app.ready();
  return app;
}

/** Core's envelope for an attempt whose call is still there. */
function availableBody() {
  return {
    attempt: {
      id: ATTEMPT,
      campaign_id: CAMPAIGN,
      disposition_code: 'NOT_INTERESTED',
      notes: 'call back next quarter',
      agent_user_id: 'u-ravi',
      webrtc_call_id: 'call-1',
    },
    call: {
      id: 'call-1',
      destination_phone: '+14155550199',
      status: 'completed',
      // Core's own address space — master must repoint this at itself.
    recording_url: `/api/v1/agency-campaigns/${CAMPAIGN}/attempts/${ATTEMPT}/recording`,
      analysis_status: 'completed',
      call_analysis: { summary: 'customer declined' },
      conversation_log: [{ role: 'agent', text: 'hello' }],
      transcript_meta: { diarization_failed: false },
    },
    call_availability: 'available',
  };
}

/** Core's envelope once the call row has aged out of retention. */
function purgedBody() {
  return {
    attempt: { ...availableBody().attempt },
    call: null,
    call_availability: 'purged',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hooksRan.length = 0;
  mocks.findCampaign.mockImplementation(async (id: string) => ({ id, tenant_id: TENANT, account_id: ACCOUNT }));
  setGrants({ recording: true, analytics: true });
  mocks.proxyToCore.mockResolvedValue({ status: 200, body: availableBody() });
});

describe('the plugin-level hooks actually run', () => {
  /**
   * Not a status assertion. A hook that was never registered leaves no entry
   * here, and a stubbed-open double leaves the same trace as a real one — so the
   * only thing that can distinguish "registered" from "absent" is the double
   * being invoked.
   */
  // PORT NOTE (magick-agency): the `agency` section gate is gone (plan §3.2), so two hooks.
  it('runs session and tenant context, in that order', async () => {
    const app = await buildApp();
    await app.inject({ method: 'GET', url: DETAIL });

    expect(mocks.hooksRan).toEqual(['session', 'tenant-context']);
    await app.close();
  });

  it('runs them on the recording route too', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200, body: Buffer.from('audio'), headers: new Headers({ 'content-type': 'audio/wav' }),
    });
    const app = await buildApp();
    await app.inject({ method: 'GET', url: RECORDING });

    expect(mocks.hooksRan).toEqual(['session', 'tenant-context']);
    await app.close();
  });
});

describe('a path-escaping param never reaches core', () => {
  /**
   * ─── WHAT THIS GUARD ACTUALLY CLOSES ──────────────────────────────────────
   *
   * find-my-way routes on the ENCODED path and hands the handler a
   * percent-DECODED param, so `%2F` arrives as a real `/`. Both routes here
   * interpolate `:id` and `:attemptId` into a core path.
   *
   * **The `..` traversal was already closed upstream** and these cases are not
   * claiming otherwise: `proxyToCore` refuses any path that does not survive a
   * WHATWG parse unchanged (`src/proxy/safe-core-path.ts`), which covers `..`,
   * `%2e%2e`, `.%2e`, `#` and `\\`. They are kept because this route's own guard
   * has to refuse them too — the refusal must be raised BEFORE the tenant's core
   * API key is decrypted, and before the proxy client records anything.
   *
   * What the parse check allows, correctly, is a BARE EXTRA SLASH. That is the
   * live risk on this plugin, because `:attemptId` is the terminal segment of the
   * detail route's core path: `attemptId = a%2Frecording` builds core's media
   * path and reaches it through the detail route, which is floored at
   * `agency.supervise` but deliberately does not carry
   * `requireCapability('agency.recording')` — the one capability this plugin was
   * added to enforce.
   *
   * ── Why each case asserts core was never called ───────────────────────────
   *
   * A 4xx alone is not proof: with the guard gone, `proxyToCore` itself answers
   * 400 for a dot-segment path, so a status-only assertion would pass against the
   * bug. Asserting that `proxyToCore` and `resolveCoreApiKey` were never touched
   * is what makes the refusal provably THIS route's, raised before the credential
   * is decrypted.
   */
  const TRAVERSALS: Array<[string, string]> = [
    ['campaign id escaping into another core surface', `${PREFIX}/campaigns/x%2F..%2F..%2Fknowledge-bases/attempts/${ATTEMPT}`],
    ['attempt id escaping into core internals', `${PREFIX}/campaigns/${CAMPAIGN}/attempts/a%2F..%2F..%2F..%2Finternal%2Faudit-logs`],
    ['a bare encoded slash in the campaign id', `${PREFIX}/campaigns/a%2Fb/attempts/${ATTEMPT}`],
    ['a query truncation in the attempt id', `${PREFIX}/campaigns/${CAMPAIGN}/attempts/a%3Fadmin=1`],
    ['a fragment truncation in the attempt id', `${PREFIX}/campaigns/${CAMPAIGN}/attempts/a%23frag`],
    ['a backslash in the campaign id', `${PREFIX}/campaigns/a%5Cb/attempts/${ATTEMPT}`],
  ];

  it.each(TRAVERSALS)('detail: refuses %s without calling core', async (_label, url) => {
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    // PORT NOTE (magick-agency): was `resolveCoreApiKey` (no key now) — refused before
    // the owning account is resolved.
    expect(mocks.findCampaign).not.toHaveBeenCalled();
    expect(mocks.findSettings).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(TRAVERSALS)('recording: refuses %s without calling core', async (_label, url) => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200, body: Buffer.from('audio'), headers: new Headers(),
    });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${url}/recording` });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    // PORT NOTE (magick-agency): was `resolveCoreApiKey` (no key now) — refused before
    // the owning account is resolved.
    expect(mocks.findCampaign).not.toHaveBeenCalled();
    expect(mocks.findSettings).not.toHaveBeenCalled();
    await app.close();
  });

  /**
   * The bare-slash case named in this block's header, isolated because it is the
   * one the upstream parse check would have let through: a segment appended to
   * `:attemptId` reaches core's media route through the detail route, which does
   * not carry `agency.recording`.
   */
  it.each([
    ['the recording route, bypassing agency.recording', 'a%2Frecording'],
    ['a deeper core subpath', 'a%2Fnotes'],
  ])('refuses an attempt id that appends %s', async (_label, attemptId) => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/attempts/${attemptId}`,
    });

    expect(res.statusCode).toBe(400);
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    // PORT NOTE (magick-agency): was `resolveCoreApiKey` and the governance trace; the
    // owning account's row is now what the media gate reads, and it was never read.
    expect(mocks.findCampaign).not.toHaveBeenCalled();
    // The detail route never asked for the media capability, which is exactly why
    // the id must not be able to walk onto the media path.
    expect(mocks.findSettings).not.toHaveBeenCalled();
    await app.close();
  });

  /**
   * The guard chosen here is the UUID shape, not the four exploitable characters
   * — both ids are uuids on every real call path, so the tighter check costs
   * nothing and refuses the whole space of malformed ids. Pinned because the
   * looser character guard would pass all of these, and the difference is the
   * decision this route made.
   */
  it.each([
    ['a numeric id', '12345'],
    ['a slug', 'my-campaign-v2'],
    ['a truncated uuid', '55555555-5555-4555-8555'],
    ['a uuid with a trailing character', `${CAMPAIGN}x`],
    ['an empty-ish dotted name', 'file.v1.json'],
  ])('refuses %s as well, because these ids are uuids', async (_label, id) => {
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${id}/attempts/${ATTEMPT}` });

    expect(res.statusCode).toBe(400);
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  /** ...and a real pair of uuids is untouched, so the guard is not just "deny". */
  it('still forwards a well-formed pair of uuids', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: DETAIL });

    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore).toHaveBeenCalledOnce();
    expect(mocks.proxyToCore.mock.calls[0]![0].path)
      .toBe(`/agency-campaigns/${CAMPAIGN}/attempts/${ATTEMPT}`);
    await app.close();
  });

  /**
   * The recording path master hands back is built from the request's own params,
   * so it must not be possible to get a traversed segment INTO that string
   * either — a `recording_url` carrying `../..` would be a link the console
   * follows back into this service. Covered by the same guard, asserted
   * separately because it is a different consequence of the same input.
   */
  it('never mints a recording_url from an unvalidated param', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/campaigns/x%2F..%2F..%2Fknowledge-bases/attempts/${ATTEMPT}`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('knowledge-bases');
    await app.close();
  });
});

describe('the permission floor is agency.supervise', () => {
  /**
   * Pinned against the real matrix rather than restated, so a change to the floor
   * shows up here as a failure rather than as two files quietly disagreeing.
   */
  it('is account_admin in the matrix', () => {
    expect(PERMISSION_MATRIX['agency.supervise']).toBe('account_admin');
  });

  it('detail: allows account_admin', async () => {
    const app = await buildApp('account_admin');
    const res = await app.inject({ method: 'GET', url: DETAIL });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('recording: allows account_admin', async () => {
    // A byte body, which is what the media route actually gets back.
    mocks.proxyToCore.mockResolvedValue({
      status: 200, body: Buffer.from('a'), headers: new Headers(),
    });
    const app = await buildApp('account_admin');
    const res = await app.inject({ method: 'GET', url: RECORDING });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  /**
   * The peer-surveillance case. `agent` sits at hierarchy level 5, BELOW `viewer`,
   * deliberately — an agent must not be able to read a colleague's conversation,
   * disposition or notes. If an agent ever legitimately needs to review their own
   * calls, that is an agency-native route with its own floor; it is never a change
   * to the role level.
   */
  it.each([
    ['agent', 'agent'],
    ['viewer', 'viewer'],
    ['operator', 'operator'],
  ])('%s cannot read an agency call', async (_n, role) => {
    const app = await buildApp(role as MembershipRole);

    for (const url of [DETAIL, RECORDING]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(403);
    }
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('agency.recording gates hearing the call', () => {
  /**
   * The gap this closes: the capability existed but was enforced only on the
   * campaign config write, so a tenant never granted recording could still play
   * recordings that predated the grant.
   */
  it('asks for agency.recording on the media route', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200, body: Buffer.from('a'), headers: new Headers(),
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: RECORDING });

    // PORT NOTE (magick-agency): the gate is the OWNING account's settings row, read
    // from the campaign before core is called.
    expect(res.statusCode).toBe(200);
    expect(mocks.findCampaign).toHaveBeenCalledWith(CAMPAIGN);
    expect(mocks.findSettings).toHaveBeenCalledWith(TENANT, ACCOUNT);
    expect(mocks.findSettings.mock.invocationCallOrder[0]!)
      .toBeLessThan(mocks.proxyToCore.mock.invocationCallOrder[0]!);
    await app.close();
  });

  /**
   * And NOT on the detail route. Reading the disposition, the notes and who
   * dialled is the supervisory read; it does not require the media entitlement,
   * and requiring it would hide the audit trail from a tenant who simply never
   * bought recording.
   */
  it('does not require it for the detail read', async () => {
    // PORT NOTE (magick-agency): the detail route reads the row too (for the field
    // strip, as master's `isCapabilityEnabled` did), so "not required" is now: with
    // recording OFF the detail read still answers 200.
    setGrants({ recording: false, analytics: true });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: DETAIL });

    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore).toHaveBeenCalledOnce();
    await app.close();
  });

  it('refuses the media route when the capability gate refuses', async () => {
    // PORT NOTE (magick-agency): the owner's `allow_recording` is false.
    setGrants({ recording: false, analytics: true });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: RECORDING });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'capability_disabled', capability: 'agency.recording' });
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('forwarding to core', () => {
  it('forwards the campaign and attempt ids on the attempt path', async () => {
    const app = await buildApp();
    await app.inject({ method: 'GET', url: DETAIL });

    expect(mocks.proxyToCore).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      path: `/agency-campaigns/${CAMPAIGN}/attempts/${ATTEMPT}`,
      metricPath: '/agency-campaigns/:id/attempts/:id',
      tenantId: TENANT,
    }));
    await app.close();
  });

  it('requests the recording raw, so bytes are not JSON-mangled', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200, body: Buffer.from('audio'), headers: new Headers({ 'content-type': 'audio/wav' }),
    });
    const app = await buildApp();
    await app.inject({ method: 'GET', url: RECORDING });

    expect(mocks.proxyToCore).toHaveBeenCalledWith(expect.objectContaining({
      path: `/agency-campaigns/${CAMPAIGN}/attempts/${ATTEMPT}/recording`,
      rawResponse: true,
    }));
    await app.close();
  });

  it('copies content-type and length off core’s response and streams the bytes', async () => {
    const audio = Buffer.from('RIFFfake');
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: audio,
      headers: new Headers({ 'content-type': 'audio/wav', 'content-length': String(audio.length) }),
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: RECORDING });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(res.headers['content-length']).toBe(String(audio.length));
    expect(res.headers['cache-control']).toBe('private, max-age=3600');
    expect(res.rawPayload.equals(audio)).toBe(true);
    await app.close();
  });

  it('passes a core 404 through rather than masking it as a 200', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 404, body: { error: 'Not Found', code: 'attempt_not_found' },
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: DETAIL });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('attempt_not_found');
    await app.close();
  });

  /**
   * ─── A CORE 4xx ON THE MEDIA ROUTE IS JSON, NOT OPAQUE BYTES ──────────────
   *
   * The case above is the DETAIL route, whose body arrives as a plain object.
   * The media route asks for `rawResponse`, and `proxyToCore` buffers every
   * status — so before this was fixed a core 404 was forwarded as a `Buffer`,
   * which Fastify types `application/octet-stream`. Nothing leaked (the error
   * mask's `parseJsonPayload` reads Buffers), but a console branching on content
   * type could not parse the one refusal §7b makes load-bearing: `call_purged`
   * is what lets it say "this recording has aged out" rather than "the platform
   * is broken", and `no_recording` is a different sentence again.
   *
   * These cases assert the CONTENT TYPE as well as the code, because the code
   * survived the old behaviour and the content type is what did not — a test that
   * only read `res.json()` would have passed against the Buffer.
   */
  describe('a core refusal on the media route', () => {
    /** As core sends it: `rawResponse` hands the route the bytes, not an object. */
    function coreErrorBytes(status: number, code: string, message: string) {
      return {
        status,
        body: Buffer.from(JSON.stringify({ error: 'Not Found', code, message })),
        headers: new Headers({ 'content-type': 'application/json' }),
      };
    }

    it.each([
      ['call_purged', 404, 'This recording is no longer available'],
      ['no_recording', 404, 'No recording available for this call'],
      ['call_never_placed', 404, 'This attempt never placed a call'],
    ])('forwards %s as parseable JSON, not octet-stream', async (code, status, message) => {
      mocks.proxyToCore.mockResolvedValue(coreErrorBytes(status, code, message));
      const app = await buildApp();

      const res = await app.inject({ method: 'GET', url: RECORDING });

      expect(res.statusCode).toBe(status);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.json()).toMatchObject({ code, message });
      await app.close();
    });

    /**
     * Core's own scope refusal, which is a 403 rather than a 404 — the same decode
     * has to apply to it, or the status a console can act on arrives with a body
     * it cannot read.
     */
    it('forwards a core 403 as JSON too', async () => {
      mocks.proxyToCore.mockResolvedValue(
        coreErrorBytes(403, 'unauthorized', 'This attempt is not on this campaign'),
      );
      const app = await buildApp();

      const res = await app.inject({ method: 'GET', url: RECORDING });

      expect(res.statusCode).toBe(403);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.json().code).toBe('unauthorized');
      await app.close();
    });

    /**
     * The audio headers belong to the success path only. Setting `audio/mpeg` or a
     * `content-length` off a refusal would describe the error body as a recording,
     * and a cache directive would let a transient failure be replayed from the
     * browser's cache as though it were the call.
     */
    it('does not dress a refusal up as audio', async () => {
      mocks.proxyToCore.mockResolvedValue({
        ...coreErrorBytes(404, 'call_purged', 'gone'),
        headers: new Headers({ 'content-type': 'audio/mpeg', 'content-length': '9999' }),
      });
      const app = await buildApp();

      const res = await app.inject({ method: 'GET', url: RECORDING });

      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.headers['cache-control']).toBeUndefined();
      expect(res.json().code).toBe('call_purged');
      await app.close();
    });

    /**
     * A body that is not JSON at all — an upstream HTML error page, say. It must
     * not be forwarded as bytes: there is no code in it to branch on, so
     * forwarding would buy nothing and keep the content type this fix removes.
     * The status survives; the payload becomes an envelope the mask then rewrites.
     */
    it('does not forward a non-JSON upstream body as bytes', async () => {
      mocks.proxyToCore.mockResolvedValue({
        status: 502,
        body: Buffer.from('<html><body>nginx bad gateway</body></html>'),
        headers: new Headers({ 'content-type': 'text/html' }),
      });
      const app = await buildApp();

      const res = await app.inject({ method: 'GET', url: RECORDING });

      expect(res.statusCode).toBe(502);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.body).not.toContain('nginx');
      await app.close();
    });
  });
});

describe('the purged call is forwarded as a 200, not an error', () => {
  /**
   * The attempt→call link is un-FK'd on purpose and both sides purge on
   * independent windows, so an attempt routinely outlives its call. Core answers
   * 200 with `call_availability: 'purged'`; turning that into a 404 here would
   * tell the reader the attempt never happened, which is false and destroys the
   * audit trail the un-FK'd link exists to protect.
   */
  it('keeps the attempt and the marker intact', async () => {
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: purgedBody() });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: DETAIL });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.call_availability).toBe('purged');
    expect(body.call).toBeNull();
    expect(body.attempt.disposition_code).toBe('NOT_INTERESTED');
    expect(body.attempt.notes).toBe('call back next quarter');
    await app.close();
  });

  it('does not crash the field strip on a null call', async () => {
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: purgedBody() });
    setGrants({ recording: false, analytics: false });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: DETAIL });
    expect(res.statusCode).toBe(200);
    expect(res.json().call).toBeNull();
    await app.close();
  });
});

describe('agency.analytics gates the transcript and the summary as fields', () => {
  /**
   * They arrive inside the call object rather than behind their own route, so the
   * enforcement point is a field strip rather than a 403. A tenant without the
   * capability still gets the attempt, the disposition and the notes — which is
   * the point of the surface — just not the conversation.
   */
  it('nulls the analysis content when the capability is off', async () => {
    setGrants({ recording: true, analytics: false });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: DETAIL });
    const call = res.json().call;

    expect(call.call_analysis).toBeNull();
    expect(call.conversation_log).toBeNull();
    expect(call.transcript_meta).toBeNull();
    await app.close();
  });

  /**
   * `analysis_status` says whether analysis ran, not what it found. Keeping it
   * lets the console distinguish "not included in your plan" from the identical
   * blank panel it shows while analysis is still pending.
   */
  it('keeps analysis_status, so existence is not confused with pending', async () => {
    setGrants({ recording: true, analytics: false });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: DETAIL });
    expect(res.json().call.analysis_status).toBe('completed');
    await app.close();
  });

  /**
   * `analysis_sentiment_label` had no coverage at all, which made it deletable in
   * silence — and this list failing open was a blocking finding earlier in this
   * work, so a field-strip entry nothing asserts is exactly the wrong thing to
   * leave here.
   *
   * Core does not send it on this path today. It is on the list because it is a
   * scalar core projects OUT of `call_analysis`: were that projection ever to
   * reach this read, a sentiment label would survive a strip of the very blob it
   * was derived from. The fixture therefore adds the field the strip is written
   * for, rather than asserting the current payload — which is what makes this
   * assertion able to fail when the entry is removed.
   */
  it('nulls analysis_sentiment_label too, though core does not send it here yet', async () => {
    setGrants({ recording: true, analytics: false });
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: {
        ...availableBody(),
        call: { ...availableBody().call, analysis_sentiment_label: 'negative' },
      },
    });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: DETAIL });

    expect(res.json().call.analysis_sentiment_label).toBeNull();
    expect(res.body).not.toContain('negative');
    await app.close();
  });

  /**
   * ─── THE FIELD STRIP FAILS CLOSED ON A SCHEMA ADDITION ────────────────────
   *
   * The envelope check made an unrecognised SHAPE fail closed. This is the same
   * defect one level in: the withheld response used to be a SPREAD of core's
   * whole call object with four known keys nulled, so the day core adds another
   * transcript- or summary-derived field inside the same envelope — a
   * `call_summary`, a `sentiment_score`, a `redaction_report` — it would reach a
   * tenant without `agency.analytics` untouched, and nothing here would go red.
   *
   * The withheld response is now PROJECTED through an allow-list of
   * non-analytics fields, so a field master has not judged is simply not
   * forwarded. These fixtures add fields core does not send today, which is what
   * makes the assertion able to fail: a test written against the current payload
   * could not distinguish a projection from a spread.
   */
  it.each([
    ['a summary field', 'call_summary', 'the customer asked about pricing'],
    ['a scalar score', 'sentiment_score', -0.82],
    ['a nested analysis blob', 'redaction_report', { pii_spans: [{ text: 'ACME Corp' }] }],
    ['a renamed transcript', 'conversation_turns', [{ role: 'agent', text: 'hello' }]],
  ])('withholds %s core adds later, without an entry for it', async (_label, field, value) => {
    setGrants({ recording: true, analytics: false });
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: { ...availableBody(), call: { ...availableBody().call, [field]: value } },
    });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: DETAIL });
    const call = res.json().call;

    expect(res.statusCode).toBe(200);
    // Absent, not null: master cannot claim a field exists that it has never
    // seen. Only the four KNOWN analytics keys get an explicit null.
    expect(field in call).toBe(false);
    // And nothing of it survives anywhere in the payload.
    expect(res.body).not.toContain('pricing');
    expect(res.body).not.toContain('ACME');
    await app.close();
  });

  /**
   * The other half of the projection, and the one that would break the surface if
   * the allow-list were wrong: everything a tenant without analytics is still
   * entitled to has to survive. Pinned field by field against core's
   * `formatWebRtcCallResponse`, because a missed entry here is a blank cell in the
   * console rather than a failure anybody notices.
   */
  it('keeps every non-analytics field when the capability is off', async () => {
    setGrants({ recording: true, analytics: false });
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: {
        ...availableBody(),
        call: {
          ...availableBody().call,
          tenant_id: TENANT,
          account_id: 'account-1',
          caller_id: '+14155550100',
          provider: 'vobiz',
          provider_call_id: 'prov-9',
          outcome: 'answered',
          error_code: null,
          error_message: null,
          initiated_by: 'u-ravi',
          metadata: { station: 'sf-3' },
          recording_requested: true,
          recording_duration_seconds: 61,
          analysis_profile_id: 'profile-1',
          answered_at: '2026-08-24T10:00:00.000Z',
          ended_at: '2026-08-24T10:01:02.000Z',
          duration_seconds: 62,
          talk_time_seconds: 61,
          created_at: '2026-08-24T09:59:00.000Z',
          updated_at: '2026-08-24T10:01:03.000Z',
        },
      },
    });
    const app = await buildApp();

    const call = (await app.inject({ method: 'GET', url: DETAIL })).json().call;

    expect(call).toMatchObject({
      id: 'call-1',
      tenant_id: TENANT,
      account_id: 'account-1',
      caller_id: '+14155550100',
      destination_phone: '+14155550199',
      provider: 'vobiz',
      provider_call_id: 'prov-9',
      status: 'completed',
      outcome: 'answered',
      error_code: null,
      error_message: null,
      initiated_by: 'u-ravi',
      metadata: { station: 'sf-3' },
      recording_requested: true,
      recording_duration_seconds: 61,
      analysis_profile_id: 'profile-1',
      analysis_status: 'completed',
      answered_at: '2026-08-24T10:00:00.000Z',
      ended_at: '2026-08-24T10:01:02.000Z',
      duration_seconds: 62,
      talk_time_seconds: 61,
      created_at: '2026-08-24T09:59:00.000Z',
      updated_at: '2026-08-24T10:01:03.000Z',
    });
    // The repoint still happens on the projected object, not only on the spread.
    expect(call.recording_url)
      .toBe(`/proxy/agency/campaigns/${CAMPAIGN}/attempts/${ATTEMPT}/recording`);
    await app.close();
  });

  /**
   * The asymmetry, stated as a test so it is not read as an oversight. An
   * entitled tenant receives core's object AS SENT — an allow-list on that path
   * would hide new fields from precisely the tenants who bought all of them.
   */
  it('does forward an unknown core field to a tenant that has analytics', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: {
        ...availableBody(),
        call: { ...availableBody().call, call_summary: 'the customer asked about pricing' },
      },
    });
    const app = await buildApp();

    const call = (await app.inject({ method: 'GET', url: DETAIL })).json().call;
    expect(call.call_summary).toBe('the customer asked about pricing');
    await app.close();
  });

  it('leaves the content intact when the capability is on', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: DETAIL });
    const call = res.json().call;

    expect(call.call_analysis).toEqual({ summary: 'customer declined' });
    expect(call.conversation_log).toHaveLength(1);
    await app.close();
  });

  /** ...and the sentiment label rides the same capability, in the other direction. */
  it('leaves analysis_sentiment_label intact when the capability is on', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: {
        ...availableBody(),
        call: { ...availableBody().call, analysis_sentiment_label: 'negative' },
      },
    });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: DETAIL });
    expect(res.json().call.analysis_sentiment_label).toBe('negative');
    await app.close();
  });

  /**
   * A link the tenant may not follow must not be advertised. The media route is
   * the real enforcement; this stops the console rendering a play button that
   * will 403.
   */
  /**
   * ─── THE REDACTION FAILS CLOSED ───────────────────────────────────────────
   *
   * Every other gate in this neighbourhood denies on doubt. A redaction that
   * silently forwards whatever it does not recognise is the one shape of gate
   * that leaks by DEFAULT, and each of these bodies would have sailed straight
   * through a plain `body.call` lookup with the analysis content intact.
   */
  describe('an unrecognised envelope is refused, not forwarded', () => {
    it.each([
      ['an array', [{ call: { conversation_log: [{ text: 'secret' }] } }]],
      ['a bare string', 'not json at all'],
      ['the call nested a level deeper', { data: { call: { conversation_log: ['secret'] } } }],
      ['a call that is an array', { attempt: {}, call: [{ conversation_log: ['secret'] }], call_availability: 'available' }],
      ['a missing call_availability', { attempt: {}, call: { conversation_log: ['secret'] } }],
    ])('502s on %s rather than leaking it', async (_name, body) => {
      mocks.proxyToCore.mockResolvedValue({ status: 200, body });
      const app = await buildApp();

      const res = await app.inject({ method: 'GET', url: DETAIL });

      expect(res.statusCode).toBe(502);
      expect(res.body).not.toContain('secret');
      await app.close();
    });

    /**
     * A non-JSON content type makes the core client fall back to `response.text()`,
     * so a string body is genuinely reachable and not a hypothetical.
     */
    it('502s even when the tenant is fully entitled, because the URL rewrite needs the shape too', async () => {
      setGrants({ recording: true, analytics: true });
      mocks.proxyToCore.mockResolvedValue({ status: 200, body: 'not json at all' });
      const app = await buildApp();

      const res = await app.inject({ method: 'GET', url: DETAIL });
      expect(res.statusCode).toBe(502);
      await app.close();
    });
  });

  /**
   * A governance outage must strip, not leak. `isCapabilityEnabled` returns false
   * on a resolve error by design, so the route sees "not entitled" and withholds —
   * this pins that the route does the withholding rather than treating the failure
   * as a pass.
   */
  it('withholds the transcript when governance resolution fails', async () => {
    // PORT NOTE (magick-agency): the settings read fails (was the governance resolve).
    mocks.findSettings.mockRejectedValue(new Error('redis down'));
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: DETAIL });

    // The route must not 200 with the content, and must not leak it in an error.
    expect(res.body).not.toContain('customer declined');
    await app.close();
  });

  it('nulls recording_url when agency.recording is off', async () => {
    setGrants({ recording: false, analytics: true });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: DETAIL });
    expect(res.json().call.recording_url).toBeNull();
    // ...and the transcript is untouched, because that is the other capability.
    expect(res.json().call.conversation_log).toHaveLength(1);
    await app.close();
  });

  /**
   * Core names a path in ITS address space (`/api/v1/...`), which a browser cannot
   * reach — it only ever talks to master. So the field has to be repointed, and
   * the old assertion here proved nothing: it checked that a fixture the test
   * itself had set to an agency path did not mention `/webrtc-call`. The subject
   * was the fixture, not the code.
   */
  it('repoints recording_url at this service, not core’s own path', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: DETAIL });

    expect(res.json().call.recording_url)
      .toBe(`/proxy/agency/campaigns/${CAMPAIGN}/attempts/${ATTEMPT}/recording`);
    // Core's path must not survive: it is unreachable from a browser.
    expect(res.json().call.recording_url).not.toContain('/api/v1/');
    await app.close();
  });

  /**
   * Built from the request's own params, never by rewriting core's string, so a
   * malformed or hostile value upstream cannot become a URL master hands a
   * browser. Core's value is a presence flag only.
   */
  it('ignores whatever core actually put in recording_url', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: {
        ...availableBody(),
        call: { ...availableBody().call, recording_url: 'https://evil.example/x.wav' },
      },
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: DETAIL });

    expect(res.json().call.recording_url)
      .toBe(`/proxy/agency/campaigns/${CAMPAIGN}/attempts/${ATTEMPT}/recording`);
    await app.close();
  });

  /** ...but null still means "no recording", and that has to survive. */
  it('keeps recording_url null when the call was not recorded', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: { ...availableBody(), call: { ...availableBody().call, recording_url: null } },
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: DETAIL });

    expect(res.json().call.recording_url).toBeNull();
    await app.close();
  });
});

/**
 * ─── NEW (magick-agency): the owning-account settings that replaced governance ──
 *
 * `agency.recording` / `agency.analytics` were governance capabilities resolved for
 * the request's tenant/account. Here they are `allow_recording` / `analyze_calls` on
 * the settings row of the account that OWNS the campaign (plan §3.2; lane A's
 * `campaign-behavioral-settings.ts` interface change 1), read by
 * `resolveOwningAccountGrants` in the route file. These are that function's own cases:
 * whose row is read, NULL / no row = off, and every failure fails closed.
 */
describe('owning-account settings (PORT NOTE: replaces governance)', () => {
  function audio() {
    mocks.proxyToCore.mockResolvedValue({
      status: 200, body: Buffer.from('audio'), headers: new Headers({ 'content-type': 'audio/wav' }),
    });
  }

  it.each([
    ['another account in the same tenant', { tenant_id: TENANT, account_id: 'account-2' }],
    ['another tenant', { tenant_id: '99999999-9999-4999-8999-999999999999', account_id: ACCOUNT }],
  ])('media: a campaign owned by %s answers core\'s 404 without reaching core or reading any row', async (_label, owner) => {
    audio();
    mocks.findCampaign.mockImplementation(async (id: string) => ({ id, ...owner }));
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: RECORDING });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not Found', code: 'campaign_not_found', message: 'Campaign not found' });
    expect(mocks.findSettings).not.toHaveBeenCalled();
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('media: an unknown campaign answers the same 404 without reaching core', async () => {
    audio();
    mocks.findCampaign.mockResolvedValue(null);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: RECORDING });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('campaign_not_found');
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ['no settings row', null],
    ['a NULL allow_recording', { allow_recording: null, analyze_calls: true }],
  ])('media: %s is off (the documented default), so 403', async (_label, row) => {
    audio();
    mocks.findSettings.mockResolvedValue(row);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: RECORDING });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'capability_disabled', capability: 'agency.recording' });
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ['the settings read', () => mocks.findSettings.mockRejectedValue(new Error('db down'))],
    ['the campaign read', () => mocks.findCampaign.mockRejectedValue(new Error('db down'))],
  ])('media: %s failing fails closed with the 403', async (_label, arrange) => {
    audio();
    arrange();
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: RECORDING });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'capability_disabled', capability: 'agency.recording' });
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  // MODIFIED (Phase 8 review): core's observed 400 for the missing account header, not a 403
  // (master's capability resolved at tenant level and core's authMiddleware refused).
  it("media: no account context answers core's 400 without reading anything", async () => {
    audio();
    const app = await buildApp('account_admin', null);

    const res = await app.inject({ method: 'GET', url: RECORDING });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Bad Request', message: 'Missing required header: x-mgkvc-account' });
    expect(mocks.findCampaign).not.toHaveBeenCalled();
    expect(mocks.findSettings).not.toHaveBeenCalled();
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('detail: judges the fields by the campaign row\'s owner, read after core answered', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: DETAIL });

    expect(res.statusCode).toBe(200);
    expect(mocks.findCampaign).toHaveBeenCalledWith(CAMPAIGN);
    expect(mocks.findSettings).toHaveBeenCalledWith(TENANT, ACCOUNT);
    // Resolved after the core call, as master's `isCapabilityEnabled` was: these gate
    // fields on a successful response, not access.
    expect(mocks.proxyToCore.mock.invocationCallOrder[0]!)
      .toBeLessThan(mocks.findSettings.mock.invocationCallOrder[0]!);
    await app.close();
  });

  it('detail: a core refusal is forwarded without reading any settings', async () => {
    mocks.proxyToCore.mockResolvedValue({ status: 404, body: { error: 'Not Found', code: 'campaign_not_found' } });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: DETAIL });

    expect(res.statusCode).toBe(404);
    expect(mocks.findCampaign).not.toHaveBeenCalled();
    expect(mocks.findSettings).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ['no settings row', () => mocks.findSettings.mockResolvedValue(null)],
    ['NULL columns', () => mocks.findSettings.mockResolvedValue({ allow_recording: null, analyze_calls: null })],
    ['the campaign no longer the caller\'s (deleted after core answered)', () => mocks.findCampaign.mockResolvedValue(null)],
    ['a settings read that throws', () => mocks.findSettings.mockRejectedValue(new Error('db down'))],
    ['no account context', () => undefined],
  ])('detail: %s withholds both the analysis content and the recording link', async (label, arrange) => {
    arrange();
    const app = await buildApp('account_admin', label === 'no account context' ? null : ACCOUNT);

    const res = await app.inject({ method: 'GET', url: DETAIL });
    const call = res.json().call;

    expect(res.statusCode).toBe(200);
    expect(call.call_analysis).toBeNull();
    expect(call.conversation_log).toBeNull();
    expect(call.transcript_meta).toBeNull();
    expect(call.recording_url).toBeNull();
    expect(res.body).not.toContain('customer declined');
    // The supervisory read itself survives.
    expect(res.json().attempt.disposition_code).toBe('NOT_INTERESTED');
    await app.close();
  });
});
