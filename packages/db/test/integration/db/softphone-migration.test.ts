// Real Postgres: migrations/0005_softphone.sql (docs/softphone.md §3). globalSetup has applied
// every migration. The CHECK vocabularies are pinned to the contract's runtime lists, so a member
// added to a union in packages/contracts/src/agency/softphone.ts without a migration fails here
// rather than as a refused write in production; the invariants are each asserted from both sides.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import {
  AGENCY_MANUAL_CALL_DISPOSITION_SOURCES,
  AGENCY_MANUAL_CALL_END_REASONS,
  AGENCY_MANUAL_CALL_OUTCOMES,
  AGENCY_MANUAL_CALL_STATES,
  AGENCY_SESSION_KINDS,
  SOFTPHONE_CALL_FIELDS_MAX,
  SOFTPHONE_OVERRIDE_NOTE_MAX,
  SOFTPHONE_OVERRIDE_NOTE_MIN,
} from '@magick-agency/contracts/agency';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import {
  ACCOUNT,
  TENANT,
  insertCall,
  insertCampaign,
  insertManualCall,
  insertRow,
  insertSession,
  insertSoftphoneSession,
} from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(truncateAll);
// 0005's Down refuses while a soft-phone session exists, so leave none behind for the
// down → up suite.
afterAll(async () => {
  await truncateAll();
  await closeTestPool();
});

async function indexDef(name: string): Promise<string | undefined> {
  const { rows } = await pool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
    [name],
  );
  return rows[0]?.indexdef;
}

/** The plan for `sql` with sequential scans priced out (see attempt-indexes-migration.test.ts). */
async function planOf(sql: string): Promise<string> {
  const client: PoolClient = await pool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${sql}`);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const check = (constraint: string) => ({ code: '23514', constraint });

describe('0005 — agency_agent_sessions.kind', () => {
  it('defaults to campaign; the CHECK takes exactly the contract kinds', async () => {
    const campaign = await insertCampaign();
    expect((await insertSession(campaign.id)).kind).toBe('campaign');
    for (const kind of AGENCY_SESSION_KINDS) {
      const row = kind === 'campaign'
        ? await insertSession(campaign.id, { kind })
        : await insertSoftphoneSession({ kind });
      expect(row.kind).toBe(kind);
    }
    await expect(insertSoftphoneSession({ kind: 'preview' })).rejects.toMatchObject(check('ck_agency_agent_session_kind'));
  });

  it('a campaign session names a campaign and a soft-phone session never does', async () => {
    const campaign = await insertCampaign();
    await expect(insertSession(campaign.id, { campaign_id: null })).rejects.toMatchObject(
      check('ck_agency_agent_session_kind_campaign'),
    );
    await expect(insertSoftphoneSession({ campaign_id: campaign.id })).rejects.toMatchObject(
      check('ck_agency_agent_session_kind_campaign'),
    );
    const session = await insertSoftphoneSession();
    expect(session.campaign_id).toBeNull();
    // Its event rows carry the same NULL.
    await expect(insertRow('agency_agent_session_events', {
      session_id: session.id, tenant_id: TENANT, account_id: ACCOUNT, campaign_id: null,
      agent_user_id: session.agent_user_id, to_state: 'break', break_reason: 'soft_phone',
    })).resolves.toBeTruthy();
  });

  it('a soft-phone session can only be on break or offline, never in the pool', async () => {
    for (const state of ['break', 'offline']) {
      await expect(insertSoftphoneSession({ state })).resolves.toBeTruthy();
    }
    for (const state of ['available', 'reserved', 'on_call', 'wrapup']) {
      await expect(insertSoftphoneSession({ state })).rejects.toMatchObject(check('ck_agency_agent_session_softphone_state'));
    }
    const session = await insertSoftphoneSession();
    await expect(pool().query(`UPDATE agency_agent_sessions SET state = 'available' WHERE id = $1`, [session.id]))
      .rejects.toMatchObject(check('ck_agency_agent_session_softphone_state'));
    // A campaign session on the soft phone is still a campaign session: every state stays open to it.
    const campaign = await insertCampaign();
    await expect(insertSession(campaign.id, { state: 'available' })).resolves.toBeTruthy();
  });

  it('uq_agency_agent_live_tenant spans both kinds: one pair of ears', async () => {
    const agent = randomUUID();
    const campaign = await insertCampaign();
    await insertSession(campaign.id, { agent_user_id: agent });
    await expect(insertSoftphoneSession({ agent_user_id: agent })).rejects.toMatchObject({
      code: '23505', constraint: 'uq_agency_agent_live_tenant',
    });
    await pool().query(`UPDATE agency_agent_sessions SET left_at = now(), state = 'offline' WHERE agent_user_id = $1`, [agent]);
    await expect(insertSoftphoneSession({ agent_user_id: agent })).resolves.toBeTruthy();
  });
});

describe('0005 — agency_manual_calls', () => {
  it('state, outcome and end_reason CHECKs take exactly the contract lists', async () => {
    const session = await insertSoftphoneSession();
    // One settled row per value, so the one-unsettled-per-session index stays out of the way.
    const settled = { state: 'ended', ended_at: new Date(), settled_at: new Date() };
    for (const state of AGENCY_MANUAL_CALL_STATES) {
      const ended = state === 'ended';
      await insertManualCall(session.id, { state, ended_at: ended ? new Date() : null, settled_at: ended ? new Date() : null });
      if (!ended) await pool().query(`DELETE FROM agency_manual_calls WHERE session_id = $1 AND settled_at IS NULL`, [session.id]);
    }
    await expect(insertManualCall(session.id, { state: 'hangup' })).rejects.toMatchObject(check('ck_agency_manual_call_state'));

    for (const outcome of AGENCY_MANUAL_CALL_OUTCOMES) await insertManualCall(session.id, { ...settled, outcome });
    await expect(insertManualCall(session.id, { ...settled, outcome: 'voicemail' })).rejects.toMatchObject(
      check('ck_agency_manual_call_outcome'),
    );

    for (const end_reason of AGENCY_MANUAL_CALL_END_REASONS) await insertManualCall(session.id, { ...settled, end_reason });
    // A campaign-lifecycle release reason cannot happen to a call outside pacing.
    await expect(insertManualCall(session.id, { ...settled, end_reason: 'campaign_paused' })).rejects.toMatchObject(
      check('ck_agency_manual_call_end_reason'),
    );
  });

  it('disposition_source: campaign only on a tagged call, softphone only on an untagged one', async () => {
    const session = await insertSoftphoneSession();
    const settled = { state: 'ended', ended_at: new Date(), settled_at: new Date(), disposition_code: 'x' };
    const tag = randomUUID();
    for (const source of AGENCY_MANUAL_CALL_DISPOSITION_SOURCES) {
      await insertManualCall(session.id, { ...settled, disposition_source: source, campaign_id: source === 'campaign' ? tag : null });
    }
    for (const [disposition_source, campaign_id] of [['campaign', null], ['softphone', tag], ['station', tag]] as const) {
      await expect(insertManualCall(session.id, { ...settled, disposition_source, campaign_id })).rejects.toMatchObject(
        check('ck_agency_manual_call_disposition_source'),
      );
    }
  });

  it('a contact match needs a tag, and a claim needs the contact and its prior state', async () => {
    const session = await insertSoftphoneSession();
    const settled = { state: 'ended', ended_at: new Date(), settled_at: new Date() };
    const tag = randomUUID();
    await insertManualCall(session.id, { ...settled, campaign_id: tag, contact_id: randomUUID(), contact_claimed: true, contact_prior_state: 'pending' });
    await insertManualCall(session.id, { ...settled, campaign_id: tag, contact_id: randomUUID(), contact_prior_state: 'completed' });
    await expect(insertManualCall(session.id, { ...settled, contact_id: randomUUID() })).rejects.toMatchObject(
      check('ck_agency_manual_call_contact'),
    );
    await expect(insertManualCall(session.id, { ...settled, campaign_id: tag, contact_id: randomUUID(), contact_claimed: true }))
      .rejects.toMatchObject(check('ck_agency_manual_call_contact'));
    await expect(insertManualCall(session.id, { ...settled, campaign_id: tag, contact_claimed: true, contact_prior_state: 'pending' }))
      .rejects.toMatchObject(check('ck_agency_manual_call_contact'));
    await expect(insertManualCall(session.id, { ...settled, campaign_id: tag, contact_id: randomUUID(), contact_prior_state: 'gone' }))
      .rejects.toMatchObject(check('ck_agency_manual_call_contact_prior_state'));
  });

  it('override notes are SOFTPHONE_OVERRIDE_NOTE_MIN..MAX characters after trimming; a DNC note names its entry', async () => {
    const session = await insertSoftphoneSession();
    const settled = { state: 'ended', ended_at: new Date(), settled_at: new Date() };
    const min = 'x'.repeat(SOFTPHONE_OVERRIDE_NOTE_MIN);
    const max = 'x'.repeat(SOFTPHONE_OVERRIDE_NOTE_MAX);
    const short = `   ${'x'.repeat(SOFTPHONE_OVERRIDE_NOTE_MIN - 1)}   `;
    const long = 'x'.repeat(SOFTPHONE_OVERRIDE_NOTE_MAX + 1);

    for (const note of [min, max, `  ${min}  `]) {
      await insertManualCall(session.id, { ...settled, dnc_override_note: note, dnc_override_entry_id: randomUUID(), hours_override_note: note });
    }
    for (const note of [short, long]) {
      await expect(insertManualCall(session.id, { ...settled, dnc_override_note: note, dnc_override_entry_id: randomUUID() }))
        .rejects.toMatchObject(check('ck_agency_manual_call_dnc_override'));
      await expect(insertManualCall(session.id, { ...settled, hours_override_note: note }))
        .rejects.toMatchObject(check('ck_agency_manual_call_hours_override'));
    }
    await expect(insertManualCall(session.id, { ...settled, dnc_override_note: min })).rejects.toMatchObject(
      check('ck_agency_manual_call_dnc_override'),
    );
    await expect(insertManualCall(session.id, { ...settled, dnc_override_entry_id: randomUUID() })).rejects.toMatchObject(
      check('ck_agency_manual_call_dnc_override'),
    );
  });

  it('ended exactly when ended_at is set; settled only once ended; fields is an object', async () => {
    const session = await insertSoftphoneSession();
    await expect(insertManualCall(session.id, { state: 'ended' })).rejects.toMatchObject(check('ck_agency_manual_call_ended'));
    await expect(insertManualCall(session.id, { state: 'bridged', ended_at: new Date() })).rejects.toMatchObject(
      check('ck_agency_manual_call_ended'),
    );
    await expect(insertManualCall(session.id, { settled_at: new Date() })).rejects.toMatchObject(check('ck_agency_manual_call_settled'));
    await expect(insertManualCall(session.id, { fields: JSON.stringify([]) })).rejects.toMatchObject(check('ck_agency_manual_call_fields'));
    await expect(insertManualCall(session.id, { talk_seconds: -1 })).rejects.toMatchObject(check('ck_agency_manual_call_talk_seconds'));
    const row = await insertManualCall(session.id);
    expect(row).toMatchObject({ state: 'queued', fields: {}, contact_claimed: false, recording_requested: false, dispositioned_on_behalf: false });
  });

  it('uq_agency_manual_call_unsettled: one live or outcome-awaiting call per session', async () => {
    const session = await insertSoftphoneSession();
    const live = await insertManualCall(session.id);
    await expect(insertManualCall(session.id)).rejects.toMatchObject({ code: '23505', constraint: 'uq_agency_manual_call_unsettled' });

    // Ended but awaiting its outcome still holds the session.
    await pool().query(`UPDATE agency_manual_calls SET state = 'ended', ended_at = now() WHERE id = $1`, [live.id]);
    await expect(insertManualCall(session.id)).rejects.toMatchObject({ code: '23505', constraint: 'uq_agency_manual_call_unsettled' });

    await pool().query(`UPDATE agency_manual_calls SET settled_at = now() WHERE id = $1`, [live.id]);
    await expect(insertManualCall(session.id)).resolves.toBeTruthy();
    // Another session is independent.
    await expect(insertManualCall((await insertSoftphoneSession()).id)).resolves.toBeTruthy();
  });

  it('needs a real session (FK, no cascade); the tag, contact, leg and entry ids carry no FK', async () => {
    await expect(insertManualCall(randomUUID())).rejects.toMatchObject({ code: '23503' });
    const session = await insertSoftphoneSession();
    await insertManualCall(session.id, {
      campaign_id: randomUUID(), contact_id: randomUUID(), webrtc_call_id: randomUUID(), analysis_profile_id: randomUUID(),
    });
    // A session with a manual call cannot be deleted out from under it.
    await expect(pool().query('DELETE FROM agency_agent_sessions WHERE id = $1', [session.id])).rejects.toMatchObject({ code: '23503' });
  });

  it('defines the list, live, tag, contact and leg indexes', async () => {
    expect(await indexDef('uq_agency_manual_call_unsettled')).toMatch(
      /CREATE UNIQUE INDEX uq_agency_manual_call_unsettled ON public\.agency_manual_calls USING btree \(session_id\) WHERE \(settled_at IS NULL\)/,
    );
    expect(await indexDef('idx_agency_manual_calls_agent')).toMatch(
      /\(tenant_id, account_id, agent_user_id, created_at DESC, id DESC\)$/,
    );
    expect(await indexDef('idx_agency_manual_calls_account')).toMatch(/\(tenant_id, account_id, created_at DESC, id DESC\)$/);
    expect(await indexDef('idx_agency_manual_calls_live')).toMatch(/\(account_id\) WHERE \(\(state\)::text <> 'ended'::text\)/);
    expect(await indexDef('idx_agency_manual_calls_campaign')).toMatch(
      /\(campaign_id, created_at DESC\) WHERE \(campaign_id IS NOT NULL\)/,
    );
    expect(await indexDef('idx_agency_manual_calls_contact')).toMatch(
      /\(contact_id\) WHERE \(\(contact_id IS NOT NULL\) AND \(settled_at IS NULL\)\)/,
    );
    expect(await indexDef('idx_agency_manual_calls_contact_history')).toMatch(
      /\(contact_id, created_at DESC, id DESC\) WHERE \(contact_id IS NOT NULL\)/,
    );
    // Nothing looks a manual call up by its media leg, so 0005 indexes nothing on it.
    expect(await indexDef('idx_agency_manual_calls_webrtc')).toBeUndefined();
    // The attempt half of pacing's account-wide headroom (countLiveForAccount).
    expect(await indexDef('idx_agency_attempts_account_live')).toMatch(
      /ON public\.agency_call_attempts USING btree \(tenant_id, account_id\) WHERE \(\(state\)::text <> 'ended'::text\)$/,
    );
  });

  it('the planner can use the live indexes for an account count and the keyset for a page', async () => {
    const account = `'${ACCOUNT}'::uuid`;
    expect(await planOf(
      `SELECT count(*) FROM agency_manual_calls WHERE account_id = ${account} AND state <> 'ended'`,
    )).toContain('idx_agency_manual_calls_live');
    // countLiveForAccount's attempt half: one probe of the account, not one per campaign.
    const attempts = await planOf(
      `SELECT count(*) FROM agency_call_attempts
        WHERE tenant_id = '${TENANT}'::uuid AND account_id = ${account} AND state <> 'ended'`,
    );
    expect(attempts, attempts).toContain('idx_agency_attempts_account_live');
    expect(attempts, attempts).toMatch(/Index Cond: \(\(tenant_id = .*\) AND \(account_id = .*\)\)/);
    expect(await planOf(
      `SELECT id FROM agency_manual_calls
        WHERE tenant_id = '${TENANT}'::uuid AND account_id = ${account}
          AND (created_at, id) < (now(), '${randomUUID()}'::uuid)
        ORDER BY created_at DESC, id DESC LIMIT 50`,
    )).toContain('idx_agency_manual_calls_account');
    // A contact's history (settled calls included) is its own index, not the unsettled one.
    expect(await planOf(
      `SELECT id FROM agency_manual_calls
        WHERE tenant_id = '${TENANT}'::uuid AND account_id = ${account} AND contact_id = '${randomUUID()}'::uuid
        ORDER BY created_at DESC, id DESC LIMIT 50`,
    )).toContain('idx_agency_manual_calls_contact_history');
  });
});

describe('0005 — agency_calls.origin', () => {
  it('defaults to campaign; a manual leg carries manual_call_id and no campaign or attempt', async () => {
    const legacy = await insertCall({ campaign_id: randomUUID(), agency_attempt_id: randomUUID() });
    expect(legacy).toMatchObject({ origin: 'campaign', manual_call_id: null });
    await expect(insertCall({ origin: 'manual', manual_call_id: randomUUID() })).resolves.toBeTruthy();

    await expect(insertCall({ origin: 'preview' })).rejects.toMatchObject(check('ck_agency_calls_origin'));
    for (const bad of [
      { origin: 'manual' },
      { origin: 'campaign', manual_call_id: randomUUID() },
      { origin: 'manual', manual_call_id: randomUUID(), campaign_id: randomUUID() },
      { origin: 'manual', manual_call_id: randomUUID(), agency_attempt_id: randomUUID() },
    ]) {
      await expect(insertCall(bad)).rejects.toMatchObject(check('ck_agency_calls_manual_correlation'));
    }
    expect(await indexDef('idx_agency_calls_manual_call')).toMatch(
      /\(manual_call_id\) WHERE \(manual_call_id IS NOT NULL\)/,
    );
  });
});

describe('0005 — agency_softphone_settings', () => {
  const settings = (o: Record<string, unknown> = {}) =>
    insertRow('agency_softphone_settings', { tenant_id: TENANT, account_id: ACCOUNT, ...o });

  it('one row per (tenant, account), every column defaulted', async () => {
    const row = await settings();
    expect(row).toMatchObject({
      disposition_catalog: [], call_fields: [], analysis_profile_id: null, record_calls: false, default_caller_id: null,
    });
    await expect(settings()).rejects.toMatchObject({ code: '23505', constraint: 'uq_agency_softphone_settings_account' });
    await expect(settings({ account_id: randomUUID() })).resolves.toBeTruthy();
  });

  it('the catalog and call fields are JSON arrays, at most SOFTPHONE_CALL_FIELDS_MAX fields', async () => {
    await expect(settings({ disposition_catalog: JSON.stringify({}) })).rejects.toMatchObject(
      check('ck_agency_softphone_settings_dispositions'),
    );
    await expect(settings({ call_fields: JSON.stringify('x') })).rejects.toMatchObject(
      check('ck_agency_softphone_settings_call_fields'),
    );
    const field = (i: number) => ({ key: `f${i}`, label: `F${i}`, type: 'text' });
    const fields = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => field(i)));
    await expect(settings({ call_fields: fields(SOFTPHONE_CALL_FIELDS_MAX + 1) })).rejects.toMatchObject(
      check('ck_agency_softphone_settings_call_fields'),
    );
    await expect(settings({ call_fields: fields(SOFTPHONE_CALL_FIELDS_MAX) })).resolves.toBeTruthy();
  });
});
