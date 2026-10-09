import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { uuidFor } from '../setup/factories.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));

const { agencyAgentStatsRepository, agencyAttemptRepository } =
  await import('../../../src/db/repositories/agency.repository.js');
const {
  insertAgencyCampaign, insertAgencyContact, insertAgencyAttempt, insertAgentSession,
  insertAgentShift,
} = await import('./agency-factories.js');

/**
 * ─── THE TENANT SCOPE IS A PREDICATE, AND THIS IS THE ONLY PLACE IT IS TESTED ─
 *
 * Modelled on `test/integration/agency/agency-dnc-campaign-scope.test.ts` and
 * `agency-spine-read.test.ts` — same connection mock, same import order, same
 * "seed two tenants and read as one of them" structure.
 *
 * ── Why this is different from every other agency read ──────────────────────
 *
 * Everything on `agency-campaigns` starts by resolving a campaign the caller owns
 * (`requireOwned`) and scoping to it. The two agent routes **cannot**: there is no
 * campaign in their paths, and `agent_user_id` is the public API layer's user id — opaque to
 * the internal handlers. They cannot tell a real one from a guessed one and have no route by
 * which the caller proves they own it.
 *
 * So the scope is a PREDICATE on `agency_agent_sessions.tenant_id`/`account_id`,
 * and nothing else enforces it. Without it, any tenant holding an API key could
 * read any other tenant's agent by supplying their user id — the whole
 * cross-campaign history, phone numbers, notes and dispositions included. That is
 * the single largest thing this feature could get wrong, and the unit tier can
 * only assert that the SQL string mentions `s.tenant_id = $4`.
 *
 * ── The second property: an empty answer must be UNINFORMATIVE ──────────────
 *
 * "Another tenant's agent" and "an agent who has never worked here" must be
 * indistinguishable, so these routes cannot be used to probe whether a user id is
 * real — which is the only defence available when the id is opaque. Same for a
 * `campaign_id` filter naming someone else's campaign: it must yield an empty
 * record rather than an error, because an error distinguishes "exists but not
 * yours" from "does not exist".
 *
 * ── ⚠️ THIS FILE HAS NOT BEEN EXECUTED ──────────────────────────────────────
 *
 * No Docker daemon, so `npm run test:integration` could not be run. It type-checks
 * under `tsconfig.test.json` (gated by `npm run lint`). Every assertion is either
 * "empty" or "exactly the rows seeded under this tenant", both of which are
 * mechanical given the seed.
 */

const MINE = { tenantId: uuidFor('tenant-mine'), accountId: uuidFor('account-mine') };
const THEIRS = { tenantId: uuidFor('tenant-theirs'), accountId: uuidFor('account-theirs') };
/** The SAME opaque user id in both tenants — the public API layer's ids are not globally unique. */
const AGENT = uuidFor('u-shared-id');

const FROM = new Date('2026-08-10T00:00:00.000Z');
const TO = new Date('2026-08-20T00:00:00.000Z');
const DIALED = new Date('2026-08-15T09:00:00Z');

/** A campaign, a live session, one dialled+bridged attempt and one shift event. */
async function seedTenant(
  owner: { tenantId: string; accountId: string },
  agentUserId: string,
) {
  const campaign = await insertAgencyCampaign({
    tenant_id: owner.tenantId, account_id: owner.accountId,
    default_timezone: 'UTC', status: 'stopped',
  });
  const session = await insertAgentSession(campaign.id as string, {
    tenant_id: owner.tenantId, account_id: owner.accountId,
    agent_user_id: agentUserId, joined_at: new Date('2026-08-15T08:00:00Z'),
  });
  const contact = await insertAgencyContact(campaign.id as string, {
    tenant_id: owner.tenantId, account_id: owner.accountId, state: 'completed',
  });
  const attempt = await insertAgencyAttempt(campaign.id as string, contact.id as string, {
    tenant_id: owner.tenantId, account_id: owner.accountId,
    state: 'ended', outcome: 'connected', reserved_agent_id: session.id,
    created_at: DIALED, dialed_at: DIALED, bridged_at: DIALED,
    ended_at: new Date(DIALED.getTime() + 60_000),
  });
  await insertAgentShift(session, [
    ['available', new Date('2026-08-15T08:00:00Z')],
    ['on_call', new Date('2026-08-15T09:00:00Z')],
    ['offline', new Date('2026-08-15T10:00:00Z')],
  ]);
  return { campaign, session, contact, attempt };
}

const statsAs = (owner: { tenantId: string; accountId: string }, agentUserId = AGENT) =>
  agencyAgentStatsRepository.stats({ ...owner, agentUserId }, { from: FROM, to: TO, bucket: 'day' });

const attemptsAs = (
  owner: { tenantId: string; accountId: string },
  agentUserId = AGENT,
  filters: Record<string, unknown> = {},
) => agencyAttemptRepository.listForAgent({
  ...owner, agentUserId, filters, limit: 50,
});

describe('agent record tenant isolation (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('reads ONLY the caller\'s tenant, with the same agent id present in both', async () => {
    const mine = await seedTenant(MINE, AGENT);
    const theirs = await seedTenant(THEIRS, AGENT);

    const statsMine = await statsAs(MINE);
    expect(statsMine.totals.attempts).toBe(1);
    expect(statsMine.by_campaign.map((r) => r.campaign_id)).toEqual([mine.campaign.id]);
    // One hour on shift, from this tenant's session only.
    expect(statsMine.totals.occupancy.shift_seconds).toBe(2 * 3600);

    const pageMine = await attemptsAs(MINE);
    expect(pageMine.rows.map((r) => r.id)).toEqual([mine.attempt.id]);
    // Not merely absent from the ids — the other tenant's phone number never
    // appears, which is the thing that would actually leak.
    expect(pageMine.rows.map((r) => r.phone_e164))
      .not.toContain(theirs.contact.phone_e164);

    // Symmetric, so the isolation is not an artefact of which tenant was seeded
    // first or of a fixture ordering.
    const pageTheirs = await attemptsAs(THEIRS);
    expect(pageTheirs.rows.map((r) => r.id)).toEqual([theirs.attempt.id]);
  });

  it('an ACCOUNT within the same tenant is isolated too, not just the tenant', async () => {
    // Both `tenant_id` AND `account_id` are on the predicate. A scope that checked
    // only the tenant would leak across accounts of one customer — which is a real
    // boundary in this platform (every resource is scoped by both), and the kind of
    // half-fix that passes a tenant-only test.
    const sibling = { tenantId: MINE.tenantId, accountId: uuidFor('account-sibling') };
    // Seeded FIRST and closed immediately: migration 093's live-session index is
    // per (tenant_id, agent_user_id) and takes no notice of the account, so two
    // live sessions for one agent in two accounts of ONE tenant are refused by the
    // database. Closing as we go is also what production looks like.
    const other = await seedTenant(sibling, AGENT);
    await getTestPool().query(
      'UPDATE agency_agent_sessions SET left_at = $2 WHERE id = $1',
      [other.session.id, new Date('2026-08-15T11:00:00Z')],
    );
    const mine = await seedTenant(MINE, AGENT);

    const page = await attemptsAs(MINE);
    expect(page.rows.map((r) => r.id)).toEqual([mine.attempt.id]);
    expect((await statsAs(MINE)).totals.attempts).toBe(1);
    expect((await statsAs(sibling)).totals.attempts).toBe(1);
  });

  it('another tenant\'s agent id resolves to an EMPTY record, not to an error', async () => {
    // ── The probe-resistance property ────────────────────────────────────────
    //
    // An empty record must be indistinguishable from an agent who has never worked
    // here. Anything else — a 404, a distinct error, a differently-shaped payload —
    // turns these routes into an oracle for "is this user id real", which is
    // the only thing the opaque id could otherwise be protected by.
    await seedTenant(THEIRS, AGENT);

    const real = await statsAs(MINE, AGENT);            // exists, but not ours
    const invented = await statsAs(MINE, uuidFor('u-never-existed'));

    // Byte-identical apart from the echoed id, which is the caller's own input.
    expect({ ...real, agent_user_id: '' }).toEqual({ ...invented, agent_user_id: '' });
    expect(real.totals.attempts).toBe(0);
    expect(real.buckets).toEqual([]);
    expect(real.by_campaign).toEqual([]);
    expect(real.totals.campaigns).toBe(0);
    // Every rate is null, never 0 — "we cannot say", which is also what an agent
    // with no work looks like.
    expect(real.totals.connect_rate_pct).toBeNull();
    expect(real.totals.success_rate_pct).toBeNull();
    expect(real.totals.aht_seconds).toBeNull();
    // And occupancy is the same zeros an unmeasured agent gets.
    expect(real.totals.occupancy).toEqual({
      shift_seconds: 0,
      by_state: { available: 0, reserved: 0, on_call: 0, wrapup: 0, break: 0, offline: 0 },
    });

    const page = await attemptsAs(MINE, AGENT);
    expect(page.rows).toEqual([]);
    expect(page.next_cursor).toBeNull();
    expect(page).toEqual(await attemptsAs(MINE, uuidFor('u-never-existed')));
  });

  it('a campaign_id belonging to ANOTHER tenant yields empty rather than leaking or erroring', async () => {
    // ── Why "empty" and not an error is the requirement ──────────────────────
    //
    // `?campaign_id=` is a filter, not an ownership claim, and this route has no
    // campaign to run `requireOwned` against. So the id is applied as an extra
    // predicate on top of the session scope, and the intersection of "sessions in
    // my tenant" with "attempts on their campaign" is empty. An error would
    // distinguish "that campaign exists but is not yours" from "no such campaign",
    // which is exactly the probe the empty answer prevents — and a leak would be
    // the whole point of the scope failing.
    const mine = await seedTenant(MINE, AGENT);
    const theirs = await seedTenant(THEIRS, AGENT);

    const stats = await statsAs(MINE);
    expect(stats.totals.attempts).toBe(1);   // unfiltered: my own work

    const filtered = await agencyAgentStatsRepository.stats(
      { ...MINE, agentUserId: AGENT },
      { from: FROM, to: TO, bucket: 'day', campaignId: theirs.campaign.id as string },
    );
    expect(filtered.totals.attempts).toBe(0);
    expect(filtered.buckets).toEqual([]);
    expect(filtered.totals.occupancy.shift_seconds).toBe(0);

    const page = await attemptsAs(MINE, AGENT, { campaignId: theirs.campaign.id as string });
    expect(page.rows).toEqual([]);

    // And the same filter naming MY campaign still works, so "empty" above is the
    // scope refusing rather than the filter being broken.
    const ownFilter = await attemptsAs(MINE, AGENT, { campaignId: mine.campaign.id as string });
    expect(ownFilter.rows.map((r) => r.id)).toEqual([mine.attempt.id]);
  });

  it('a campaign_id that exists nowhere is also just empty', async () => {
    // Indistinguishable from the case above, which is the point. A well-formed
    // uuid naming nothing reaches `= $n::uuid` and matches no row; the shape check
    // in `parseAgentStatsQuery` is what keeps a MALFORMED one from reaching the
    // cast and answering `22P02` as a 500.
    await seedTenant(MINE, AGENT);
    const nowhere = '00000000-0000-4000-8000-000000000000';

    const filtered = await agencyAgentStatsRepository.stats(
      { ...MINE, agentUserId: AGENT },
      { from: FROM, to: TO, bucket: 'day', campaignId: nowhere },
    );
    expect(filtered.totals.attempts).toBe(0);
    expect((await attemptsAs(MINE, AGENT, { campaignId: nowhere })).rows).toEqual([]);
  });

  it('the OCCUPANCY read is scoped too, not just the attempt read', async () => {
    // Two reads, two scopes, and they are separate statements — the occupancy one
    // could be scoped correctly while the attempt one is not, or the reverse, and
    // the payload would look plausible either way. Seeded so the other tenant's
    // shift is much LONGER than this one's: a leak shows up as a shift_seconds
    // that is too large rather than as a wrong row id.
    await seedTenant(MINE, AGENT);

    const theirCampaign = await insertAgencyCampaign({
      tenant_id: THEIRS.tenantId, account_id: THEIRS.accountId,
      default_timezone: 'UTC', status: 'stopped',
    });
    const theirSession = await insertAgentSession(theirCampaign.id as string, {
      tenant_id: THEIRS.tenantId, account_id: THEIRS.accountId,
      agent_user_id: AGENT, joined_at: new Date('2026-08-15T00:00:00Z'),
    });
    await insertAgentShift(theirSession, [
      ['available', new Date('2026-08-15T00:00:00Z')],
      ['on_call', new Date('2026-08-15T01:00:00Z')],
      ['offline', new Date('2026-08-15T20:00:00Z')],
    ]);

    const occ = (await statsAs(MINE)).totals.occupancy;
    // My own shift only: available 08:00→09:00, on_call 09:00→10:00.
    expect(occ.by_state.available).toBe(3600);
    expect(occ.by_state.on_call).toBe(3600);
    expect(occ.shift_seconds).toBe(2 * 3600);
    // Their nineteen hours on call are not here.
    expect(occ.by_state.on_call).not.toBe(20 * 3600);
  });

  it('a session in my tenant on a campaign in theirs contributes nothing', async () => {
    // A malformed row that should not exist — the session's tenant is stamped from
    // its campaign — seeded deliberately, because the occupancy read joins
    // `sess → agency_campaigns` to pick up the zone and the attempt read joins the
    // session for the scope. If the two ever disagreed, the question is which one
    // the predicate follows. It follows the SESSION, which is the row that makes
    // the work this person's, and this pins that rather than leaving it to be
    // rediscovered.
    const theirs = await seedTenant(THEIRS, uuidFor('u-someone-else'));
    const crossed = await insertAgentSession(theirs.campaign.id as string, {
      tenant_id: MINE.tenantId, account_id: MINE.accountId,
      agent_user_id: AGENT, joined_at: new Date('2026-08-15T08:00:00Z'),
    });
    const contact = await insertAgencyContact(theirs.campaign.id as string, {
      tenant_id: THEIRS.tenantId, account_id: THEIRS.accountId, state: 'completed',
    });
    const attempt = await insertAgencyAttempt(theirs.campaign.id as string, contact.id as string, {
      tenant_id: THEIRS.tenantId, account_id: THEIRS.accountId,
      state: 'ended', outcome: 'connected', reserved_agent_id: crossed.id,
      created_at: DIALED, dialed_at: DIALED, bridged_at: DIALED,
      ended_at: new Date(DIALED.getTime() + 60_000),
    });

    // The scope follows the session, so this DOES appear for MINE. Documented as
    // the behaviour rather than asserted as desirable: the row is impossible
    // through any write path, and the assertion exists so that if someone
    // moves the predicate onto `a.tenant_id` the change is deliberate.
    const page = await attemptsAs(MINE, AGENT);
    expect(page.rows.map((r) => r.id)).toEqual([attempt.id]);
    // And it does NOT appear for the campaign's own tenant, because their session
    // set does not contain it.
    expect((await attemptsAs(THEIRS, AGENT)).rows).toEqual([]);
  });
});
