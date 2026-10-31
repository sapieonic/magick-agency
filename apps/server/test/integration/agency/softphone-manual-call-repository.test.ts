import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import {
  insertAgencyAttempt, insertAgencyCampaign, insertAgencyContact, insertAgentSession,
  insertManualCall, insertSoftphoneSession,
} from './agency-factories.js';
import { DEFAULTS, OTHER_ACCOUNT, OTHER_TENANT, insertWebrtcCall } from '../setup/factories.js';

/**
 * ─── `AgencyManualCallRepository` AGAINST REAL POSTGRES ─────────────────────
 *
 * docs/softphone.md §3–§4.1. Every guard here is a WHERE clause or an index, so
 * the suite runs them: the one-unsettled-call index refusing a second dial without
 * aborting the caller's transaction, the forward-only lifecycle with independent
 * stamps, the disposition's replay/conflict/bridged guard, the lapse and orphan
 * sweeps (which release nothing themselves), the scoped reads and the keyset lists.
 * Plus `countLiveForAccount` (attempt repository), the live count pacing subtracts.
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

const { agencyManualCallRepository: repo, agencyAttemptRepository } = await import(
  '../../../src/db/repositories/agency.repository.js'
);
const { withTransaction } = await import('@magick-agency/db/utils/transaction');
const { SOFTPHONE_OUTCOME_LAPSE_MS } = await import('@magick-agency/contracts/agency');

const TENANT = DEFAULTS.tenantId;
const ACCOUNT = DEFAULTS.accountId;
const SCOPE = { tenantId: TENANT, accountId: ACCOUNT };
const MIN = 60_000;

type Session = { id: string; tenant_id: string; account_id: string; agent_user_id: string };

function createInput(session: Session, o: Partial<Parameters<typeof repo.create>[0]> = {}) {
  return {
    tenantId: session.tenant_id,
    accountId: session.account_id,
    sessionId: session.id,
    agentUserId: session.agent_user_id,
    campaignId: null,
    contact: null,
    destinationE164: '+919812345678',
    callerId: '+919000000001',
    fields: {},
    recordingRequested: false,
    analysisProfileId: null,
    dncOverride: null,
    hoursOverrideNote: null,
    ...o,
  };
}

async function row(id: string) {
  const { rows } = await getTestPool().query('SELECT * FROM agency_manual_calls WHERE id = $1', [id]);
  return rows[0];
}

/** An ended call on a fresh soft-phone session; `bridged` decides whether an outcome is owed. */
async function endedCall(o: { bridged?: boolean; endedAgoMs?: number; session?: Session; extra?: Record<string, unknown> } = {}) {
  const session = o.session ?? await insertSoftphoneSession();
  const endedAt = new Date(Date.now() - (o.endedAgoMs ?? 0));
  return insertManualCall(session, {
    state: 'ended', ended_at: endedAt, dialed_at: new Date(endedAt.getTime() - 60_000),
    outcome: o.bridged ? 'connected' : 'no_answer',
    end_reason: o.bridged ? 'remote_hangup' : 'no_answer',
    ...(o.bridged ? { answered_at: new Date(endedAt.getTime() - 50_000), bridged_at: new Date(endedAt.getTime() - 50_000) } : {}),
    ...o.extra,
  });
}

describe('AgencyManualCallRepository (integration)', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  // ── create ────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('inserts a queued call with EVERY input column landed (no silently dropped field)', async () => {
      const campaign = await insertAgencyCampaign();
      const contact = await insertAgencyContact(campaign.id);
      const session = await insertSoftphoneSession();
      const dncEntryId = randomUUID();
      const profileId = randomUUID();

      const result = await repo.create(createInput(session, {
        campaignId: campaign.id,
        contact: { contactId: contact.id, claimed: true, priorState: 'pending' },
        fields: { order_id: 'A-1', amount: 3, vip: true },
        recordingRequested: true,
        analysisProfileId: profileId,
        dncOverride: { note: 'Customer asked us to call back today', entryId: dncEntryId },
        hoursOverrideNote: 'Customer is awake and asked for it',
      }));

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable — narrowing');
      const stored = await row(result.call.id);
      expect(stored).toMatchObject({
        state: 'queued', campaign_id: campaign.id, contact_id: contact.id,
        contact_claimed: true, contact_prior_state: 'pending',
        destination_e164: '+919812345678', caller_id: '+919000000001',
        fields: { order_id: 'A-1', amount: 3, vip: true },
        recording_requested: true, analysis_profile_id: profileId,
        dnc_override_note: 'Customer asked us to call back today', dnc_override_entry_id: dncEntryId,
        hours_override_note: 'Customer is awake and asked for it',
        settled_at: null, agent_user_id: session.agent_user_id,
      });
    });

    it('a linked (unclaimed) contact stores no prior state', async () => {
      const campaign = await insertAgencyCampaign();
      const contact = await insertAgencyContact(campaign.id, { state: 'completed' });
      const session = await insertSoftphoneSession();
      const result = await repo.create(createInput(session, {
        campaignId: campaign.id, contact: { contactId: contact.id, claimed: false, priorState: 'completed' },
      }));
      if (!result.ok) throw new Error('create should succeed');
      expect(await row(result.call.id)).toMatchObject({ contact_claimed: false, contact_prior_state: null });
    });

    it('refuses a second dial on a session with an unsettled call, WITHOUT aborting the caller transaction', async () => {
      const session = await insertSoftphoneSession();
      const first = await repo.create(createInput(session));
      if (!first.ok) throw new Error('first create should succeed');

      const outcome = await withTransaction(async (client) => {
        const second = await repo.create(createInput(session, { destinationE164: '+919800000000' }), { client });
        // The transaction is still usable: ON CONFLICT DO NOTHING, not a caught 23505.
        const { rows } = await client.query<{ ok: number }>('SELECT 1 AS ok');
        return { second, ok: rows[0]!.ok };
      }, { pool: getTestPool() });

      expect(outcome.ok).toBe(1);
      expect(outcome.second.ok).toBe(false);
      if (outcome.second.ok) throw new Error('unreachable — narrowing');
      expect(outcome.second.reason).toBe('session_has_unsettled_call');
      expect(outcome.second.existing?.id).toBe(first.call.id);
      const { rows } = await getTestPool().query('SELECT id FROM agency_manual_calls WHERE session_id = $1', [session.id]);
      expect(rows).toHaveLength(1);
    });

    it('an ENDED but unsettled call still blocks the next dial; once settled the session can dial again', async () => {
      const session = await insertSoftphoneSession();
      const call = await endedCall({ session, bridged: true });

      const blocked = await repo.create(createInput(session));
      expect(blocked.ok).toBe(false);
      if (blocked.ok) throw new Error('unreachable — narrowing');
      expect(blocked.existing?.id).toBe(call.id);

      await getTestPool().query('UPDATE agency_manual_calls SET settled_at = now() WHERE id = $1', [call.id]);
      const again = await repo.create(createInput(session));
      expect(again.ok).toBe(true);
    });

    it('two racing creates on one session: exactly one row', async () => {
      const session = await insertSoftphoneSession();
      const results = await Promise.all([repo.create(createInput(session)), repo.create(createInput(session))]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const { rows } = await getTestPool().query('SELECT id FROM agency_manual_calls WHERE session_id = $1', [session.id]);
      expect(rows).toHaveLength(1);
    });
  });

  // ── lifecycle ─────────────────────────────────────────────────────────────

  describe('advanceState', () => {
    it('moves forward and stamps the state\'s own instant', async () => {
      const call = await insertManualCall(await insertSoftphoneSession());
      const at = new Date('2026-10-30T10:00:00.000Z');

      const dialing = await repo.advanceState(call.id, 'dialing', at);
      expect(dialing).toMatchObject({ changed: true, stateChanged: true });
      expect(dialing!.call.state).toBe('dialing');
      expect(dialing!.call.dialed_at!.toISOString()).toBe(at.toISOString());

      const ringing = await repo.advanceState(call.id, 'ringing');
      expect(ringing!.call.state).toBe('ringing');
      expect(ringing!.call.answered_at).toBeNull();
    });

    it('never moves backwards, and answered_at / bridged_at are stamped independently, never back-filled', async () => {
      const call = await insertManualCall(await insertSoftphoneSession(), { state: 'ringing' });
      const bridgedAt = new Date('2026-10-30T10:00:05.000Z');
      const answeredAt = new Date('2026-10-30T10:00:04.000Z');

      // `bridged` processed first (the racing handlers): no answered_at invented.
      const bridged = await repo.advanceState(call.id, 'bridged', bridgedAt);
      expect(bridged!.call.state).toBe('bridged');
      expect(bridged!.call.answered_at).toBeNull();

      // `answered` lands late: the state stays bridged, the stamp still lands.
      const answered = await repo.advanceState(call.id, 'answered', answeredAt);
      expect(answered).toMatchObject({ changed: true, stateChanged: false });
      expect(answered!.call.state).toBe('bridged');
      expect(answered!.call.answered_at!.toISOString()).toBe(answeredAt.toISOString());

      // A replayed event changes nothing: first stamp wins.
      const replay = await repo.advanceState(call.id, 'answered', new Date('2026-10-30T11:00:00.000Z'));
      expect(replay).toMatchObject({ changed: false, stateChanged: false });
      expect(replay!.call.answered_at!.toISOString()).toBe(answeredAt.toISOString());
    });

    it('an ended call does not move, but a late bridged stamp lands while unsettled — and not after', async () => {
      const unsettled = await insertManualCall(await insertSoftphoneSession(), {
        state: 'ended', ended_at: new Date(), outcome: 'connected', end_reason: 'remote_hangup',
      });
      const late = await repo.advanceState(unsettled.id, 'bridged');
      expect(late!.call.state).toBe('ended');
      expect(late!.call.bridged_at).not.toBeNull();

      const settled = await endedCall({ extra: { settled_at: new Date() } });
      const after = await repo.advanceState(settled.id, 'bridged');
      expect(after).toMatchObject({ changed: false });
      expect(after!.call.bridged_at).toBeNull();
    });

    it('answers null for an unknown call', async () => {
      expect(await repo.advanceState(randomUUID(), 'dialing')).toBeNull();
    });
  });

  it('attachWebrtcCall: first leg wins, a different one is refused, state untouched', async () => {
    const call = await insertManualCall(await insertSoftphoneSession(), { state: 'bridged' });
    const leg = randomUUID();
    expect(await repo.attachWebrtcCall(call.id, leg)).toBe(true);
    expect(await repo.attachWebrtcCall(call.id, leg)).toBe(true);
    expect(await repo.attachWebrtcCall(call.id, randomUUID())).toBe(false);
    expect(await row(call.id)).toMatchObject({ webrtc_call_id: leg, state: 'bridged' });
  });

  it('end: first end wins, a second terminal event gets null; end does not settle', async () => {
    const call = await insertManualCall(await insertSoftphoneSession(), { state: 'bridged', bridged_at: new Date() });
    const ended = await repo.end(call.id, { outcome: 'connected', endReason: 'remote_hangup', talkSeconds: 42 });
    expect(ended).toMatchObject({ state: 'ended', outcome: 'connected', end_reason: 'remote_hangup', talk_seconds: 42, settled_at: null });
    expect(ended!.ended_at).not.toBeNull();
    expect(await repo.end(call.id, { outcome: 'failed', endReason: 'failed', talkSeconds: 0 })).toBeNull();
    expect(await row(call.id)).toMatchObject({ outcome: 'connected', end_reason: 'remote_hangup' });
  });

  it('updateDetails: replaces fields, `notes: ""` clears, absent keeps; refused once settled', async () => {
    const call = await insertManualCall(await insertSoftphoneSession(), { fields: { a: 1 }, notes: 'first' });
    const fieldsOnly = await repo.updateDetails(call.id, { fields: { b: 'x' } });
    expect(fieldsOnly).toMatchObject({ fields: { b: 'x' }, notes: 'first' });
    const notesOnly = await repo.updateDetails(call.id, { notes: 'second' });
    expect(notesOnly).toMatchObject({ fields: { b: 'x' }, notes: 'second' });
    const cleared = await repo.updateDetails(call.id, { notes: '' });
    expect(cleared!.notes).toBeNull();

    const settled = await endedCall({ extra: { settled_at: new Date(), notes: 'kept' } });
    expect(await repo.updateDetails(settled.id, { notes: 'late' })).toBeNull();
    expect((await row(settled.id)).notes).toBe('kept');
  });

  // ── the outcome ───────────────────────────────────────────────────────────

  describe('recordDisposition', () => {
    const actor = randomUUID();
    const input = (id: string, code = 'interested', o: Record<string, unknown> = {}) => ({
      id, code, source: 'softphone' as const, notes: 'said yes', callbackAt: null,
      actorUserId: actor, onBehalf: false, ...o,
    });

    it('records the outcome and settles a bridged, ended call in one write', async () => {
      const call = await endedCall({ bridged: true });
      const result = await repo.recordDisposition(input(call.id, 'interested', { fields: { order_id: 'Z' } }));

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable — narrowing');
      expect(result.replay).toBe(false);
      expect(result.call).toMatchObject({
        disposition_code: 'interested', disposition_source: 'softphone', notes: 'said yes',
        dispositioned_by_user_id: actor, dispositioned_on_behalf: false, fields: { order_id: 'Z' },
      });
      expect(result.call.settled_at).not.toBeNull();
      expect(result.call.dispositioned_at).not.toBeNull();
    });

    it('a same-code replay is idempotent: ok, replay, notes last-write-wins, settled_at kept', async () => {
      const call = await endedCall({ bridged: true });
      const first = await repo.recordDisposition(input(call.id));
      const replay = await repo.recordDisposition(input(call.id, 'interested', { notes: 'corrected' }));

      if (!first.ok || !replay.ok) throw new Error('both should succeed');
      expect(replay.replay).toBe(true);
      expect(replay.call.notes).toBe('corrected');
      expect(replay.call.settled_at!.getTime()).toBe(first.call.settled_at!.getTime());
    });

    it('a different code is a conflict and writes nothing', async () => {
      const call = await endedCall({ bridged: true });
      await repo.recordDisposition(input(call.id, 'interested'));
      const before = await row(call.id);

      const other = await repo.recordDisposition(input(call.id, 'not_interested', { notes: 'nope' }));

      expect(other).toMatchObject({ ok: false, reason: 'different_code' });
      const after = await row(call.id);
      expect(after.disposition_code).toBe('interested');
      expect(after.notes).toBe('said yes');
      expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
    });

    it('refuses a live call, an unbridged one, a lapsed one and an unknown id — each by name', async () => {
      const live = await insertManualCall(await insertSoftphoneSession(), { state: 'bridged', bridged_at: new Date() });
      const unbridged = await endedCall({ bridged: false });
      const lapsed = await endedCall({
        bridged: true,
        extra: { settled_at: new Date(), disposition_code: 'no_disposition', disposition_source: 'softphone' },
      });

      expect(await repo.recordDisposition(input(live.id))).toMatchObject({ ok: false, reason: 'live' });
      expect(await repo.recordDisposition(input(unbridged.id))).toMatchObject({ ok: false, reason: 'not_bridged' });
      expect(await repo.recordDisposition(input(lapsed.id))).toMatchObject({ ok: false, reason: 'lapsed' });
      // Even "replaying" the auto-close code is refused: a lapse is never overwritten.
      expect(await repo.recordDisposition(input(lapsed.id, 'no_disposition'))).toMatchObject({ ok: false, reason: 'lapsed' });
      expect(await repo.recordDisposition(input(randomUUID()))).toMatchObject({ ok: false, reason: 'not_found', call: null });
      expect((await row(unbridged.id)).disposition_code).toBeNull();
    });

    it('two racing submissions with different codes: exactly one lands', async () => {
      const call = await endedCall({ bridged: true });
      const [a, b] = await Promise.all([
        repo.recordDisposition(input(call.id, 'interested')),
        repo.recordDisposition(input(call.id, 'not_interested')),
      ]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      const loser = a.ok ? b : a;
      expect(loser).toMatchObject({ ok: false, reason: 'different_code' });
    });

    it('the source must match the tag (CHECKed): campaign on an untagged call throws', async () => {
      const call = await endedCall({ bridged: true });
      await expect(repo.recordDisposition(input(call.id, 'x', { source: 'campaign' }))).rejects.toThrow();
    });
  });

  it('settleWithoutDisposition: settles an ended unbridged call; refuses a bridged or live one', async () => {
    const unbridged = await endedCall({ bridged: false });
    const bridged = await endedCall({ bridged: true });
    const live = await insertManualCall(await insertSoftphoneSession(), { state: 'ringing' });

    expect((await repo.settleWithoutDisposition(unbridged.id))?.settled_at).not.toBeNull();
    expect(await repo.settleWithoutDisposition(unbridged.id)).toBeNull();
    expect(await repo.settleWithoutDisposition(bridged.id)).toBeNull();
    expect(await repo.settleWithoutDisposition(live.id)).toBeNull();
    expect((await row(bridged.id)).settled_at).toBeNull();
  });

  // ── the sweeps ────────────────────────────────────────────────────────────

  describe('lapseUnsettled', () => {
    it('closes overdue calls no_disposition (bridged) or plainly (unbridged), returns them, releases nothing', async () => {
      const campaign = await insertAgencyCampaign();
      const contact = await insertAgencyContact(campaign.id, { state: 'in_flight' });
      const overdueBridged = await endedCall({
        bridged: true, endedAgoMs: SOFTPHONE_OUTCOME_LAPSE_MS + MIN,
        extra: { campaign_id: campaign.id, contact_id: contact.id, contact_claimed: true, contact_prior_state: 'pending' },
      });
      const overdueUnbridged = await endedCall({ bridged: false, endedAgoMs: SOFTPHONE_OUTCOME_LAPSE_MS + MIN });
      const recent = await endedCall({ bridged: true, endedAgoMs: MIN });
      const live = await insertManualCall(await insertSoftphoneSession(), { state: 'bridged', bridged_at: new Date() });

      const lapsed = await repo.lapseUnsettled();

      expect(lapsed.map((r) => r.id).sort()).toEqual([overdueBridged.id, overdueUnbridged.id].sort());
      expect(await row(overdueBridged.id)).toMatchObject({
        disposition_code: 'no_disposition', disposition_source: 'campaign', dispositioned_by_user_id: null,
      });
      expect((await row(overdueBridged.id)).settled_at).not.toBeNull();
      expect(await row(overdueUnbridged.id)).toMatchObject({ disposition_code: null, disposition_source: null });
      expect((await row(overdueUnbridged.id)).settled_at).not.toBeNull();
      expect((await row(recent.id)).settled_at).toBeNull();
      expect((await row(live.id)).settled_at).toBeNull();
      // The claim is the caller's to release.
      const { rows } = await getTestPool().query('SELECT state FROM agency_contacts WHERE id = $1', [contact.id]);
      expect(rows[0].state).toBe('in_flight');
      // A second sweep finds nothing.
      expect(await repo.lapseUnsettled()).toEqual([]);
    });

    it('closes a RECENT call whose session has left', async () => {
      const session = await insertSoftphoneSession({ state: 'offline', left_at: new Date() });
      const call = await endedCall({ session, bridged: true, endedAgoMs: MIN });
      const lapsed = await repo.lapseUnsettled();
      expect(lapsed.map((r) => r.id)).toEqual([call.id]);
      expect((await row(call.id)).disposition_source).toBe('softphone');
    });

    it('honours lapseMs', async () => {
      const call = await endedCall({ bridged: true, endedAgoMs: 2 * MIN });
      expect(await repo.lapseUnsettled({ lapseMs: 5 * MIN })).toEqual([]);
      expect((await repo.lapseUnsettled({ lapseMs: MIN })).map((r) => r.id)).toEqual([call.id]);
    });
  });

  describe('reapOrphaned', () => {
    it('ends non-terminal calls not in the live set `orphaned`; settles only the unbridged ones', async () => {
      const queued = await insertManualCall(await insertSoftphoneSession());
      const bridged = await insertManualCall(await insertSoftphoneSession(), {
        state: 'bridged', dialed_at: new Date(), answered_at: new Date(), bridged_at: new Date(),
      });
      const kept = await insertManualCall(await insertSoftphoneSession(), { state: 'ringing' });
      const alreadyEnded = await endedCall({ bridged: true });

      const reaped = await repo.reapOrphaned({ liveIds: [kept.id] });

      expect(reaped.map((r) => r.id).sort()).toEqual([queued.id, bridged.id].sort());
      expect(await row(queued.id)).toMatchObject({ state: 'ended', outcome: 'orphaned', end_reason: 'orphaned' });
      expect((await row(queued.id)).settled_at).not.toBeNull();
      // Bridged: ended but still awaiting its outcome — the claim must be kept.
      expect(await row(bridged.id)).toMatchObject({ state: 'ended', outcome: 'orphaned', settled_at: null });
      expect((await row(kept.id)).state).toBe('ringing');
      expect((await row(alreadyEnded.id)).outcome).toBe('connected');
    });

    it('respects createdBefore (the periodic sweep never reaps a call being placed now)', async () => {
      const old = await insertManualCall(await insertSoftphoneSession(), { created_at: new Date(Date.now() - 10 * MIN) });
      const fresh = await insertManualCall(await insertSoftphoneSession());
      const reaped = await repo.reapOrphaned({ liveIds: [], createdBefore: new Date(Date.now() - 5 * MIN) });
      expect(reaped.map((r) => r.id)).toEqual([old.id]);
      expect((await row(fresh.id)).state).toBe('queued');
    });
  });

  // ── reads ─────────────────────────────────────────────────────────────────

  describe('reads', () => {
    it('findById is scoped to tenant and account; a malformed id is a miss, not a 22P02', async () => {
      const call = await insertManualCall(await insertSoftphoneSession());
      expect((await repo.findById(call.id, SCOPE))?.id).toBe(call.id);
      expect(await repo.findById(call.id, { tenantId: OTHER_TENANT, accountId: ACCOUNT })).toBeNull();
      expect(await repo.findById(call.id, { tenantId: TENANT, accountId: OTHER_ACCOUNT })).toBeNull();
      expect(await repo.findById('not-a-uuid', SCOPE)).toBeNull();
      expect(await repo.findWireById('not-a-uuid', SCOPE)).toBeNull();
    });

    it('findWireById: tag name and contact state joined, context only on request, agent_name null', async () => {
      const campaign = await insertAgencyCampaign({ name: 'Renewals' });
      const contact = await insertAgencyContact(campaign.id, { state: 'in_flight' });
      const call = await endedCall({
        bridged: true,
        extra: {
          campaign_id: campaign.id, contact_id: contact.id, contact_claimed: true, contact_prior_state: 'pending',
          dnc_override_note: 'Customer asked us explicitly', dnc_override_entry_id: randomUUID(),
        },
      });

      const wire = await repo.findWireById(call.id, SCOPE);
      expect(wire).toMatchObject({
        id: call.id, agent_name: null,
        tag: { campaign_id: campaign.id, campaign_name: 'Renewals' },
        contact: { contact_id: contact.id, state: 'in_flight', claimed: true },
        dnc_overridden: true, hours_overridden: false,
        requires_disposition: true, state: 'ended',
      });
      expect(wire!.contact).not.toHaveProperty('context');
      expect(new Date(wire!.outcome_due_at!).getTime())
        .toBe(new Date(call.ended_at).getTime() + SOFTPHONE_OUTCOME_LAPSE_MS);

      const detail = await repo.findWireById(call.id, SCOPE, { withContext: true });
      expect(detail!.contact!.context).toEqual({ name: 'Test Person' });
    });

    it('a purged tag or contact never drops the call: deleted-campaign name, contact null', async () => {
      const call = await insertManualCall(await insertSoftphoneSession(), {
        campaign_id: randomUUID(), contact_id: randomUUID(),
      });
      const wire = await repo.findWireById(call.id, SCOPE);
      expect(wire!.tag!.campaign_name).toBe('(deleted campaign)');
      expect(wire!.contact).toBeNull();
      expect(wire!.requires_disposition).toBe(false);
      expect(wire!.outcome_due_at).toBeNull();
    });

    it('findUnsettledForSession returns the live-or-awaiting call only', async () => {
      const session = await insertSoftphoneSession();
      await endedCall({ session, extra: { settled_at: new Date() } });
      expect(await repo.findUnsettledForSession(session.id)).toBeNull();
      const awaiting = await endedCall({ session, bridged: true });
      expect((await repo.findUnsettledForSession(session.id))?.id).toBe(awaiting.id);
    });
  });

  describe('lists', () => {
    it('listForAgent: only the agent\'s calls in this account, newest first, keyset across a tie', async () => {
      const session = await insertSoftphoneSession();
      const tie = new Date('2026-10-30T09:00:00.000Z');
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push((await endedCall({ session, extra: { created_at: tie, settled_at: new Date() } })).id);
      }
      await insertManualCall(await insertSoftphoneSession());   // another agent
      // The same person in another tenant: never on this list.
      await insertManualCall(await insertSoftphoneSession({
        tenant_id: OTHER_TENANT, account_id: OTHER_ACCOUNT, agent_user_id: session.agent_user_id,
      }));

      const page1 = await repo.listForAgent({ ...SCOPE, agentUserId: session.agent_user_id, filters: {}, limit: 3 });
      expect(page1.rows).toHaveLength(3);
      expect(page1.next_cursor).not.toBeNull();
      const { decodeKeysetCursor } = await import('@magick-agency/domain/keyset-cursor');
      const after = decodeKeysetCursor(page1.next_cursor!);
      if (!after) throw new Error('cursor should decode');
      const page2 = await repo.listForAgent({ ...SCOPE, agentUserId: session.agent_user_id, filters: {}, after, limit: 3 });
      expect(page2.rows).toHaveLength(2);
      expect(page2.next_cursor).toBeNull();
      const seen = [...page1.rows, ...page2.rows].map((r) => r.id);
      expect(new Set(seen).size).toBe(5);
      expect(seen.sort()).toEqual([...ids].sort());
      // No context on a list row.
      expect(page1.rows.every((r) => r.contact === null || !('context' in r.contact))).toBe(true);
    });

    it('listForAccount filters: agent, tag, untagged, status, outcome, code, phone suffix, date range', async () => {
      const campaign = await insertAgencyCampaign({ name: 'Tagged' });
      const s1 = await insertSoftphoneSession();
      const s2 = await insertSoftphoneSession();
      const tagged = await endedCall({
        session: s1, bridged: true,
        extra: {
          campaign_id: campaign.id, settled_at: new Date(), disposition_code: 'interested',
          disposition_source: 'campaign', destination_e164: '+919811112222',
          created_at: new Date('2026-10-01T10:00:00Z'),
        },
      });
      const awaiting = await endedCall({ session: s2, bridged: true, extra: { created_at: new Date('2026-10-02T10:00:00Z') } });
      const s3 = await insertSoftphoneSession();
      const live = await insertManualCall(s3, { state: 'ringing', created_at: new Date('2026-10-03T10:00:00Z') });

      const list = (filters: Parameters<typeof repo.listForAccount>[0]['filters']) =>
        repo.listForAccount({ ...SCOPE, filters, limit: 50 }).then((p) => p.rows.map((r) => r.id).sort());

      expect(await list({})).toEqual([tagged.id, awaiting.id, live.id].sort());
      expect(await list({ agentUserId: s1.agent_user_id })).toEqual([tagged.id]);
      expect(await list({ campaign: { campaignId: campaign.id } })).toEqual([tagged.id]);
      expect(await list({ campaign: 'untagged' })).toEqual([awaiting.id, live.id].sort());
      expect(await list({ status: 'live' })).toEqual([live.id]);
      expect(await list({ status: 'awaiting_outcome' })).toEqual([awaiting.id]);
      expect(await list({ status: 'settled' })).toEqual([tagged.id]);
      expect(await list({ outcome: 'connected' })).toEqual([tagged.id, awaiting.id].sort());
      expect(await list({ dispositionCode: 'interested' })).toEqual([tagged.id]);
      expect(await list({ phoneDigits: '2222' })).toEqual([tagged.id]);
      expect(await list({ phoneDigits: '%' })).toEqual([]);
      expect(await list({ from: new Date('2026-10-02T00:00:00Z'), to: new Date('2026-10-03T10:00:00Z') }))
        .toEqual([awaiting.id]);
      const page = await repo.listForAccount({ ...SCOPE, filters: { campaign: { campaignId: campaign.id } }, limit: 5 });
      expect(page.rows[0]!.tag).toEqual({ campaign_id: campaign.id, campaign_name: 'Tagged' });
      // Another account sees none of it.
      expect((await repo.listForAccount({ tenantId: TENANT, accountId: OTHER_ACCOUNT, filters: {}, limit: 5 })).rows).toEqual([]);
    });

    it('rows carry the media leg\'s analysis_status; no leg, a purged leg and another account\'s leg read NULL', async () => {
      const session = await insertSoftphoneSession();
      const leg = await insertWebrtcCall({ campaign_id: null, analysis_status: 'completed' });
      const foreignLeg = await insertWebrtcCall({ campaign_id: null, account_id: OTHER_ACCOUNT, analysis_status: 'pending' });
      const withLeg = await insertManualCall(session, { webrtc_call_id: leg.id, created_at: new Date('2026-10-04T10:00:00Z') });
      const noLeg = await insertManualCall(session, { created_at: new Date('2026-10-04T09:00:00Z'), state: 'ended', ended_at: new Date(), settled_at: new Date() });
      const purged = await insertManualCall(session, { webrtc_call_id: randomUUID(), created_at: new Date('2026-10-04T08:00:00Z'), state: 'ended', ended_at: new Date(), settled_at: new Date() });
      const foreign = await insertManualCall(session, { webrtc_call_id: foreignLeg.id, created_at: new Date('2026-10-04T07:00:00Z'), state: 'ended', ended_at: new Date(), settled_at: new Date() });
      const page = await repo.listForAgent({ ...SCOPE, agentUserId: session.agent_user_id, filters: {}, limit: 10 });
      expect(page.rows.map((r) => [r.id, r.analysis_status])).toEqual([
        [withLeg.id, 'completed'], [noLeg.id, null], [purged.id, null], [foreign.id, null],
      ]);
      const account = await repo.listForAccount({ ...SCOPE, filters: { agentUserId: session.agent_user_id }, limit: 1 });
      expect(account.rows[0]).toMatchObject({ id: withLeg.id, analysis_status: 'completed' });
    });
  });

  // ── the account's live count (attempt repository) ─────────────────────────

  it('countLiveForAccount: live attempts across every campaign of the account + live manual calls', async () => {
    const a = await insertAgencyCampaign();
    const b = await insertAgencyCampaign();
    const other = await insertAgencyCampaign({ account_id: OTHER_ACCOUNT });
    const sa = await insertAgentSession(a.id);
    for (const [campaign, state] of [[a, 'dialing'], [a, 'bridged'], [b, 'ringing'], [b, 'ended'], [other, 'bridged']] as const) {
      const contact = await insertAgencyContact(campaign.id, { account_id: campaign.account_id });
      await insertAgencyAttempt(campaign.id, contact.id, {
        state, account_id: campaign.account_id, reserved_agent_id: state === 'dialing' ? sa.id : null,
        ...(state === 'ended' ? { ended_at: new Date() } : {}),
      });
    }
    await insertManualCall(await insertSoftphoneSession(), { state: 'bridged' });
    await insertManualCall(await insertSoftphoneSession(), { state: 'queued' });
    await endedCall({ bridged: true });  // awaiting its outcome: holds no slot
    await insertManualCall(await insertSoftphoneSession({ account_id: OTHER_ACCOUNT }), { state: 'bridged' });

    expect(await agencyAttemptRepository.countLiveForAccount(TENANT, ACCOUNT)).toBe(3 + 2);
    expect(await agencyAttemptRepository.countLive(a.id)).toBe(2);
    expect(await agencyAttemptRepository.countLiveForAccount(TENANT, OTHER_ACCOUNT)).toBe(2);
    expect(await agencyAttemptRepository.countLiveForAccount(OTHER_TENANT, ACCOUNT)).toBe(0);
  });
});
