import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS } from '../setup/factories.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));

const { agencyCampaignRepository } = await import(
  '../../../src/db/repositories/agency.repository.js'
);

/**
 * ─── `AgencyCampaignRepository.create()`, against a real Postgres ─────────────
 *
 * This method had never touched a database. Two independent blind spots kept it
 * that way, and 1.73.1 shipped a campaign-creation endpoint that failed on every
 * single request:
 *
 *   err_code=42804
 *   column "calling_window_start" is of type time without time zone
 *   but expression is of type text
 *
 * (1) The unit tier mocks the pool, so the SQL string is asserted but never
 *     executed — a query that Postgres refuses to *plan* looks identical to one
 *     that works.
 * (2) Every integration test builds campaigns with the raw `insertRow` factory in
 *     `agency-factories.ts`, which names its own columns and binds bare `$n`
 *     placeholders. That is a completely different statement from this one, and
 *     it is type-correct for exactly the reason this one was not: a bare `$n` in
 *     `VALUES` takes its type from the target column, while a `$n` inside
 *     `COALESCE(...)` takes it from the COALESCE's other argument.
 *
 * So the roster of green agency integration tests was, on this point, evidence
 * about the factory rather than about the repository.
 *
 * ── Why the factory is NOT rerouted through this repository ───────────────────
 * That would close the gap generically, and it was considered and rejected. The
 * factory writes columns `create()` deliberately refuses (`status`, `id`,
 * `contacts_total`) — `agency-migration.test.ts` inserts all six campaign
 * statuses through it, and `update()` cannot write `status` by design — and it
 * passes JSONB overrides pre-stringified, which `create()` would stringify again.
 * Routing it through the repository would mean a second UPDATE per fixture and a
 * rewrite of several suites, to make the fixture path exercise a method the
 * fixture path does not otherwise use. A direct test of the method is the honest
 * shape of that coverage, and it is this file.
 *
 * ── The two arms ─────────────────────────────────────────────────────────────
 * The all-defaults arm is the one that reproduces production: every optional
 * field absent means `$7`/`$8`/`$9` are all NULL, which is precisely when the
 * COALESCE fallback — and therefore the mistyped expression — is reached. The
 * explicit arm proves the cast did not merely silence the error by discarding
 * the caller's values.
 */

const TENANT = DEFAULTS.tenantId;
const ACCOUNT = DEFAULTS.accountId;

describe('AgencyCampaignRepository.create — against a real Postgres', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('creates a campaign with NO optional fields — the case that 42804\'d in 1.73.1', async () => {
    // Exactly what `POST /api/v1/agency-campaigns` sends for a body carrying only
    // `name` and `caller_ids`: three NULL placeholders into three typed columns.
    const campaign = await agencyCampaignRepository.create({
      tenant_id: TENANT,
      account_id: ACCOUNT,
      name: 'Minimal campaign',
      caller_ids: ['+919000000001'],
    });

    expect(campaign.id).toBeTruthy();
    // The COALESCE fallbacks, which must agree with migration 072's column
    // defaults. Postgres renders `TIME` as `HH:MM:SS`.
    expect(campaign.calling_window_start).toBe('09:00:00');
    expect(campaign.calling_window_end).toBe('20:00:00');
    // `SMALLINT[]` — decoded by node-pg to `number[]`, not to the `{1,2,3,4,5}`
    // string the mistyped expression was trying to store.
    expect(campaign.calling_days).toEqual([1, 2, 3, 4, 5]);
    expect(campaign.default_timezone).toBe('UTC');
    expect(campaign.telephony_provider).toBe('voicelink');
    expect(campaign.wrapup_seconds).toBe(30);
    expect(campaign.wrapup_auto_return).toBe(true);
    expect(campaign.record_calls).toBe(false);
    expect(campaign.retry_policy).toEqual({});
    expect(campaign.disposition_catalog).toEqual([]);
    expect(campaign.context_display).toEqual({});
    expect(campaign.status).toBe('draft');
    expect(campaign.analysis_profile_id).toBeNull();
    expect(campaign.abandon_announcement_id).toBeNull();
  });

  it('round-trips explicit values rather than quietly storing the defaults', async () => {
    // The cast must not have been bought by dropping the caller's input on the
    // floor — a fix that made every campaign 09:00–20:00 Mon–Fri would pass the
    // arm above and be a worse defect than the 500 it replaced.
    const campaign = await agencyCampaignRepository.create({
      tenant_id: TENANT,
      account_id: ACCOUNT,
      name: 'Configured campaign',
      caller_ids: ['+919000000001', '+919000000002'],
      telephony_provider: 'twilio',
      calling_window_start: '08:30',
      calling_window_end: '21:45',
      calling_days: [6, 7],
      default_timezone: 'Asia/Kolkata',
      wrapup_seconds: 45,
      wrapup_auto_return: false,
      retry_policy: { no_answer: { max_attempts: 3, backoff_seconds: 600 } },
      disposition_catalog: [{ code: 'sale', label: 'Sale', is_success: true }],
      context_display: { hero: ['First Name'] },
      break_reasons: [{ code: 'lunch', label: 'Lunch' }],
      record_calls: true,
      created_by: 'operator-1',
    });

    // `HH:MM` in, `HH:MM:SS` out — the normalisation `CAMPAIGN_CONFIG_COLUMN_DEFAULTS`
    // and `validateAgencyCampaignConfig` both already assume.
    expect(campaign.calling_window_start).toBe('08:30:00');
    expect(campaign.calling_window_end).toBe('21:45:00');
    expect(campaign.calling_days).toEqual([6, 7]);
    expect(campaign.default_timezone).toBe('Asia/Kolkata');
    expect(campaign.telephony_provider).toBe('twilio');
    expect(campaign.caller_ids).toEqual(['+919000000001', '+919000000002']);
    expect(campaign.wrapup_seconds).toBe(45);
    expect(campaign.wrapup_auto_return).toBe(false);
    expect(campaign.record_calls).toBe(true);
    expect(campaign.retry_policy).toEqual({ no_answer: { max_attempts: 3, backoff_seconds: 600 } });
    expect(campaign.disposition_catalog).toEqual([{ code: 'sale', label: 'Sale', is_success: true }]);
    expect(campaign.context_display).toEqual({ hero: ['First Name'] });
    expect(campaign.created_by).toBe('operator-1');

    // Read back independently of the RETURNING row: a value that only exists in
    // the INSERT's own output would prove nothing about what was stored.
    const reloaded = await agencyCampaignRepository.findById(campaign.id);
    expect(reloaded!.calling_window_start).toBe('08:30:00');
    expect(reloaded!.calling_days).toEqual([6, 7]);

    // 078's column, which the create route never populates today — so the
    // COALESCE fallback is the only path it has, and it is `::jsonb`-cast.
    const { rows } = await getTestPool().query<{ break_reasons: unknown }>(
      'SELECT break_reasons FROM agency_campaigns WHERE id = $1',
      [campaign.id],
    );
    expect(rows[0]!.break_reasons).toEqual([{ code: 'lunch', label: 'Lunch' }]);
  });

  it('update() infers parameter types from the column, which is why config edits always worked', async () => {
    // The asymmetry that made this defect so confusing to triage: `update()`
    // assigns `col = $n`, so Postgres reads the type off the column and a plain
    // string/array binds cleanly into `TIME`/`SMALLINT[]`. Creation was broken
    // from the first release while editing the very same fields was fine.
    const campaign = await agencyCampaignRepository.create({
      tenant_id: TENANT,
      account_id: ACCOUNT,
      name: 'Editable campaign',
      caller_ids: ['+919000000001'],
    });

    const patched = await agencyCampaignRepository.update(campaign.id, {
      calling_window_start: '07:15',
      calling_window_end: '22:30',
      calling_days: [1, 3, 5],
    });

    expect(patched!.calling_window_start).toBe('07:15:00');
    expect(patched!.calling_window_end).toBe('22:30:00');
    expect(patched!.calling_days).toEqual([1, 3, 5]);
  });
});
