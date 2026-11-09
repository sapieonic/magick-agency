import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * ─── Working the Missed inbound list, and the inbound summary, through the real app ─────────
 *
 * `/proxy/agency/inbound/missed/count`, `/missed/:id/assign` and `/inbound/summary`
 * (docs/inbound.md §7, §8.4, §11): the session (Firebase stubbed), tenant context, RBAC, the public
 * routes, `callCore`, the internal handlers (`api/routes/agency/inbound-missed-work.ts`) and the
 * repositories on real Postgres, with the audit rows they write. And the Missed row's life beyond
 * the list: closed on its own when the customer is put through (0028's triggers, seen through the
 * API), the voicemail never cached.
 *
 * What it pins:
 *  1. the count: an agent's own open rows, a supervisor's the account's, capped, whether any row
 *     exists, and served with the inbound flag off;
 *  2. reassign: supervisors only, to an active member of the account or to the account, audited
 *     once per change, refused for a handled row, an outsider or a departed member, another
 *     account's row, a malformed id; the new assignee sees it, the old one no longer does; served
 *     with the flag off;
 *  3. a departed assignee reads `assignee_departed` ("Former member");
 *  4. a call back from the row that connects closes it (`reached`, by that agent), and the
 *     contact's booked inbound callback is settled by the call's outcome, so the campaign does not
 *     call again;
 *  5. the summary: the numbers from seeded calls (rates, time to answer, sticky hit rate, per agent
 *     with names), the account's own calls only, ended calls only, supervisors only, the range
 *     validated, served with the flag off;
 *  6. a voicemail is answered `Cache-Control: private, no-store`.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'inbound-missed-work-secret-0123456789';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));
const bucket = vi.hoisted(() => ({ files: new Map<string, Buffer>() }));
vi.mock('../../../src/storage/s3.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/storage/s3.js')>();
  const { Readable } = await import('node:stream');
  return {
    ...actual,
    isStorageConfigured: () => true,
    getFileStream: async (key: string) => {
      const file = bucket.files.get(key);
      if (!file) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
      return { body: Readable.from([file]), contentLength: file.length };
    },
  };
});

import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  drainAudits, headersFor, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type Actor, type LoadApp, type TenantFloor,
} from '../load/load-harness.js';
import { getFeatureFlagService } from '../../../src/feature-flags/index.js';
import {
  agencyContactRepository,
  agencyInboundCallRepository,
  agencyManualCallRepository,
} from '../../../src/db/repositories/agency.repository.js';

const q = (sql: string, values: unknown[] = []) => getTestPool().query(sql, values);

let loaded: LoadApp;
let floor: TenantFloor;
let other: TenantFloor;
let accountB: string;
const credentials = new Map<string, string>();
const sup = () => floor.supervisors[0]!;
const agent = (i: number) => floor.agents[i]!;

type Method = 'GET' | 'POST';
function call(method: Method, url: string, actor: Actor, body?: unknown, opts: { f?: TenantFloor; account?: string } = {}) {
  const f = opts.f ?? floor;
  return loaded.app.inject({
    method,
    url: `/proxy/agency/inbound${url}`,
    headers: headersFor(actor, f, {
      ...(opts.account ? { 'x-account-id': opts.account } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    }),
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

async function setFlag(tenant: string, on: boolean): Promise<void> {
  await q(`DELETE FROM feature_flag_overrides WHERE flag_key = 'agency_inbound_enabled' AND tenant_id = $1`, [tenant]);
  await q(`INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, account_id, value)
           VALUES ('agency_inbound_enabled', 'tenant', $1, NULL, $2::jsonb)`, [tenant, on ? 'true' : 'false']);
  await getFeatureFlagService().invalidate({ tenantId: tenant });
}

/** Run `fn` with the inbound flag off for the floor's tenant, then on again. */
async function withFlagOff(fn: () => Promise<void>): Promise<void> {
  await setFlag(floor.tenant, false);
  try {
    await fn();
  } finally {
    await setFlag(floor.tenant, true);
  }
}

/** An ended call that reached nobody: an open Missed row. */
async function missed(o: {
  tenant?: string; account?: string; assignee?: string | null; at?: Date; from?: string | null;
  contact?: { contactId: string; campaignId: string }; voicemail?: string;
} = {}): Promise<string> {
  const tenant = o.tenant ?? floor.tenant;
  const row = (await agencyInboundCallRepository.insertArrival({
    tenantId: tenant, accountId: o.account ?? floor.account, routeId: null, phoneNumberId: null,
    provider: 'plivo', telephonyCredentialId: credentials.get(tenant)!, providerCallId: `CA-${randomUUID()}`,
    fromE164: o.from === undefined ? '+447700900123' : o.from, toE164: '+14155550100',
    identification: { match: o.contact ?? null, callerDnc: false, sticky: null },
    answered: true, recordingRequested: false, analysisProfileId: null,
  })).call!;
  await q('UPDATE agency_inbound_calls SET arrived_at = $2 WHERE id = $1', [row.id, o.at ?? new Date(Date.now() - 3_600_000)]);
  await agencyInboundCallRepository.end(row.id, {
    outcome: o.voicemail ? 'voicemail' : 'closed', talkSeconds: null, followUp: { reason: 'closed', assigneeUserId: o.assignee ?? null },
    callbackDueAt: null, voicemailKey: o.voicemail ?? null, voicemailSeconds: o.voicemail ? 3 : null,
  });
  return row.id;
}

async function audits(action: string, resourceId: string) {
  await drainAudits();
  const { rows } = await q(
    `SELECT user_id, account_id, details FROM platform_audit_log WHERE action = $1 AND resource_id = $2`, [action, resourceId]);
  return rows as Array<{ user_id: string; account_id: string; details: Record<string, unknown> }>;
}

const idsOf = (res: { json: () => { rows: Array<{ id: string }> } }) => res.json().rows.map((r) => r.id);

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
  await truncateAll();
  [floor, other] = (await seedFloor({
    tenants: 2, agentsPerTenant: 3, supervisorsPerTenant: 1, campaignsPerTenant: 1, campaignStatus: 'running',
  })) as [TenantFloor, TenantFloor];
  accountB = randomUUID();
  await q(`INSERT INTO accounts (id, tenant_id, name, slug, settings, status) VALUES ($1, $2, 'South', $3, '{}'::jsonb, 'active')`,
    [accountB, floor.tenant, `south-${accountB.slice(0, 8)}`]);
  await q(`INSERT INTO telephony_providers (name, display_name) VALUES ('voicelink', 'VoiceLink'), ('plivo', 'Plivo') ON CONFLICT DO NOTHING`);
  for (const f of [floor, other]) {
    const { rows } = await q(
      `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref) VALUES ($1, 'plivo', 'Main', $2) RETURNING id`,
      [f.tenant, `MA${randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`]);
    credentials.set(f.tenant, rows[0]!.id as string);
    await setFlag(f.tenant, true);
  }
});

afterAll(async () => {
  // 0024's Down refuses while inbound calls exist: leave none for the down → up suites.
  await truncateAll();
  await stopLoadApp(loaded);
});

describe('GET /inbound/missed/count: the nav badge', () => {
  it('counts an agent`s own open rows and a supervisor`s account, says whether any row exists, and is served with the flag off', async () => {
    await q('DELETE FROM agency_inbound_calls');
    const empty = await call('GET', '/missed/count', agent(0));
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json()).toEqual({ open: 0, open_capped: false, has_rows: false });

    const mine = await missed({ assignee: agent(0).id });
    await missed({ assignee: agent(0).id });
    await missed({ assignee: agent(1).id });
    await missed({ assignee: null });
    await missed({ account: accountB, assignee: agent(0).id });
    await missed({ tenant: other.tenant, account: other.account, assignee: null });

    expect((await call('GET', '/missed/count', agent(0))).json()).toEqual({ open: 2, open_capped: false, has_rows: true });
    expect((await call('GET', '/missed/count', agent(2))).json()).toEqual({ open: 0, open_capped: false, has_rows: false });
    expect((await call('GET', '/missed/count', sup())).json()).toEqual({ open: 4, open_capped: false, has_rows: true });

    // Handled rows are not counted, but they are rows to read.
    await call('POST', `/missed/${mine}/handled`, agent(0));
    expect((await call('GET', '/missed/count', agent(0))).json()).toEqual({ open: 1, open_capped: false, has_rows: true });

    await withFlagOff(async () => {
      const off = await call('GET', '/missed/count', agent(0));
      expect(off.statusCode, off.body).toBe(200);
      expect(off.json()).toMatchObject({ open: 1, has_rows: true });
    });
  });

  it('stops counting at the cap and says there are more', async () => {
    await q('DELETE FROM agency_inbound_calls');
    const { rows } = await q(
      `INSERT INTO agency_inbound_calls (tenant_id, account_id, provider_call_id, to_e164, from_e164, state, outcome, ended_at,
                                         follow_up_status, follow_up_reason)
       SELECT $1::uuid, $2::uuid, 'CA-cap-' || g || '-' || $3::text, '+14155550100', '+447700900123', 'ended', 'closed', now(), 'open', 'closed'
         FROM generate_series(1, 101) g RETURNING id`, [floor.tenant, floor.account, randomUUID()]);
    expect(rows).toHaveLength(101);
    expect((await call('GET', '/missed/count', sup())).json()).toEqual({ open: 100, open_capped: true, has_rows: true });
    await q('DELETE FROM agency_inbound_calls WHERE id = $1', [rows[0]!.id]);
    expect((await call('GET', '/missed/count', sup())).json()).toEqual({ open: 100, open_capped: false, has_rows: true });
    await q('DELETE FROM agency_inbound_calls');
  });
});

describe('POST /inbound/missed/:id/assign: a supervisor`s reassign', () => {
  it('moves an open row to a member or to the account, audits each change once, and the new assignee sees it', async () => {
    const id = await missed({ assignee: agent(0).id });
    expect(idsOf(await call('GET', '/missed', agent(0)))).toContain(id);

    const res = await call('POST', `/missed/${id}/assign`, sup(), { assignee_user_id: agent(1).id });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().call).toMatchObject({ id, assignee_user_id: agent(1).id, assignee_name: 'agent 0.1', assignee_departed: false, status: 'open' });
    expect(idsOf(await call('GET', '/missed', agent(0)))).not.toContain(id);
    expect(idsOf(await call('GET', '/missed', agent(1)))).toContain(id);

    // The same again: answered as it is, not audited twice.
    expect((await call('POST', `/missed/${id}/assign`, sup(), { assignee_user_id: agent(1).id })).statusCode).toBe(200);
    let rows = await audits('agency_inbound_call.reassigned', id);
    expect(rows).toEqual([expect.objectContaining({ user_id: sup().id, account_id: floor.account, details: { from: agent(0).id, to: agent(1).id } })]);

    // To the account (no one in particular): a supervisor's to work.
    const toAccount = await call('POST', `/missed/${id}/assign`, sup(), { assignee_user_id: null });
    expect(toAccount.json().call).toMatchObject({ assignee_user_id: null, assignee_name: null, assignee_departed: false });
    rows = await audits('agency_inbound_call.reassigned', id);
    expect(rows.map((r) => r.details)).toEqual(expect.arrayContaining([{ from: agent(1).id, to: null }]));
    expect(rows).toHaveLength(2);
  });

  it('is a supervisor`s: an agent is refused, even for their own row', async () => {
    const id = await missed({ assignee: agent(0).id });
    const res = await call('POST', `/missed/${id}/assign`, agent(0), { assignee_user_id: agent(1).id });
    expect(res.statusCode).toBe(403);
    expect((await agencyInboundCallRepository.findMissed(floor.tenant, floor.account, id))!.follow_up_assignee_user_id).toBe(agent(0).id);
  });

  it('refuses an outsider, a departed member, a handled row, another account`s row, a malformed id or body', async () => {
    const id = await missed({ assignee: null });
    const invalid = async (assignee: string) => {
      const res = await call('POST', `/missed/${id}/assign`, sup(), { assignee_user_id: assignee });
      expect(res.statusCode, assignee).toBe(400);
      expect(res.json()).toMatchObject({ code: 'inbound_assignee_invalid' });
    };
    await invalid(randomUUID());
    await invalid(other.agents[0]!.id);

    const handled = await missed({ assignee: null });
    await call('POST', `/missed/${handled}/handled`, sup());
    const refused = await call('POST', `/missed/${handled}/assign`, sup(), { assignee_user_id: agent(0).id });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'inbound_missed_call_handled' });

    const inB = await missed({ account: accountB });
    expect((await call('POST', `/missed/${inB}/assign`, sup(), { assignee_user_id: agent(0).id })).json()).toMatchObject({ code: 'inbound_missed_call_not_found' });
    expect((await call('POST', '/missed/not-a-uuid/assign', sup(), { assignee_user_id: agent(0).id })).json()).toMatchObject({ code: 'inbound_missed_call_not_found' });
    expect((await call('POST', `/missed/${id}/assign`, sup(), { assignee: agent(0).id })).statusCode).toBe(400);
    expect((await agencyInboundCallRepository.findMissed(floor.tenant, floor.account, id))!.follow_up_assignee_user_id).toBeNull();
  });

  it('is served with the inbound flag off: the follow-up of calls that came in goes on', async () => {
    const id = await missed({ assignee: null });
    await withFlagOff(async () => {
      const res = await call('POST', `/missed/${id}/assign`, sup(), { assignee_user_id: agent(2).id });
      expect(res.statusCode, res.body).toBe(200);
    });
  });
});

describe('a departed assignee', () => {
  it('reads as departed on the list and cannot be given more rows', async () => {
    const departed = agent(2);
    const id = await missed({ assignee: departed.id });
    await q(`UPDATE memberships SET status = 'revoked' WHERE user_id = $1`, [departed.id]);
    try {
      const rows = (await call('GET', '/missed', sup())).json().rows as Array<Record<string, unknown>>;
      expect(rows.find((r) => r['id'] === id)).toMatchObject({ assignee_user_id: departed.id, assignee_departed: true });
      const res = await call('POST', `/missed/${id}/assign`, sup(), { assignee_user_id: departed.id });
      expect(res.json()).toMatchObject({ code: 'inbound_assignee_invalid' });
      // Reassigned to someone who is here, it is theirs.
      const moved = await call('POST', `/missed/${id}/assign`, sup(), { assignee_user_id: agent(0).id });
      expect(moved.json().call).toMatchObject({ assignee_user_id: agent(0).id, assignee_departed: false });
    } finally {
      await q(`UPDATE memberships SET status = 'active' WHERE user_id = $1`, [departed.id]);
    }
  });
});

describe('a call back from a Missed row that connects', () => {
  it('closes the row as reached by that agent, and the call`s outcome settles the contact`s inbound callback', async () => {
    const phone = '+447700900777';
    const campaign = floor.campaigns[0]!;
    const contact = (await q(
      `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, state) VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
      [campaign, floor.tenant, floor.account, phone])).rows[0]!.id as string;
    const id = await missed({ from: phone, assignee: agent(0).id, contact: { contactId: contact, campaignId: campaign } });
    const due = new Date(Date.now() + 3_600_000);
    expect(await agencyContactRepository.bookInboundCallback({ tenantId: floor.tenant, contactId: contact, dueAt: due })).not.toBeNull();
    const other = await missed({ from: '+447700900778', assignee: agent(0).id });

    // Call back: the soft phone logs to the matched campaign, so the call claims the contact (SP6).
    const claim = await agencyContactRepository.claimForManual(campaign, contact);
    expect(claim.outcome).toBe('claimed');
    const session = (await q(
      `INSERT INTO agency_agent_sessions (kind, campaign_id, tenant_id, account_id, agent_user_id, state, break_reason)
       VALUES ('softphone', NULL, $1, $2, $3, 'break', 'soft_phone') RETURNING id`, [floor.tenant, floor.account, agent(0).id])).rows[0]!.id as string;
    const created = await agencyManualCallRepository.create({
      tenantId: floor.tenant, accountId: floor.account, sessionId: session, agentUserId: agent(0).id, campaignId: campaign,
      contact: { contactId: contact, claimed: true, priorState: 'pending' },
      destinationE164: phone, callerId: '+14155550100', fields: {}, recordingRequested: false, analysisProfileId: null,
      dncOverride: null, hoursOverrideNote: null,
    });
    expect(created.ok).toBe(true);
    const manual = (created as { ok: true; call: { id: string } }).call;
    await agencyManualCallRepository.advanceState(manual.id, 'dialing');
    // Ringing: not reached yet.
    expect(idsOf(await call('GET', '/missed', agent(0)))).toContain(id);
    await agencyManualCallRepository.advanceState(manual.id, 'bridged');

    expect(idsOf(await call('GET', '/missed', agent(0)))).not.toContain(id);
    expect(idsOf(await call('GET', '/missed', agent(0)))).toContain(other);
    const handled = (await call('GET', '/missed?status=handled', agent(0))).json().rows as Array<Record<string, unknown>>;
    expect(handled.find((r) => r['id'] === id)).toMatchObject({
      status: 'handled', handled_reason: 'reached', handled_by_user_id: agent(0).id, handled_by_name: 'agent 0.0',
    });
    // The callback is still booked while the call is live, but the contact is claimed: pacing cannot dial it.
    expect((await q('SELECT state, callback_source FROM agency_contacts WHERE id = $1', [contact])).rows[0])
      .toEqual({ state: 'in_flight', callback_source: 'inbound' });

    // The agent's outcome settles the contact: the inbound callback goes with it.
    await agencyContactRepository.settleFromManual({
      manualCallId: manual.id, decision: { contactState: 'completed', nextAttemptAt: null, suppressedReason: null },
      charge: 'attempt', lastOutcome: 'connected', lastDisposition: 'interested',
    });
    expect((await q('SELECT state, callback_source, callback_due_at FROM agency_contacts WHERE id = $1', [contact])).rows[0])
      .toEqual({ state: 'completed', callback_source: null, callback_due_at: null });
  });
});

describe('GET /inbound/summary', () => {
  const day = (n: number) => new Date(Date.UTC(2026, 10, 2 + n, 10));
  const range = (from: Date, to: Date) => `/summary?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;

  /** An ended call in `account`, arrived at `at`, with `o`'s columns. */
  async function ended(at: Date, o: Record<string, unknown>, account = floor.account, tenant = floor.tenant) {
    const cols = {
      tenant_id: tenant, account_id: account, provider_call_id: `CA-${randomUUID()}`, to_e164: '+14155550100',
      from_e164: '+447700900123', state: 'ended', arrived_at: at, ended_at: new Date(at.getTime() + 300_000), ...o,
    };
    const keys = Object.keys(cols);
    await q(`INSERT INTO agency_inbound_calls (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(cols));
  }
  const answeredBy = (who: string, waitSeconds: number, talk: number, at: Date, sticky: string | null = null) => ({
    outcome: 'answered', bridged_at: new Date(at.getTime() + waitSeconds * 1000), answered_by_user_id: who, talk_seconds: talk,
    ...(sticky ? { sticky_user_id: sticky, sticky_reason: 'owner' } : {}),
  });

  beforeAll(async () => {
    await q('DELETE FROM agency_inbound_calls');
    const a0 = agent(0).id;
    const a1 = agent(1).id;
    // Five answered: waits 10, 20, 30, 40, 100 s.
    await ended(day(0), answeredBy(a0, 10, 60, day(0), a0));
    await ended(day(0), answeredBy(a0, 20, 120, day(0), a1));
    await ended(day(1), answeredBy(a1, 30, 30, day(1)));
    await ended(day(1), answeredBy(a1, 40, 90, day(1), a1));
    await ended(day(2), answeredBy(a0, 100, 0, day(2)));
    // Two abandoned (one had a sticky agent), one overflow, one busy, one queue voicemail.
    await ended(day(2), { outcome: 'abandoned_in_queue', follow_up_status: 'open', follow_up_reason: 'abandoned_in_queue', sticky_user_id: a0, sticky_reason: 'owner' });
    await ended(day(2), { outcome: 'abandoned_in_queue', follow_up_status: 'handled', follow_up_reason: 'abandoned_in_queue', handled_at: day(3), handled_reason: 'marked' });
    await ended(day(3), { outcome: 'overflow', follow_up_status: 'open', follow_up_reason: 'overflow' });
    await ended(day(3), { outcome: 'overflow_no_capacity', follow_up_status: 'open', follow_up_reason: 'overflow_no_capacity' });
    await ended(day(3), { outcome: 'voicemail', voicemail_key: 'vm/q', follow_up_status: 'open', follow_up_reason: 'overflow' });
    // After hours: closed (with a sticky agent: outside the sticky rate), and a voicemail out of hours.
    await ended(day(4), { outcome: 'closed', follow_up_status: 'open', follow_up_reason: 'closed', sticky_user_id: a1, sticky_reason: 'owner' });
    await ended(day(4), { outcome: 'voicemail', voicemail_key: 'vm/c', follow_up_status: 'open', follow_up_reason: 'closed' });
    // Not served: failed and refused.
    await ended(day(4), { outcome: 'failed', follow_up_status: 'open', follow_up_reason: 'failed' });
    await ended(day(4), { outcome: 'rejected' });
    // Outside: before the range, another account, another tenant, and a call still live.
    await ended(day(-3), answeredBy(a0, 5, 5, day(-3)));
    await ended(day(1), answeredBy(a0, 5, 5, day(1)), accountB);
    await ended(day(1), { outcome: 'closed' }, other.account, other.tenant);
    await q(`INSERT INTO agency_inbound_calls (tenant_id, account_id, provider_call_id, to_e164, state, arrived_at, queued_at)
             VALUES ($1, $2, $3, '+14155550100', 'queued', $4, $4)`, [floor.tenant, floor.account, `CA-${randomUUID()}`, day(2)]);
  });

  it('adds up the account`s ended calls in the range', async () => {
    const res = await call('GET', range(day(0), day(7)), sup());
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      from: day(0).toISOString(),
      to: day(7).toISOString(),
      calls: 14,
      open_hours_calls: 11,
      after_hours: 2,
      answered: 5,
      answer_rate_pct: 45.5,
      abandoned: 2,
      abandon_rate_pct: 18.2,
      avg_answer_seconds: 40,
      // 90th percentile, interpolated: 40 + 0.6 × (100 − 40).
      p90_answer_seconds: 76,
      voicemails: 2,
      overflow: 2,
      not_served: 2,
      sticky_calls: 4,
      sticky_answered: 2,
      sticky_hit_rate_pct: 50,
      missed: 8,
      missed_handled: 1,
      agents: [
        { user_id: agent(0).id, name: 'agent 0.0', answered: 3, talk_seconds: 180 },
        { user_id: agent(1).id, name: 'agent 0.1', answered: 2, talk_seconds: 120 },
      ],
    });
  });

  it('a range with nothing in it is zeros and no rates', async () => {
    const res = await call('GET', range(day(20), day(21)), sup());
    expect(res.json()).toMatchObject({
      calls: 0, answered: 0, answer_rate_pct: null, abandon_rate_pct: null, avg_answer_seconds: null, p90_answer_seconds: null,
      sticky_hit_rate_pct: null, agents: [],
    });
  });

  it('is a supervisor`s, validates the range, and is served with the flag off', async () => {
    expect((await call('GET', range(day(0), day(7)), agent(0))).statusCode).toBe(403);
    for (const bad of [range(day(7), day(0)), range(day(0), day(100)), '/summary?from=yesterday&to=today', '/summary']) {
      expect((await call('GET', bad, sup())).statusCode, bad).toBe(400);
    }
    await withFlagOff(async () => {
      const res = await call('GET', range(day(0), day(7)), sup());
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().calls).toBe(14);
    });
  });
});

describe('a Missed row`s voicemail', () => {
  it('is never cached: Cache-Control private, no-store', async () => {
    const key = `inbound-voicemail/${floor.tenant}/${floor.account}/${randomUUID()}.wav`;
    bucket.files.set(key, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(96, 1)]));
    const id = await missed({ assignee: agent(0).id, voicemail: key });
    const res = await call('GET', `/missed/${id}/voicemail`, agent(0));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });
});
