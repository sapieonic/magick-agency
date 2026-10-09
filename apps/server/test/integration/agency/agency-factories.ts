import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getTestPool } from '../setup/test-utils.js';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { DEFAULTS as DB_DEFAULTS } from '../../../../../packages/db/test/integration/setup/factories.js';

/*
 * PORT NOTE (magick-agency, lane B1): ported from core
 * test/integration/agency/agency-factories.ts@4850d1d9. Recorded changes:
 *  - tenant/account defaults are the shared UUIDs (core used 'test-tenant' /
 *    'test-account'; the baseline types every tenant/account/agent id UUID);
 *  - `agent_user_id` defaults to a fresh UUID (was `agent-<hex>`);
 *  - campaign `telephony_provider` 'vobiz' → 'voicelink' (VoBiz deleted);
 *  - `createContentionPool` reads the agency harness URL (5436), never core's 5433.
 */

/**
 * Agency dialer test factories, in the style of `test/integration/setup/factories.ts`.
 *
 * Kept in the agency folder rather than the shared factories file because the
 * agency tables are the only ones several of these helpers know about, and the
 * shared file is edited by everyone.
 */

const DEFAULTS = {
  tenantId: DB_DEFAULTS.tenantId,
  accountId: DB_DEFAULTS.accountId,
} as const;

/**
 * Reaper deps meaning **"nothing on this replica is alive"** (`AD-P2-C-08`).
 *
 * `AgencyReaper` requires its liveness deps, and every caller here wants the same
 * answer: these suites drive recovery from rows in Postgres, with no live dialer
 * and no station socket, so an empty live set and a null owner are the *truthful*
 * answers rather than a convenience.
 *
 * ── Why the constructor has no default, given every caller here passes this ───
 * Because an inert default is indistinguishable from a working guard at the point
 * it matters. `activeAttemptIds: () => []` + `ownerOf: async () => null` means
 * "reap everything", which is precisely the defect `AD-P2-C-08` fixed — the sweep
 * used to consult no liveness signal at all and hung up on live conversations. A
 * default would hand that behaviour to any future caller who forgot the deps, in
 * silence.
 *
 * Worse, it would have kept two tests in this very directory **green while
 * blind**: `agency-crash-recovery.test.ts`'s sweep case and
 * `attempt-number-collision.test.ts`'s both assert `sweepOnce()` reaps, which an
 * inert default satisfies perfectly. A compile error that names its callers is a
 * better guard than a default that hides them — the same trade as
 * `no_balance_row`: never make a distinguishable failure look like success where
 * it is consumed.
 *
 * So a test that genuinely means "nothing is alive" says so, here, once.
 */
export function noLiveAttempts(): {
  activeAttemptIds: () => string[];
  ownerOf: (sessionId: string) => Promise<string | null>;
} {
  return { activeAttemptIds: () => [], ownerOf: async () => null };
}

async function insertRow(table: string, merged: Record<string, unknown>, pool?: pg.Pool) {
  const cols = Object.keys(merged);
  const vals = Object.values(merged);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await (pool ?? getTestPool()).query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    vals,
  );
  return rows[0];
}

export async function insertAgencyCampaign(overrides: Record<string, unknown> = {}) {
  return insertRow('agency_campaigns', {
    id: randomUUID(),
    tenant_id: DEFAULTS.tenantId,
    account_id: DEFAULTS.accountId,
    name: `campaign-${randomUUID().slice(0, 8)}`,
    caller_ids: ['+919000000001'],
    telephony_provider: 'voicelink',
    status: 'draft',
    // ── An ALL-DAY, EVERY-DAY calling window, deliberately not the column
    //    defaults (`AD-P3-C-06`).
    //
    // Migration 072 defaults to 09:00–20:00 Mon–Fri, and there is now a pre-dial
    // calling-hours gate. A fixture carrying those defaults makes every dialing
    // integration test depend on **what time of day and what day of the week the
    // suite runs** — green on a Tuesday afternoon, silently dialing nothing on a
    // Saturday or after 20:00, and the symptom is zero dials rather than an error.
    // That is the worst available failure: it looks like a pacing bug and it
    // reproduces only outside office hours.
    //
    // `24:00:00` rather than `23:59:59`: the latter leaves a one-second hole at the
    // end of every day, which is a flake that fires once a day and looks like
    // anything but a clock. Postgres' `TIME` accepts the sentinel.
    //
    // A test that is ABOUT calling hours should override these explicitly.
    calling_window_start: '00:00:00',
    calling_window_end: '24:00:00',
    calling_days: [1, 2, 3, 4, 5, 6, 7],
    default_timezone: 'UTC',
    ...overrides,
  });
}

export async function insertAgencyContact(campaignId: string, overrides: Record<string, unknown> = {}) {
  return insertRow('agency_contacts', {
    id: randomUUID(),
    campaign_id: campaignId,
    tenant_id: DEFAULTS.tenantId,
    account_id: DEFAULTS.accountId,
    phone_e164: `+9198${Math.floor(Math.random() * 100_000_000).toString().padStart(8, '0')}`,
    context: JSON.stringify({ name: 'Test Person' }),
    state: 'pending',
    ...overrides,
  });
}

/** N contacts, all immediately dialable, with distinct source_row_numbers. */
export async function insertAgencyContacts(
  campaignId: string,
  n: number,
  overrides: Record<string, unknown> = {},
) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(await insertAgencyContact(campaignId, { source_row_number: i + 1, ...overrides }));
  }
  return out;
}

export async function insertAgentSession(campaignId: string, overrides: Record<string, unknown> = {}) {
  return insertRow('agency_agent_sessions', {
    id: randomUUID(),
    tenant_id: DEFAULTS.tenantId,
    account_id: DEFAULTS.accountId,
    campaign_id: campaignId,
    agent_user_id: randomUUID(),
    state: 'available',
    ...overrides,
  });
}

/**
 * One row of the agent state-transition log (migration 105).
 *
 * ── `at` is REQUIRED here, unlike in the table ──────────────────────────────
 *
 * Migration 105 gives `at` a `DEFAULT now()`, and the production writer never
 * uses it: `recordTransitions` carries `clock_timestamp()` projected by the UPDATE
 * that performed the transition, because the log INSERT is a second statement and
 * two racing transitions can reach it in the opposite order to the one the
 * database applied. A fixture that leaned on the DEFAULT would stamp every event
 * of a seeded shift with the same transaction timestamp — so `lead(at)` would
 * difference a pile of zero-length intervals and every occupancy assertion would
 * read 0 while looking like it had seeded a shift. The parameter is positional and
 * required so that cannot happen by omission.
 *
 * `from_state` defaults to NULL, which is what the join upsert writes for a
 * session's first transition and is therefore the right default for the first
 * event a test seeds.
 *
 * `campaign_id`, `tenant_id`, `account_id` and `agent_user_id` are denormalised on
 * the real table and taken from the session row here for the same reason the
 * writer copies them: the occupancy read predicates on `e.agent_user_id`, which is
 * the only thing that makes `idx_agency_session_events_agent` reachable. A fixture
 * that left them to a default would silently test an unindexed path.
 */
export async function insertAgentSessionEvent(
  session: { id: string; campaign_id: string; tenant_id: string; account_id: string; agent_user_id: string },
  toState: string,
  at: Date,
  overrides: Record<string, unknown> = {},
) {
  return insertRow('agency_agent_session_events', {
    id: randomUUID(),
    session_id: session.id,
    tenant_id: session.tenant_id,
    account_id: session.account_id,
    campaign_id: session.campaign_id,
    agent_user_id: session.agent_user_id,
    from_state: null,
    to_state: toState,
    at,
    ...overrides,
  });
}

/**
 * A whole shift as a chain of transitions, returned in order.
 *
 * `steps` is `[state, at]` pairs. `from_state` is threaded from the previous step
 * — NULL on the first, exactly as the join upsert writes it — so the seeded log
 * is shaped like one the writer would have produced rather than like a bag of
 * rows. That matters for any assertion about `from_state IS NULL` being the
 * session-start marker, and it costs nothing here.
 */
export async function insertAgentShift(
  session: { id: string; campaign_id: string; tenant_id: string; account_id: string; agent_user_id: string },
  steps: readonly (readonly [state: string, at: Date])[],
) {
  const out = [];
  let previous: string | null = null;
  for (const [state, at] of steps) {
    out.push(await insertAgentSessionEvent(session, state, at, { from_state: previous }));
    previous = state;
  }
  return out;
}

export async function insertAgencyAttempt(
  campaignId: string,
  contactId: string,
  overrides: Record<string, unknown> = {},
) {
  return insertRow('agency_call_attempts', {
    id: randomUUID(),
    campaign_id: campaignId,
    contact_id: contactId,
    tenant_id: DEFAULTS.tenantId,
    account_id: DEFAULTS.accountId,
    attempt_number: 1,
    caller_id: '+919000000001',
    state: 'queued',
    ...overrides,
  });
}

/**
 * A dedicated pool for contention tests.
 *
 * The shared `getTestPool()` is capped at `max: 10` and other integration files
 * depend on that ceiling staying small, so a test that wants more genuinely
 * concurrent transactions than that must bring its own. Always `end()` it.
 */
export function createContentionPool(max: number): pg.Pool {
  return new pg.Pool({ connectionString: TEST_DB_URL, max, idleTimeoutMillis: 5_000 });
}

/** The §4.1 claim query, verbatim, for tests that must drive it by hand. */
export const CLAIM_SQL = `
  UPDATE agency_contacts SET state = 'in_flight', updated_at = now()
    WHERE id IN (
      SELECT id FROM agency_contacts
       WHERE campaign_id = $1 AND state = 'pending' AND next_attempt_at <= now()
       ORDER BY next_attempt_at
         FOR UPDATE SKIP LOCKED
       LIMIT $2
    )
  RETURNING *`;

/** Just the SELECT half, so a test can hold the row lock without mutating it. */
export const CLAIM_SELECT_SQL = `
  SELECT id FROM agency_contacts
   WHERE campaign_id = $1 AND state = 'pending' AND next_attempt_at <= now()
   ORDER BY next_attempt_at
     FOR UPDATE SKIP LOCKED
   LIMIT $2`;
