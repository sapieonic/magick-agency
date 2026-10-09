import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAgencyCampaign } from './agency-factories.js';
import { DEFAULTS, OTHER_ACCOUNT, OTHER_TENANT } from '../setup/factories.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));

const { agencyCampaignRepository } = await import(
  '../../../src/db/repositories/agency.repository.js'
);

/**
 * ─── Q3's reference check, against a real Postgres ───────────────────────────
 *
 * Two predicates stop a primary-app admin retiring an analysis profile a live
 * agency campaign depends on (`docs/reference/magickvoice-platform/docs/agency-dialer-design.md` §7b, Q3), because
 * there are two ways to depend on one:
 *
 * - `findLiveDependentsOnAnalysisProfile` — campaigns that NAME this profile.
 * - `countLiveCampaignsInheritingAccountDefault` — campaigns that name NOTHING
 *   and so resolve through the account default. `analysis_profile_id` is opt-in
 *   with no column default, so this is the ORDINARY case, not the edge.
 *
 * The unit tier pins the SHAPE of both queries — negated terminal set,
 * tenant/account scoped, narrow projection — but a mocked pool agrees with SQL
 * that matches nothing, and "matches nothing" is exactly how these guards fail
 * silently: every delete succeeds and looks correct.
 *
 * So which rows come back is asserted here, where there are rows.
 *
 * ── The two things a real database adds ──────────────────────────────────────
 *
 * (1) `NOT (status = ANY($n))` over a `VARCHAR` column with a CHECK constraint,
 *     with the array bound as a parameter. The unit test proves the string; only
 *     Postgres proves it plans and that a `text[]` compares against the column.
 * (2) `uq_agency_campaign_running` — ONE running campaign per (tenant, account).
 *     That is why the live arms below use `running` at most once per scope and
 *     reach for `paused` and `stopping` for the rest: a fixture that tried four
 *     running campaigns in one account would fail on the index, not on the
 *     predicate.
 *
 * There is deliberately no foreign key from `agency_campaigns.analysis_profile_id`
 * to `call_analysis_profiles` (§7, migration 076), which is why these fixtures can
 * name a profile id that has no row at all — and why the guard has to be a query
 * rather than a constraint.
 */

const TENANT = DEFAULTS.tenantId;
const ACCOUNT = DEFAULTS.accountId;

describe('findLiveDependentsOnAnalysisProfile — against a real Postgres', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('returns every non-terminal campaign naming the profile, oldest first', async () => {
    const profileId = randomUUID();

    const draft = await insertAgencyCampaign({
      name: 'Draft', status: 'draft', analysis_profile_id: profileId,
    });
    const running = await insertAgencyCampaign({
      name: 'Running', status: 'running', analysis_profile_id: profileId,
    });
    const paused = await insertAgencyCampaign({
      name: 'Paused', status: 'paused', analysis_profile_id: profileId,
    });
    const stopping = await insertAgencyCampaign({
      name: 'Stopping', status: 'stopping', analysis_profile_id: profileId,
    });

    const dependents = await agencyCampaignRepository
      .findLiveDependentsOnAnalysisProfile(profileId, TENANT, ACCOUNT);

    // `draft` matters as much as `running`: nobody has pressed start yet, so the
    // damage from retiring the profile surfaces at the start rather than at the
    // edit that caused it.
    expect(dependents.map((d) => d.id))
      .toEqual([draft.id, running.id, paused.id, stopping.id]);
    expect(dependents.map((d) => d.status))
      .toEqual(['draft', 'running', 'paused', 'stopping']);

    // ── The projection, against real columns ───────────────────────────────
    // These rows reach the route and land, capped to a sample with the true count
    // beside them, in the refusal body's `details.campaigns` — on a surface master
    // gates on `calls.dialer.analytics` ALONE, a caller who may hold no agency
    // entitlement at all. The id crosses deliberately and the name must not, so
    // the row has to be id + status and nothing else. Every fixture above carries a
    // recognisable `name`, and `SELECT *` here would ship that plus
    // `retry_policy`, `disposition_catalog`, `caller_ids`, `sip_connection_id`
    // and `created_by` into a browser error body. The unit tier pins the SELECT
    // list as a string; this pins what Postgres actually hands back for it.
    expect(Object.keys(dependents[0]!).sort()).toEqual(['id', 'status']);
    expect(JSON.stringify(dependents)).not.toContain('Running');
  });

  it('ignores completed and stopped campaigns — their reference is history', async () => {
    const profileId = randomUUID();
    await insertAgencyCampaign({
      name: 'Done', status: 'completed', analysis_profile_id: profileId,
    });
    await insertAgencyCampaign({
      name: 'Halted', status: 'stopped', analysis_profile_id: profileId,
    });

    // Nothing will ever be dialed from either, so the profile they point at
    // records how their calls were analysed. Refusing on those would make a
    // profile permanently undeletable after its first campaign ever finished —
    // which is the shape of guard that gets ripped out six months later.
    expect(await agencyCampaignRepository
      .findLiveDependentsOnAnalysisProfile(profileId, TENANT, ACCOUNT)).toEqual([]);
  });

  it('does not see a live campaign in another tenant or another account', async () => {
    const profileId = randomUUID();
    await insertAgencyCampaign({
      name: 'Other tenant', status: 'running', analysis_profile_id: profileId,
      tenant_id: OTHER_TENANT,
    });
    await insertAgencyCampaign({
      name: 'Other account', status: 'draft', analysis_profile_id: profileId,
      account_id: OTHER_ACCOUNT,
    });

    // Both writers of the column preflight ownership, so a cross-scope reference
    // should not exist at all. If one ever does, the right failure is a delete that
    // proceeds — not a refusal that reads another tenant's campaign rows aloud.
    expect(await agencyCampaignRepository
      .findLiveDependentsOnAnalysisProfile(profileId, TENANT, ACCOUNT)).toEqual([]);
  });

  it('ignores campaigns with no profile and campaigns naming a different one', async () => {
    const profileId = randomUUID();
    await insertAgencyCampaign({ name: 'No profile', status: 'running' });
    await insertAgencyCampaign({
      name: 'Different profile', status: 'draft', analysis_profile_id: randomUUID(),
    });

    // The NULL case is the common one — `analysis_profile_id` is opt-in — and a
    // predicate that caught it HERE would refuse every profile deletion in the
    // account, including profiles nothing has ever pointed at. It is a real
    // dependency all the same, which is why it is a SECOND question with a weaker
    // rule (below) rather than a widening of this one.
    expect(await agencyCampaignRepository
      .findLiveDependentsOnAnalysisProfile(profileId, TENANT, ACCOUNT)).toEqual([]);
  });
});

/**
 * The inheriting half — the case the first draft of the guard missed entirely,
 * and the more destructive of the two. A matched reference survives a retire
 * because the end-of-call gate resolves it through the UNSCOPED `findById`, which
 * ignores `is_active`; an inheritor resolves through `findDefault` (active AND
 * `is_default`) and gets NOTHING once the default is retired, so the snapshot
 * collapses to `{ custom_dimensions: [] }` and analysis carries on with no
 * context and no dimensions, silently.
 *
 * `NULL` is what is being matched on here, which is why a real database earns its
 * keep twice: `analysis_profile_id IS NULL` is the one predicate a mocked pool
 * cannot get wrong-but-green, and `= NULL` — the classic version of this mistake
 * — returns zero rows against Postgres while reading identically in a SQL string.
 */
describe('countLiveCampaignsInheritingAccountDefault — against a real Postgres', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('counts every non-terminal campaign that names no profile', async () => {
    await insertAgencyCampaign({ name: 'Inherits (draft)', status: 'draft' });
    await insertAgencyCampaign({ name: 'Inherits (running)', status: 'running' });
    await insertAgencyCampaign({ name: 'Inherits (paused)', status: 'paused' });
    await insertAgencyCampaign({ name: 'Inherits (stopping)', status: 'stopping' });

    // A count and not rows, unlike the matched case: there is no per-row remedy to
    // point an operator at, because every one of these is fixed by the same single
    // action — leave the account with an active default.
    const inheriting = await agencyCampaignRepository
      .countLiveCampaignsInheritingAccountDefault(TENANT, ACCOUNT);

    // `toBe` and not `toEqual`: the column is `COUNT(*)::text`, so a repository
    // that forgot to cast back hands out `'4'`, which is truthy everywhere the
    // route looks and would refuse and look correct. `Object.is('4', 4)` is false,
    // so this one assertion covers both the count and the type.
    expect(inheriting).toBe(4);
  });

  it('ignores campaigns that name a profile, and terminal ones that name none', async () => {
    await insertAgencyCampaign({
      name: 'Names one', status: 'running', analysis_profile_id: randomUUID(),
    });
    await insertAgencyCampaign({ name: 'Finished', status: 'completed' });
    await insertAgencyCampaign({ name: 'Halted', status: 'stopped' });

    // A campaign that NAMES a profile is the other predicate's business, and the
    // refusal body reports the two counts separately — counting it in both would
    // tell the operator there are more dependents than there are campaigns. A
    // completed campaign inherits nothing going forward: it will never dial again,
    // so what the account's default is now cannot change what it measured.
    expect(await agencyCampaignRepository
      .countLiveCampaignsInheritingAccountDefault(TENANT, ACCOUNT)).toBe(0);
  });

  it('is scoped, so one account\'s inheritors cannot veto another\'s edit', async () => {
    await insertAgencyCampaign({
      name: 'Other tenant', status: 'running', tenant_id: OTHER_TENANT,
    });
    await insertAgencyCampaign({
      name: 'Other account', status: 'running', account_id: OTHER_ACCOUNT,
    });

    // Defaults are per (tenant, account) — `findDefault` is scoped that way — so
    // an unscoped count here would let a busy neighbouring account permanently
    // freeze this one's default, with a refusal its operator could neither act on
    // nor see the cause of.
    expect(await agencyCampaignRepository
      .countLiveCampaignsInheritingAccountDefault(TENANT, ACCOUNT)).toBe(0);
  });

  it('answers 0 — the number, not the string — when nothing inherits', async () => {
    // The route branches on `inheriting === 0`, and `COUNT(*)` always returns a
    // row, so the value here is genuinely `'0'` off the wire. A missing `Number()`
    // leaves it a string: `'0' === 0` is false, and the guard then refuses EVERY
    // delete and every default-clearing edit in every account — including the
    // overwhelming majority that have no agency campaigns at all. A guard that is
    // meant to be inert for most tenants failing closed for all of them is the
    // worst available outcome, and it cannot be caught by any fixture that has
    // dependents in it.
    const inheriting = await agencyCampaignRepository
      .countLiveCampaignsInheritingAccountDefault(TENANT, ACCOUNT);

    expect(inheriting).toBe(0);
  });
});
