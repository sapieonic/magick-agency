import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/*
 * PORT NOTE (magick-agency): ported from core test/unit/agency/profile-in-use-reference-check.test.ts
 * @4850d1d9. Cases unchanged. The routes take auth and the campaign reference check as
 * options (`ProfileRouteAuth`, `ProfileDependents`; the latter is lane B's
 * `agencyCampaignRepository` at Phase 8), so the suite injects them instead of mocking
 * `auth.middleware` / `agency.repository`; the flag mock is `agency_call_analysis`
 * alone. The prose below describes core.
 */

// ---------------------------------------------------------------------------
// Q3's reference check, at the route: a live agency campaign vetoes retiring the
// analysis profile it depends on.
//
// Analysis profiles stay a SHARED primitive (docs/reference/magickvoice-platform/docs/agency-dialer-design.md §7b,
// Q3) — the softphone attaches one per call, an agency campaign names one in its
// config or names none and inherits the account default — but only the primary
// app can author or retire one, and master gates PUT/DELETE on
// `calls.dialer.analytics` ALONE. So a primary-app admin could take a running
// campaign's analysis definition away, with nothing refusing them and nothing
// telling anyone.
//
// ── TWO dependency classes, and the rule over them is asymmetric ────────────
//
// 1. A campaign NAMING this profile is refused for both verbs: it named that
//    version, so retiring it changes what the campaign measures. What makes that
//    silent rather than merely wrong is the end-of-call gate, which resolves the
//    stamped id with the UNSCOPED `findById` — a deactivated profile is still
//    found and still snapshotted, so the campaign goes on measuring against a
//    definition its operator believes is gone.
// 2. A campaign naming NOTHING inherits whichever profile is the account default
//    (`analysis_profile_id` is opt-in with no column default, so this is the
//    ORDINARY case). It asked for "whatever the default is", so a CHANGE of
//    default is inside what it requested and is allowed; only an operation that
//    leaves the account with NO active default is refused. There the collapse is
//    worse than in case 1: `findDefault` is active + `is_default`, so it returns
//    nothing and the snapshot degrades to `{ custom_dimensions: [] }` — analysis
//    continuing with no context and no dimensions at all.
//
// Concretely, and each of these has a test below: DELETE of the default is
// refused; PUT setting `is_default: false` on it is refused; PUT that OMITS
// `is_default` is allowed, because `update` computes `input.is_default ??
// existing.is_default` and the successor is still the account default.
//
// BOTH mutation routes are covered for class 1, because both deactivate the
// addressed row: DELETE is the soft delete, and PUT is copy-on-write — it retires
// the exact version a campaign points at and inserts a successor under a new id.
// Covering one of the two would leave the same defect reachable through the other.
//
// ── The refusal body carries counts, never campaign names ───────────────────
//
// `AgencyCampaignDependent` is `{ id, status }` by design: this body crosses to a
// caller master gates on `calls.dialer.analytics` alone, who may hold no agency
// entitlement whatsoever, and campaign names are the agency product's vocabulary.
// So the message reports how many and in what statuses, and `details.campaigns`
// carries ids and statuses for a console that DOES hold `agency.analytics` to
// resolve names through the agency surface.
//
// Ids DO cross, then, and that is the decision rather than an accident — an opaque
// UUID discloses that N dependents exist, which the count has already disclosed,
// while a name discloses the agency's clients. It is the smallest disclosure that
// still carries a remedy. And it is bounded: `details.campaigns` is a sample capped
// at `DEPENDENT_SAMPLE_LIMIT` with `campaigns_total` beside it, because the
// population is "every non-terminal campaign naming this profile" and nothing
// prunes it.
//
// ── Why `code` is asserted literally ───────────────────────────────────────
//
// Master's error mask rewrites any core 4xx it cannot recognise into "contact
// support and quote this request id" — useless for a refusal whose entire content
// is the remedy. This body survives the mask TWO independent ways (verified in
// magick-master `src/api/middleware/error-mask.middleware.ts`):
// `profile_in_use_by_agency_campaign` is in `FORWARDABLE_ERROR_CODES` by that
// exact string, and `isStructuredClientError` also passes any body with a
// non-null `details`. Belt and braces on purpose — master's own comment says
// `details.campaigns` is a plausible thing for core to trim later — but the code
// is the one that does not depend on a field core owns, which is why it is pinned
// literally rather than matched loosely.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  isEnabled: vi.fn(),
  profiles: {
    update: vi.fn(),
    softDelete: vi.fn(),
    findActiveSuccessor: vi.fn(),
    findByIdScoped: vi.fn(),
    findActiveByName: vi.fn(),
    listByTenant: vi.fn(),
    create: vi.fn(),
  },
  campaigns: {
    findLiveDependentsOnAnalysisProfile: vi.fn(),
    countLiveCampaignsInheritingAccountDefault: vi.fn(),
  },
}));

vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => ({ isEnabled: mocks.isEnabled }),
  FLAGS: { agency_call_analysis: { key: 'agency_call_analysis', type: 'boolean' } },
}));
vi.mock('../../../src/feature-flags/registry.js', () => ({
  FLAGS: { agency_call_analysis: { key: 'agency_call_analysis', type: 'boolean' } },
}));
vi.mock('@magick-agency/db/repositories/call-analysis-profile.repository', () => ({
  callAnalysisProfileRepository: mocks.profiles,
}));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { callAnalysisProfilesRoutes } from '../../../src/api/routes/call-analysis-profiles.routes.js';

const HEADERS = { 'x-mgkvc-tenant': 't1', 'x-mgkvc-account': 'a1' };
const URL = '/api/v1/call-analysis-profiles/prof-1';

// Dependents as the repository actually projects them: id + status, NO name. The
// shape is the point — see `AgencyCampaignDependent`.
const RUNNING = { id: 'camp-1', status: 'running' };
const DRAFT = { id: 'camp-2', status: 'draft' };

// The addressed row, as `findByIdScoped` returns it. `is_default` is what the
// guard branches on for the inheritance class, so the two variants are named.
const ACTIVE = { id: 'prof-1', name: 'Collections', is_default: false, is_active: true, version: 1 };
const ACTIVE_DEFAULT = { ...ACTIVE, is_default: true };

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.isEnabled.mockResolvedValue(true);
  // The guard looks the addressed row up FIRST and only guards an active one, so
  // every test that expects the guard to run at all needs a row here. The default
  // is the ordinary profile: active, and not the account default — so neither
  // dependency class applies unless a test says so.
  mocks.profiles.findByIdScoped.mockResolvedValue(ACTIVE);
  mocks.campaigns.findLiveDependentsOnAnalysisProfile.mockResolvedValue([]);
  mocks.campaigns.countLiveCampaignsInheritingAccountDefault.mockResolvedValue(0);
  mocks.profiles.softDelete.mockResolvedValue(true);
  mocks.profiles.update.mockResolvedValue({ id: 'prof-1-v2', name: 'Collections', version: 2 });
  app = Fastify({ logger: false });
  await app.register(callAnalysisProfilesRoutes, {
    prefix: '/api/v1/call-analysis-profiles',
    auth: { preHandler: async () => { /* authenticated */ }, getTenantId: () => 't1', getAccountId: () => 'a1' },
    dependents: mocks.campaigns,
  });
  await app.ready();
});

afterEach(async () => { await app.close(); });

describe('DELETE — refused while a live agency campaign depends on the profile', () => {
  it('answers 409 with the allow-listed code and never touches the profile', async () => {
    mocks.campaigns.findLiveDependentsOnAnalysisProfile.mockResolvedValue([RUNNING]);

    const res = await app.inject({ method: 'DELETE', url: URL, headers: HEADERS });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('profile_in_use_by_agency_campaign');
    // The write must not have happened. A refusal that still deletes is worse than
    // no refusal, because the operator now believes the profile survived.
    expect(mocks.profiles.softDelete).not.toHaveBeenCalled();
  });

  it('reports how many depend on it and in what statuses, not which ones', async () => {
    mocks.campaigns.findLiveDependentsOnAnalysisProfile.mockResolvedValue([RUNNING, DRAFT]);

    const res = await app.inject({ method: 'DELETE', url: URL, headers: HEADERS });
    const body = res.json();

    // A count plus a status breakdown, because status is what changes the reader's
    // response — a running campaign and a forgotten draft call for different
    // actions — and it is a closed enum rather than operator-authored text. The
    // count alone ("something depends on this") is not actionable; a list of names
    // is not ours to hand out on this surface.
    expect(body.message).toContain('2 agency campaigns (1 running, 1 draft) use this profile directly');
    // Singular/plural is pinned by the one-dependent tests elsewhere in this file;
    // what is pinned here is that the two statuses are counted separately rather
    // than collapsed into a total, which is the whole value of the breakdown.
    expect(body.details.campaigns).toEqual([RUNNING, DRAFT]);
    // Nothing inherits, so the second class must report zero rather than be
    // omitted: a consumer reading `details.inheriting_account_default` needs the
    // field present on every refusal, and `undefined` is not `0`.
    expect(body.details.inheriting_account_default).toBe(0);
    // `code` clears master's mask by the allow-list; `details` clears it a second,
    // independent way via `isStructuredClientError`. Both are asserted because
    // either one alone would be enough today and the redundancy is deliberate.
    expect(body.error).toBe('Conflict');
    expect(body.details.reason).toBe('profile_in_use_by_agency_campaign');
  });

  it('keeps the message bounded by the status vocabulary, not by the row count', async () => {
    // One running (the index allows only one per account) and 39 drafts, which is
    // what a real account that has been reusing a profile for a year looks like.
    const many = [RUNNING, ...Array.from({ length: 39 }, (_, i) => ({ id: `camp-d${i}`, status: 'draft' }))];
    mocks.campaigns.findLiveDependentsOnAnalysisProfile.mockResolvedValue(many);

    const body = (await app.inject({ method: 'DELETE', url: URL, headers: HEADERS })).json();

    // The string ends up in a toast. Grouping by status means its length is bounded
    // by the number of DISTINCT statuses (four, ever) instead of by the number of
    // campaigns, so 40 dependents read as easily as two. An implementation that
    // enumerated rows would be unreadable here — and would also be leaking
    // per-campaign detail into the message, which is why "no id appears in the
    // message" is asserted rather than a length bound.
    expect(body.message).toContain('40 agency campaigns (1 running, 39 draft) use this profile directly');
    expect(body.message).not.toContain('camp-');
    // The count in the MESSAGE is the true one, not the sample's length. This is
    // the assertion that catches a `LIMIT` pushed down into the repository: the
    // list would shrink and the sentence would quietly understate the refusal.
    expect(body.details.campaigns_total).toBe(40);
  });

  /**
   * `details.campaigns` used to be the whole list, and this test used to pin that
   * — which pinned an unbounded error body. The population is every non-terminal
   * campaign naming the profile, `draft` counts as live, and there is no `DELETE`
   * for an agency campaign anywhere, so an account that has reused one profile
   * across a year of drafts puts thousands of UUIDs into a 409 a browser has to
   * hold. The cap is a sample for a console that can resolve names; the remedy —
   * clone the profile, or re-point them — needs none of them.
   *
   * The total and the explicit `campaigns_truncated` are the load-bearing half: a
   * truncation the reader cannot see is worse than the truncation.
   */
  it('caps the id sample and states the true total and the trim', async () => {
    const many = [RUNNING, ...Array.from({ length: 899 }, (_, i) => ({ id: `camp-d${i}`, status: 'draft' }))];
    mocks.campaigns.findLiveDependentsOnAnalysisProfile.mockResolvedValue(many);

    const body = (await app.inject({ method: 'DELETE', url: URL, headers: HEADERS })).json();

    expect(body.details.campaigns).toHaveLength(20);
    expect(body.details.campaigns_total).toBe(900);
    expect(body.details.campaigns_truncated).toBe(true);
    // The sample is the head of the list the repository ordered (oldest first), not
    // a random slice — so two reads of the same refusal name the same campaigns.
    expect(body.details.campaigns[0]).toEqual(RUNNING);
    // Shape preserved inside the sample: still `{ id, status }`, still no names.
    expect(Object.keys(body.details.campaigns[19]).sort()).toEqual(['id', 'status']);
    // And the message still counts all 900.
    expect(body.message).toContain('900 agency campaigns');
  });

  it('does not claim a trim when there was none', async () => {
    mocks.campaigns.findLiveDependentsOnAnalysisProfile.mockResolvedValue([RUNNING, DRAFT]);

    const body = (await app.inject({ method: 'DELETE', url: URL, headers: HEADERS })).json();

    expect(body.details.campaigns).toEqual([RUNNING, DRAFT]);
    expect(body.details.campaigns_total).toBe(2);
    expect(body.details.campaigns_truncated).toBe(false);
  });

  /**
   * Exactly at the cap, nothing is dropped — so `campaigns_truncated` must be
   * false. An off-by-one here would report a trim that did not happen, which is
   * the same class of lie as hiding one that did.
   */
  it('reports no trim at exactly the cap', async () => {
    const exact = Array.from({ length: 20 }, (_, i) => ({ id: `camp-e${i}`, status: 'draft' }));
    mocks.campaigns.findLiveDependentsOnAnalysisProfile.mockResolvedValue(exact);

    const body = (await app.inject({ method: 'DELETE', url: URL, headers: HEADERS })).json();

    expect(body.details.campaigns).toHaveLength(20);
    expect(body.details.campaigns_total).toBe(20);
    expect(body.details.campaigns_truncated).toBe(false);
  });

  it('deletes as before when nothing live depends on it', async () => {
    const res = await app.inject({ method: 'DELETE', url: URL, headers: HEADERS });

    expect(res.statusCode).toBe(204);
    expect(mocks.profiles.softDelete).toHaveBeenCalledWith('prof-1', 't1', 'a1');
  });

  it('still 404s a profile that is not there, rather than reporting it in use', async () => {
    // `findByIdScoped` is the guard's first act, so a missing (or superseded, or
    // cross-tenant) row means the guard declines to answer and the route gives its
    // ordinary 404. A guard that fired here would report "in use" for a row that
    // does not exist, which is both unhelpful and false.
    mocks.profiles.findByIdScoped.mockResolvedValue(null);
    mocks.profiles.softDelete.mockResolvedValue(false);

    const res = await app.inject({ method: 'DELETE', url: URL, headers: HEADERS });

    expect(res.statusCode).toBe(404);
    expect(mocks.campaigns.findLiveDependentsOnAnalysisProfile).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The inheritance class. This is the half the first draft of the guard missed
// entirely, and it was refusing the benign case while permitting the destructive
// one: a matched reference keeps resolving through the unscoped `findById`, while
// an inheritor's `findDefault` returns nothing the moment the default is retired.
// ───────────────────────────────────────────────────────────────────────────
describe('DELETE — refused when it would leave the account with no default', () => {
  it('409s on the account default with inheritors and NO named dependents', async () => {
    mocks.profiles.findByIdScoped.mockResolvedValue(ACTIVE_DEFAULT);
    mocks.campaigns.findLiveDependentsOnAnalysisProfile.mockResolvedValue([]);
    mocks.campaigns.countLiveCampaignsInheritingAccountDefault.mockResolvedValue(7);

    const res = await app.inject({ method: 'DELETE', url: URL, headers: HEADERS });
    const body = res.json();

    // Zero named dependents is the case the earlier guard permitted: with only the
    // matched predicate, `named.length === 0` and the delete went through, taking
    // seven live campaigns' analysis definition with it.
    expect(res.statusCode).toBe(409);
    expect(body.code).toBe('profile_in_use_by_agency_campaign');
    expect(body.details.inheriting_account_default).toBe(7);
    expect(body.details.campaigns).toEqual([]);
    // No "more" here, deliberately: with zero named dependents this clause opens the
    // sentence, and "7 more rely on it" reads as though a first group were elided.
    expect(body.message).toContain('7 campaigns rely on it as the account default');
    expect(body.message).not.toContain('more');
    expect(mocks.profiles.softDelete).not.toHaveBeenCalled();
  });

  it('deletes a NON-default profile even with inheritors, and does not pay for the count', async () => {
    // Retiring a profile that is not the default cannot affect an inheritor: the
    // default it resolves to is a different row and is untouched. Refusing here
    // would make every profile in an account undeletable as soon as one campaign
    // existed anywhere in it.
    mocks.profiles.findByIdScoped.mockResolvedValue(ACTIVE);
    mocks.campaigns.countLiveCampaignsInheritingAccountDefault.mockResolvedValue(7);

    const res = await app.inject({ method: 'DELETE', url: URL, headers: HEADERS });

    expect(res.statusCode).toBe(204);
    // And the guard short-circuits on `active.is_default` BEFORE asking. This is
    // the common path — most profiles are not the default — so a query spent here
    // is a per-delete cost paid by every account forever, and one nothing would
    // ever surface as a bug. Asserting it was not called is the only way that cost
    // stays deleted.
    expect(mocks.campaigns.countLiveCampaignsInheritingAccountDefault).not.toHaveBeenCalled();
  });

  it('reports both classes in one refusal, with the two counts distinguishable', async () => {
    mocks.profiles.findByIdScoped.mockResolvedValue(ACTIVE_DEFAULT);
    mocks.campaigns.findLiveDependentsOnAnalysisProfile.mockResolvedValue([RUNNING, DRAFT]);
    mocks.campaigns.countLiveCampaignsInheritingAccountDefault.mockResolvedValue(4);

    const body = (await app.inject({ method: 'DELETE', url: URL, headers: HEADERS })).json();

    // ONE 409, not two round trips' worth of refusals, and the operator has to be
    // able to tell the two remedies apart: the named two are re-pointed
    // individually, the four inheritors are all fixed by leaving an active default
    // in place. A message that summed them to "6 campaigns depend on this" would
    // describe neither fix.
    expect(body.message).toContain(
      '2 agency campaigns (1 running, 1 draft) use this profile directly, '
      + 'and 4 more campaigns rely on it as the account default',
    );
    expect(body.details.campaigns).toHaveLength(2);
    expect(body.details.inheriting_account_default).toBe(4);
  });

  it('leaks no campaign name even when the repository hands one back', async () => {
    // `AgencyCampaignDependent` has no `name`, so the narrow SELECT is pinned at
    // the repository tier. What is pinned HERE is that nothing on the route
    // reconstructs one: the guard renders counts and statuses, so a row carrying
    // extra fields cannot become prose. `Q3 Renewals` is chosen to be
    // unmistakable in a diff if it ever appears in the message.
    mocks.campaigns.findLiveDependentsOnAnalysisProfile.mockResolvedValue([
      { id: 'camp-1', status: 'running', name: 'Q3 Renewals' },
    ]);

    const body = (await app.inject({ method: 'DELETE', url: URL, headers: HEADERS })).json();

    expect(body.message).not.toContain('Q3 Renewals');
    expect(body.message).not.toContain('camp-1');
    // The status breakdown is what appears in its place — the severity signal,
    // without the agency product's vocabulary.
    expect(body.message).toContain('1 agency campaign (1 running) uses this profile directly');
  });
});

describe('PUT — copy-on-write retires the referenced version, so it is refused too', () => {
  it('answers 409 with the same code and does not write a new version', async () => {
    mocks.campaigns.findLiveDependentsOnAnalysisProfile.mockResolvedValue([RUNNING]);

    const res = await app.inject({
      method: 'PUT', url: URL, headers: HEADERS, payload: { context: 'new context' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('profile_in_use_by_agency_campaign');
    // Not refusing here would leave the campaign pointing at the row this PUT
    // deactivated — the same dangling reference DELETE is guarded against, reached
    // through the other door.
    expect(mocks.profiles.update).not.toHaveBeenCalled();
  });

  it('tells the operator that SAVING is what retires the row, not just deleting', async () => {
    // The same helper serves both verbs, and the sentence has to differ. Someone
    // who pressed Delete knows what they asked for; someone who edited a
    // description does not know the save retires the version they are looking at,
    // so a remedy phrased around "deleting" describes an action they never took
    // and they retry the identical save. Pin both wordings, because one shared
    // string is exactly how this collapses back to the confusing version.
    mocks.campaigns.findLiveDependentsOnAnalysisProfile.mockResolvedValue([RUNNING]);

    const put = (await app.inject({
      method: 'PUT', url: URL, headers: HEADERS, payload: { context: 'new context' },
    })).json();
    const del = (await app.inject({ method: 'DELETE', url: URL, headers: HEADERS })).json();

    expect(put.message).toContain('Saving replaces this profile with a new version');
    expect(put.message).not.toContain('before deleting it');
    expect(del.message).toContain('before deleting it');
    expect(del.message).not.toContain('Saving replaces');
    // Both still report the dependency identically — the verb changes, the
    // description of what depends on the profile does not.
    expect(put.message).toContain('1 agency campaign (1 running) uses this profile directly');
    expect(del.message).toContain('1 agency campaign (1 running) uses this profile directly');
  });

  it('a draft campaign is enough to refuse — its reference has not been used yet', async () => {
    mocks.campaigns.findLiveDependentsOnAnalysisProfile.mockResolvedValue([DRAFT]);

    const res = await app.inject({
      method: 'PUT', url: URL, headers: HEADERS, payload: { context: 'new context' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().details.campaigns).toEqual([DRAFT]);
  });

  it('refuses before the write but after the body parse', async () => {
    mocks.campaigns.findLiveDependentsOnAnalysisProfile.mockResolvedValue([RUNNING]);

    // A body that is going to be refused anyway should not spend a DB read first,
    // and a malformed one must still read as malformed rather than as in-use.
    const res = await app.inject({
      method: 'PUT', url: URL, headers: HEADERS, payload: { context: 'x'.repeat(2001) },
    });

    expect(res.statusCode).toBe(400);
    // Neither of the guard's two reads, nor the lookup that precedes them.
    expect(mocks.profiles.findByIdScoped).not.toHaveBeenCalled();
    expect(mocks.campaigns.findLiveDependentsOnAnalysisProfile).not.toHaveBeenCalled();
    expect(mocks.campaigns.countLiveCampaignsInheritingAccountDefault).not.toHaveBeenCalled();
  });

  it('updates as before when nothing live depends on it', async () => {
    const res = await app.inject({
      method: 'PUT', url: URL, headers: HEADERS, payload: { context: 'new context' },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.profiles.update).toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The asymmetry, at the PUT route. An inheritor asked for "whatever the default
// is", so it is entitled to object to LOSS of a default and not to a CHANGE of
// one. Both halves are pinned, because the interesting failure is in the
// permissive direction: refusing an ordinary save is loud and gets reported,
// while over-refusing gets "fixed" by deleting the guard.
// ───────────────────────────────────────────────────────────────────────────
describe('PUT — the inheritance rule turns on whether a default survives', () => {
  it('409s when the save clears `is_default` on the account default', async () => {
    mocks.profiles.findByIdScoped.mockResolvedValue(ACTIVE_DEFAULT);
    mocks.campaigns.countLiveCampaignsInheritingAccountDefault.mockResolvedValue(3);

    const res = await app.inject({
      method: 'PUT', url: URL, headers: HEADERS, payload: { is_default: false },
    });

    // `update` computes `input.is_default ?? existing.is_default`, so an explicit
    // `false` writes a successor that is NOT the default and deactivates the row
    // that was — leaving `findDefault` with nothing and three campaigns analysing
    // against `{ custom_dimensions: [] }`. This is a DELETE of the account default
    // wearing a PUT's clothes, and it is refused as one.
    expect(res.statusCode).toBe(409);
    expect(res.json().details.inheriting_account_default).toBe(3);
    expect(mocks.profiles.update).not.toHaveBeenCalled();
  });

  it('SUCCEEDS when the save omits `is_default` — the successor stays the default', async () => {
    mocks.profiles.findByIdScoped.mockResolvedValue(ACTIVE_DEFAULT);
    mocks.campaigns.countLiveCampaignsInheritingAccountDefault.mockResolvedValue(3);

    const res = await app.inject({
      method: 'PUT', url: URL, headers: HEADERS, payload: { context: 'sharper context' },
    });

    // THE asymmetry, and the test that has to exist so nobody "fixes" the guard
    // into refusing this. An omitted flag is carried forward by
    // `input.is_default ?? existing.is_default`, so the successor is active and
    // default and every inheritor resolves it exactly as before. Refusing would
    // mean the account default becomes permanently uneditable the moment one
    // campaign exists — the outcome that gets a guard removed wholesale, and it
    // would be reached by writing `!parsed.data.is_default` instead of
    // `parsed.data.is_default === false`.
    expect(res.statusCode).toBe(200);
    expect(mocks.profiles.update).toHaveBeenCalled();
    // And it costs nothing: `clearsAccountDefault` is false, so the count is never
    // asked for on the ordinary edit path.
    expect(mocks.campaigns.countLiveCampaignsInheritingAccountDefault).not.toHaveBeenCalled();
  });

  it('still refuses a NAMED dependent on a save that keeps the default', async () => {
    // The two classes are independent: carrying `is_default` forward rescues the
    // inheritors and does nothing for a campaign that named THIS version, which is
    // being retired either way. A guard that folded the two rules into one would
    // let this through.
    mocks.profiles.findByIdScoped.mockResolvedValue(ACTIVE_DEFAULT);
    mocks.campaigns.findLiveDependentsOnAnalysisProfile.mockResolvedValue([RUNNING]);

    const res = await app.inject({
      method: 'PUT', url: URL, headers: HEADERS, payload: { context: 'sharper context' },
    });
    const body = res.json();

    expect(res.statusCode).toBe(409);
    expect(body.details.campaigns).toEqual([RUNNING]);
    expect(body.details.inheriting_account_default).toBe(0);
    // The inheritance clause must be absent, not zero-valued prose: "and 0 more
    // rely on it" would send the operator looking for campaigns that do not exist.
    expect(body.message).not.toContain('account default');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Only the ACTIVE version is guarded, and that ordering is load-bearing.
// ───────────────────────────────────────────────────────────────────────────
describe('a superseded or missing version falls through to the ordinary answer', () => {
  it('gives the stale-version 409 with a successor id, not "in use"', async () => {
    // A stale tab saving an old version. `findByIdScoped` is active-only, so it
    // returns null and the guard declines — even though live campaigns still name
    // the lineage. Guarding here would replace the ONE signal a stale tab can
    // recover from (`details.current_profile_id`) with a refusal that is also
    // false: saving a row that is already retired changes nothing for anybody.
    mocks.profiles.findByIdScoped.mockResolvedValue(null);
    mocks.campaigns.findLiveDependentsOnAnalysisProfile.mockResolvedValue([RUNNING]);
    mocks.profiles.update.mockResolvedValue(null);
    mocks.profiles.findActiveSuccessor.mockResolvedValue({ id: 'prof-1-v2' });

    const res = await app.inject({
      method: 'PUT', url: URL, headers: HEADERS, payload: { context: 'new context' },
    });
    const body = res.json();

    expect(res.statusCode).toBe(409);
    expect(body.details.reason).toBe('stale_profile_version');
    expect(body.details.current_profile_id).toBe('prof-1-v2');
    expect(body.code).toBeUndefined();
    // Not merely "the guard did not refuse" — it did not even ask. The dependents
    // query is the expensive half and there is nothing it could change here.
    expect(mocks.campaigns.findLiveDependentsOnAnalysisProfile).not.toHaveBeenCalled();
    expect(mocks.campaigns.countLiveCampaignsInheritingAccountDefault).not.toHaveBeenCalled();
  });

  it('gives the plain 404 when there is no successor either', async () => {
    mocks.profiles.findByIdScoped.mockResolvedValue(null);
    mocks.campaigns.findLiveDependentsOnAnalysisProfile.mockResolvedValue([RUNNING]);
    mocks.profiles.update.mockResolvedValue(null);
    mocks.profiles.findActiveSuccessor.mockResolvedValue(null);

    const res = await app.inject({
      method: 'PUT', url: URL, headers: HEADERS, payload: { context: 'new context' },
    });

    // A cross-tenant id lands here too, and "this profile is in use by a campaign"
    // would confirm the row exists to a caller who is not entitled to know it.
    expect(res.statusCode).toBe(404);
    expect(mocks.campaigns.findLiveDependentsOnAnalysisProfile).not.toHaveBeenCalled();
  });
});

describe('the guard sits behind the feature gate, not in front of it', () => {
  it('does not query agency_campaigns when dialer analysis is off', async () => {
    // The flag 403 is the account's answer to this whole surface. Asking which
    // campaigns depend on a profile the caller may not read is a round trip spent
    // to tell them something they are not entitled to.
    mocks.isEnabled.mockResolvedValue(false);

    for (const method of ['PUT', 'DELETE'] as const) {
      const res = await app.inject({ method, url: URL, headers: HEADERS, payload: {} });
      expect(res.statusCode).toBe(403);
    }
    expect(mocks.campaigns.findLiveDependentsOnAnalysisProfile).not.toHaveBeenCalled();
    expect(mocks.campaigns.countLiveCampaignsInheritingAccountDefault).not.toHaveBeenCalled();
  });
});
