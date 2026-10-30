import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

/*
 * ─── THE PROCESS RESTARTS MID SOFT-PHONE CALL (chaos) ─────────────────────────
 *
 * docs/softphone.md §4.1 steps 8 and 10, §5. A deploy lands while agents are on
 * soft-phone calls: the process dies, no `ended` is ever emitted, Postgres keeps
 * non-terminal `agency_manual_calls` rows with their roster contacts claimed
 * `in_flight`, and Redis keeps each session's `manual` claim. The new process's
 * startup reaper must reconstruct a truthful picture from exactly that:
 *
 *  - a call that never bridged is ended `orphaned` AND settled; its contact goes
 *    back to the state it was claimed from with NO attempt charged, and its Redis
 *    claim is cleared — so the agent can dial again;
 *  - a call that BRIDGED is ended `orphaned` and left awaiting its outcome (the
 *    agent talked to the customer): its contact claim and Redis claim are KEPT, the
 *    agent writes it up after reconnecting and the outcome settles the contact;
 *  - if nobody writes it up, the lapse sweep closes it `no_disposition` after
 *    `SOFTPHONE_OUTCOME_LAPSE_MS` and gives the contact back.
 *
 * Real Postgres (the repositories' SQL) and real Redis (the Lua claims); the
 * bridge is a stub — a dead process has no live legs, which is the point.
 */
const { closeTestPool, getTestPool, truncateAll } = await import('../../setup/test-utils.js');
vi.mock('@magick-agency/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));
vi.mock('@magick-agency/db/connection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/db/connection')>()),
  getPool: () => getTestPool(),
}));

const { closeTestRedis, flushTestRedis, getTestRedis } = await import('../../setup/test-utils.js');
const { insertAgencyCampaign, insertAgencyContact, insertSoftphoneSession, insertManualCall } = await import('../agency-factories.js');
const { AgentStateMachine } = await import('../../../../src/agency/agent-state-machine.js');
const { StationRegistry } = await import('../../../../src/agency/station-registry.js');
const { AgencyReaper } = await import('../../../../src/agency/reaper.js');
const { ManualDialer } = await import('../../../../src/agency/softphone/manual-dialer.js');
const { SoftphoneService } = await import('../../../../src/agency/softphone/softphone-service.js');
const { DncRegistry } = await import('../../../../src/agency/dnc-registry.js');
const { BreakRegistry } = await import('@magick-agency/domain/break-manager');
const { auditLogger } = await import('../../../../src/audit/audit-logger.js');

const TENANT = '00000000-0000-4000-8000-0000000000a1';
const ACCOUNT = '00000000-0000-4000-8000-0000000000b1';

/** A freshly booted process: nothing live, a stub bridge, the real sweeps. */
function bootProcess() {
  const agents = new AgentStateMachine(getTestRedis(), '');
  const stations = new StationRegistry(getTestRedis(), '', `replica-${randomUUID().slice(0, 6)}`);
  const bridge = { onLifecycle: () => () => undefined, reattachBorrowedBrowserLeg: () => false } as never;
  const manual = new ManualDialer(bridge, stations, agents);
  manual.start();
  const reaper = new AgencyReaper({
    activeAttemptIds: () => [],
    ownerOf: async () => null,
    manual: { activeIds: () => manual.activeManualCallIds(), onClosed: (rows) => manual.onCallsClosedBySweep(rows) },
  });
  const service = new SoftphoneService({
    agents, stations, breaks: new BreakRegistry(), dialer: { hasUnannouncedAttempt: () => false },
    dnc: new DncRegistry(), manual,
  });
  return { agents, reaper, service, manual };
}

async function claimedCall(
  campaignId: string,
  phone: string,
  call: Record<string, unknown>,
) {
  const contact = await insertAgencyContact(campaignId, {
    tenant_id: TENANT, account_id: ACCOUNT, phone_e164: phone, state: 'in_flight', attempt_count: 2,
  });
  const session = await insertSoftphoneSession({ tenant_id: TENANT, account_id: ACCOUNT });
  const row = await insertManualCall(session, {
    campaign_id: campaignId, contact_id: contact.id, contact_claimed: true, contact_prior_state: 'pending',
    destination_e164: phone, ...call,
  });
  // The dead process's Redis claim on the session.
  const agents = new AgentStateMachine(getTestRedis(), '');
  await agents.set(session.id, 'break');
  expect(await agents.claimManual(session.id, row.id)).toEqual({ ok: true });
  return { contact, session, row };
}

const row = async (id: string) => (await getTestPool().query('SELECT * FROM agency_manual_calls WHERE id = $1', [id])).rows[0];
const contactOf = async (id: string) => (await getTestPool().query('SELECT * FROM agency_contacts WHERE id = $1', [id])).rows[0];

describe('restart mid soft-phone call (chaos)', () => {
  beforeEach(async () => {
    await truncateAll();
    await flushTestRedis();
    await getTestPool().query(
      `INSERT INTO tenants (id, name, slug, settings, status) VALUES ($1, 'T', 'sp-chaos', '{}', 'active')
       ON CONFLICT DO NOTHING`, [TENANT]);
  });
  afterAll(async () => {
    await closeTestPool();
    await closeTestRedis();
  });

  it('the startup reaper settles the unbridged call and keeps the bridged one awaiting its outcome', async () => {
    const campaign = await insertAgencyCampaign({ tenant_id: TENANT, account_id: ACCOUNT });
    const ringing = await claimedCall(campaign.id, '+919811200001', { state: 'ringing', dialed_at: new Date() });
    const bridged = await claimedCall(campaign.id, '+919811200002', {
      state: 'bridged', dialed_at: new Date(), answered_at: new Date(), bridged_at: new Date(),
    });
    const audit = vi.spyOn(auditLogger, 'log');

    const proc = bootProcess();
    await proc.reaper.reapOnStartup();

    // Unbridged: ended orphaned, settled, contact back to `pending` with no attempt
    // charged, Redis claim cleared.
    const r1 = await row(ringing.row.id);
    expect(r1).toMatchObject({ state: 'ended', outcome: 'orphaned', end_reason: 'orphaned' });
    expect(r1.settled_at).not.toBeNull();
    const c1 = await contactOf(ringing.contact.id);
    expect(c1.state).toBe('pending');
    expect(c1.attempt_count).toBe(2);
    expect(await proc.agents.manualCallOf(ringing.session.id)).toBeNull();

    // Bridged: ended orphaned, NOT settled, contact still claimed, Redis claim kept.
    const r2 = await row(bridged.row.id);
    expect(r2).toMatchObject({ state: 'ended', outcome: 'orphaned' });
    expect(r2.settled_at).toBeNull();
    expect((await contactOf(bridged.contact.id)).state).toBe('in_flight');
    expect(await proc.agents.manualCallOf(bridged.session.id)).toBe(bridged.row.id);
    expect(await proc.agents.set(bridged.session.id, 'available')).toBe('manual_call_live');

    // Both are system-driven outcomes on the audit trail.
    const events = audit.mock.calls.map(([e]) => e).filter((e) => e.eventType === 'agency_manual_call.orphaned');
    expect(events.map((e) => e.eventData['manual_call_id']).sort()).toEqual([ringing.row.id, bridged.row.id].sort());
    expect(events.every((e) => e.actor === 'system:agency-reaper')).toBe(true);
    audit.mockRestore();

    // The agent reconnects and writes the call up: the outcome settles the contact.
    const actor = { tenantId: TENANT, accountId: ACCOUNT, userId: bridged.session.agent_user_id, supervise: false };
    const live = await proc.service.getLiveForSession(bridged.session.id);
    expect(live?.requires_disposition).toBe(true);
    const done = await proc.service.submitDisposition(actor, bridged.row.id, { code: 'voicemail' });
    if (!done.ok) throw new Error(done.refusal.code);
    const c2 = await contactOf(bridged.contact.id);
    // The call was placed, so it is charged once (2 → 3) — and the decision was
    // taken on that count: voicemail's retry allows 2 attempts, so the contact is
    // spent, not requeued.
    expect(c2.attempt_count).toBe(3);
    expect(c2.state).toBe('exhausted');
    expect(c2.last_disposition).toBe('voicemail');
    expect(await proc.agents.manualCallOf(bridged.session.id)).toBeNull();

    // And the reaper does not touch it again.
    await proc.reaper.sweepManualCalls();
    expect((await row(bridged.row.id)).disposition_code).toBe('voicemail');
    proc.manual.stop();
  });

  it('an outcome nobody saves lapses no_disposition and gives the contact back, uncharged', async () => {
    const campaign = await insertAgencyCampaign({ tenant_id: TENANT, account_id: ACCOUNT });
    const longAgo = new Date(Date.now() - 31 * 60_000);
    const owed = await claimedCall(campaign.id, '+919811200003', {
      state: 'ended', outcome: 'connected', end_reason: 'remote_hangup',
      dialed_at: longAgo, answered_at: longAgo, bridged_at: longAgo, ended_at: longAgo,
    });
    const audit = vi.spyOn(auditLogger, 'log');
    const proc = bootProcess();
    const swept = await proc.reaper.sweepManualCalls();
    expect(swept.lapsed).toBe(1);

    const r = await row(owed.row.id);
    expect(r.settled_at).not.toBeNull();
    expect(r.disposition_code).toBe('no_disposition');
    expect(r.dispositioned_by_user_id).toBeNull();
    const c = await contactOf(owed.contact.id);
    expect(c.state).toBe('pending');
    expect(c.attempt_count).toBe(2);
    expect(await proc.agents.manualCallOf(owed.session.id)).toBeNull();
    expect(audit.mock.calls.some(([e]) => e.eventType === 'agency_manual_call.lapsed'
      && e.eventData['manual_call_id'] === owed.row.id)).toBe(true);
    audit.mockRestore();

    // The agent's late outcome is refused: the call lapsed.
    const late = await proc.service.submitDisposition(
      { tenantId: TENANT, accountId: ACCOUNT, userId: owed.session.agent_user_id, supervise: false },
      owed.row.id, { code: 'voicemail' },
    );
    expect(late.ok ? null : late.refusal.code).toBe('call_settled');
    proc.manual.stop();
  });

  it('the periodic sweep spares a call this process is driving and a call younger than the cutoff', async () => {
    const campaign = await insertAgencyCampaign({ tenant_id: TENANT, account_id: ACCOUNT });
    const young = await claimedCall(campaign.id, '+919811200004', { state: 'ringing', dialed_at: new Date() });
    const proc = bootProcess();
    await proc.reaper.sweepManualCalls();
    expect((await row(young.row.id)).state).toBe('ringing');
    // Old and not ours: reaped.
    await getTestPool().query(
      "UPDATE agency_manual_calls SET created_at = now() - interval '10 minutes' WHERE id = $1", [young.row.id]);
    await proc.reaper.sweepManualCalls();
    expect((await row(young.row.id)).outcome).toBe('orphaned');
    expect(await proc.agents.manualCallOf(young.session.id)).toBeNull();
    proc.manual.stop();
  });
});
