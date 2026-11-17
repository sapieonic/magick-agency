import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT, OTHER_TENANT, insertWebrtcCall } from '../setup/factories.js';
import { insertAgencyAttempt, insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));
vi.mock('../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({ tenantContextMiddleware: async () => {} }));

const { agencyListenHistoryRepository: repo } = await import('../../../src/db/repositories/agency.repository.js');
const { registerListenHistoryRoutes } = await import('../../../src/api/routes/agency/listen-history.js');
const { proxyAgencyListenHistoryRoutes } = await import('../../../src/api/routes/proxy-agency-listen-history.routes.js');
const { errorMaskHook } = await import('../../../src/api/middleware/error-mask.middleware.js');
const { TENANT_HEADER, ACCOUNT_HEADER } = await import('../../../src/api/middleware/headers.js');
const { AGENCY_LISTEN_HISTORY_MERGE_GAP_MS } = await import('@magick-agency/contracts/api/agency/listen-history');
type Deps = import('../../../src/api/routes/proxy-agency-listen-history.routes.js').ListenHistoryRouteDeps;

/**
 * The listening history on real Postgres (docs/listening.md §12, LS19): the statement's merge of a
 * supervisor's sessions on one call into visits (a gap of at most 30 s, overlaps, an open session),
 * the time listened counted once, the last-ended reason, the tenant and account scope, the
 * filters, the keyset pages (ties on the start broken by id, nothing skipped or repeated), the
 * joins that survive a purged call row; then the two layers together (the internal handler and
 * the public routes on this database): the masked numbers, "Withheld", the CSV and its audit row.
 *
 * Mutation-checked: merging on `earlier_ended_at` without the gap (`<= earlier_ended_at`) splits
 * the 10 s reconnect; dropping `earlier_open` splits a session that started while another was open;
 * summing whole durations instead of each session's share counts the overlap twice; dropping
 * `account_id = $2` returns the other account's visit; dropping the `id` tiebreak from the cursor
 * condition skips or repeats a visit at a shared start; dropping `live_at IS NOT NULL` shows a
 * session refused at the upgrade and lets it bridge two visits.
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const pool = () => getTestPool();
const BASE = Date.parse('2026-11-10T10:00:00.000Z');
const at = (s: number) => new Date(BASE + s * 1000);
const iso = (s: number) => at(s).toISOString();

interface Session {
  id?: string;
  listener: string;
  call: string;
  start: number;
  end: number | null;
  reason?: string;
  agent?: string;
  tenant?: string;
  account?: string;
  origin?: 'campaign' | 'manual' | 'inbound';
  campaign?: string | null;
  correlation?: string;
  /** False: a row the upgrade wrote and then refused (`live_at` null, LS22 c). Default true. */
  live?: boolean;
}

const AGENT = randomUUID();

async function session(s: Session): Promise<string> {
  const id = s.id ?? randomUUID();
  const origin = s.origin ?? 'manual';
  await pool().query(
    `INSERT INTO agency_listen_sessions (id, tenant_id, account_id, call_id, origin, campaign_id, correlation_id,
       agent_session_id, agent_user_id, listener_user_id, started_at, ended_at, end_reason, replica_id, live_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'r1', $14)`,
    [id, s.tenant ?? T, s.account ?? A, s.call, origin, origin === 'campaign' ? (s.campaign ?? randomUUID()) : (s.campaign ?? null),
      s.correlation ?? randomUUID(), randomUUID(), s.agent ?? AGENT, s.listener,
      at(s.start), s.end === null ? null : at(s.end), s.end === null ? null : (s.reason ?? 'listener_stopped'),
      s.live === false ? null : at(s.start)],
  );
  return id;
}

const list = (o: Partial<Parameters<typeof repo.listVisits>[0]> = {}) => repo.listVisits({
  tenantId: T, accountId: A, limit: 50, mergeGapMs: AGENCY_LISTEN_HISTORY_MERGE_GAP_MS, ...o,
});

describe('the listening history statement', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('merges a reconnect within the gap, splits past it, and counts the time listened once', async () => {
    const L = randomUUID();
    const C = randomUUID();
    const s1 = await session({ listener: L, call: C, start: 0, end: 60, reason: 'listener_disconnected' });
    const s2 = await session({ listener: L, call: C, start: 70, end: 120, reason: 'listener_stopped' });
    // 80 s after the visit ended: a new visit.
    const s3 = await session({ listener: L, call: C, start: 200, end: 260, reason: 'call_ended' });
    const { rows, hasMore } = await list();
    expect(hasMore).toBe(false);
    expect(rows.map((r) => [r.id, r.listen_ids, Number(r.listened_seconds), r.end_reason])).toEqual([
      [s3, [s3], 60, 'call_ended'],
      [s1, [s1, s2], 110, 'listener_stopped'],
    ]);
    expect(rows[1]!.started_at.toISOString()).toBe(iso(0));
    expect(rows[1]!.ended_at!.toISOString()).toBe(iso(120));
  });

  it('a session that starts while another is open, or overlaps it, joins it; the overlap counts once; the reason is the last to end', async () => {
    const L = randomUUID();
    const C = randomUUID();
    // The console reconnected before the server noticed the old socket was gone.
    const a = await session({ listener: L, call: C, start: 0, end: 100, reason: 'listener_disconnected' });
    const b = await session({ listener: L, call: C, start: 50, end: 200, reason: 'listener_stopped' });
    const { rows } = await list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: a, listen_ids: [a, b], end_reason: 'listener_stopped' });
    expect(Number(rows[0]!.listened_seconds)).toBe(200);

    // Open: the visit has no end, no time and no reason yet; a later reconnect joins it.
    await truncateAll();
    const o1 = await session({ listener: L, call: C, start: 0, end: null });
    const o2 = await session({ listener: L, call: C, start: 600, end: 700, reason: 'superseded' });
    const open = await list();
    expect(open.rows).toHaveLength(1);
    expect(open.rows[0]).toMatchObject({ id: o1, listen_ids: [o1, o2], ended_at: null, listened_seconds: null, end_reason: null });
  });

  it('leaves out a session that never went live, as "Listened to by" does: it neither shows nor joins a visit', async () => {
    const L = randomUUID();
    const C = randomUUID();
    // Refused at the upgrade (row written, never admitted): live_at null.
    await session({ listener: L, call: C, start: 0, end: 1, reason: 'permission_revoked', live: false });
    await session({ listener: randomUUID(), call: randomUUID(), start: 5, end: 6, reason: 'call_ended', live: false });
    expect((await list()).rows).toEqual([]);

    // Between two live sessions 40 s apart it does not bridge them into one visit.
    const a = await session({ listener: L, call: C, start: 100, end: 110 });
    await session({ listener: L, call: C, start: 130, end: 131, reason: 'access_unverified', live: false });
    const b = await session({ listener: L, call: C, start: 150, end: 160 });
    const { rows } = await list();
    expect(rows.map((r) => r.listen_ids)).toEqual([[b], [a]]);
  });

  it('two supervisors on one call, or one on two calls, are separate visits', async () => {
    const C = randomUUID();
    const [L1, L2] = [randomUUID(), randomUUID()];
    await session({ listener: L1, call: C, start: 0, end: 30 });
    await session({ listener: L2, call: C, start: 10, end: 40 });
    await session({ listener: L1, call: randomUUID(), start: 35, end: 50 });
    expect((await list()).rows).toHaveLength(3);
  });

  it('reads only the tenant and account asked for, and filters by supervisor, agent and start', async () => {
    const [L1, L2] = [randomUUID(), randomUUID()];
    const AG2 = randomUUID();
    const mine = await session({ listener: L1, call: randomUUID(), start: 0, end: 10 });
    const other = await session({ listener: L2, call: randomUUID(), start: 100, end: 110, agent: AG2 });
    await session({ listener: L1, call: randomUUID(), start: 5, end: 15, account: OTHER_ACCOUNT });
    await session({ listener: L1, call: randomUUID(), start: 5, end: 15, tenant: OTHER_TENANT });
    expect((await list()).rows.map((r) => r.id)).toEqual([other, mine]);
    expect((await list({ listenerUserId: L1 })).rows.map((r) => r.id)).toEqual([mine]);
    expect((await list({ agentUserId: AG2 })).rows.map((r) => r.id)).toEqual([other]);
    // `to` is exclusive; `from` inclusive.
    expect((await list({ from: at(0), to: at(100) })).rows.map((r) => r.id)).toEqual([mine]);
    expect((await list({ from: at(100) })).rows.map((r) => r.id)).toEqual([other]);
  });

  it('pages newest first by the visit\'s start and id: every visit once, ties on the start included', async () => {
    const ids: string[] = [];
    // Three visits share a start to the microsecond; two more are older.
    for (let i = 0; i < 3; i++) ids.push(await session({ listener: randomUUID(), call: randomUUID(), start: 500, end: 510 }));
    ids.push(await session({ listener: randomUUID(), call: randomUUID(), start: 400, end: 410 }));
    ids.push(await session({ listener: randomUUID(), call: randomUUID(), start: 300, end: 310 }));
    const { decodeKeysetCursor, encodeKeysetCursor } = await import('@magick-agency/domain/keyset-cursor');
    const seen: string[] = [];
    let before: ReturnType<typeof decodeKeysetCursor> = null;
    for (let page = 0; page < 5; page++) {
      const { rows, hasMore } = await list({ limit: 2, before });
      seen.push(...rows.map((r) => r.id));
      if (!hasMore) break;
      const last = rows[rows.length - 1]!;
      before = decodeKeysetCursor(encodeKeysetCursor({ at: last.started_at_key, id: last.id }));
    }
    const tied = ids.slice(0, 3).sort().reverse();
    expect(seen).toEqual([...tied, ids[3], ids[4]]);
  });

  it('LS22 t: a page holds `limit` visits however many reconnects they hold, and says more follow', async () => {
    // The newest visit is three sessions (two reconnects within the gap, one while it was open);
    // two older visits are one each.
    const listener = randomUUID();
    const call = randomUUID();
    const newest = await session({ listener, call, start: 900, end: 950 });
    await session({ listener, call, start: 960, end: 1000 });
    await session({ listener, call, start: 990, end: 1020 });
    const middle = await session({ listener: randomUUID(), call: randomUUID(), start: 800, end: 810 });
    const oldest = await session({ listener: randomUUID(), call: randomUUID(), start: 700, end: 710 });
    const first = await list({ limit: 1 });
    expect(first.rows.map((r) => [r.id, r.listen_ids.length])).toEqual([[newest, 3]]);
    expect(first.hasMore).toBe(true);
    const two = await list({ limit: 2 });
    expect(two.rows.map((r) => r.id)).toEqual([newest, middle]);
    expect(two.hasMore).toBe(true);
    const all = await list({ limit: 3 });
    expect(all.rows.map((r) => r.id)).toEqual([newest, middle, oldest]);
    expect(all.hasMore).toBe(false);
  });

  it('names the call from its rows where they still exist: campaign, contact, number; a purged call row reads null', async () => {
    const campaign = await insertAgencyCampaign({ name: 'Renewals' });
    const contact = await insertAgencyContact(campaign.id, { phone_e164: '+919812345678', context: { name: 'Asha Rao' } });
    const callRow = await insertWebrtcCall({ destination_phone: '+919812345678', campaign_id: campaign.id });
    const attempt = await insertAgencyAttempt(campaign.id, contact.id, { webrtc_call_id: callRow.id });
    const L = randomUUID();
    await session({ listener: L, call: callRow.id, start: 0, end: 10, origin: 'campaign', campaign: campaign.id, correlation: attempt.id });
    await session({ listener: L, call: randomUUID(), start: 100, end: 110 });
    const { rows } = await list();
    expect(rows[1]).toMatchObject({
      origin: 'campaign', campaign_id: campaign.id, campaign_name: 'Renewals', correlation_id: attempt.id,
      customer_phone: '+919812345678', contact_context: expect.objectContaining({ name: 'Asha Rao' }),
    });
    expect(rows[0]).toMatchObject({ customer_phone: null, contact_context: null, campaign_name: null });
  });
});

describe('the listening history routes on this database', () => {
  let core: FastifyInstance;
  let app: FastifyInstance;
  let audit: ReturnType<typeof vi.fn>;
  const SUP = randomUUID();

  beforeEach(async () => {
    await truncateAll();
    core = Fastify({ logger: false });
    await core.register(async (sub) => registerListenHistoryRoutes(sub), { prefix: '/api/v1/agency' });
    await core.ready();
    audit = vi.fn();
    const deps: Deps = {
      listenFlags: async () => ({ enabled: true, unrecordedAllowed: true }),
      callCore: async (req) => {
        const res = await core.inject({
          method: req.method as 'GET', url: `/api/v1${req.path}`, query: req.query ?? {},
          headers: { [TENANT_HEADER]: req.tenantId, [ACCOUNT_HEADER]: req.accountId ?? '' },
        });
        return { status: res.statusCode, body: res.json(), headers: new Headers() };
      },
      names: async () => new Map([[SUP, 'Meera Supervisor'], [AGENT, 'Ravi Agent']]),
      audit: audit as unknown as Deps['audit'],
    };
    app = Fastify({ logger: false });
    app.addHook('onSend', errorMaskHook);
    app.addHook('onRequest', async (request) => {
      const r = request as unknown as Record<string, unknown>;
      r['tenantId'] = T;
      r['accountId'] = A;
      r['user'] = { id: SUP };
      r['membership'] = { role: 'account_admin', account_id: A, status: 'active' };
    });
    await app.register(proxyAgencyListenHistoryRoutes, { prefix: '/proxy/agency', deps });
    await app.ready();
  });

  afterAll(async () => { await app?.close(); await core?.close(); });

  it('a page: names, the number masked, a withheld caller "Withheld", a malformed cursor a 400', async () => {
    const known = await insertWebrtcCall({ destination_phone: '+919812345678', campaign_id: null });
    const withheld = await insertWebrtcCall({ destination_phone: '', campaign_id: null });
    await session({ listener: SUP, call: known.id, start: 0, end: 10 });
    await session({ listener: SUP, call: withheld.id, start: 100, end: 130, reason: 'call_ended' });
    const res = await app.inject({ method: 'GET', url: '/proxy/agency/listen-history?limit=10' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain('9812345678');
    const body = res.json();
    expect(body.next_cursor).toBeNull();
    expect(body.entries[0]).toMatchObject({
      listener_name: 'Meera Supervisor', agent_name: 'Ravi Agent', customer_phone_masked: null, customer_phone_withheld: true,
      listened_seconds: 30, end_reason: 'call_ended', started_at: iso(100),
    });
    expect(body.entries[1]).toMatchObject({ customer_phone_masked: '****5678', customer_phone_withheld: false });
    const bad = await app.inject({ method: 'GET', url: '/proxy/agency/listen-history?cursor=nope' });
    expect([bad.statusCode, bad.json().code]).toEqual([400, 'malformed_cursor']);
  });

  it('the CSV: every page drained, masked numbers only, words for the ending, and one audit row', async () => {
    const known = await insertWebrtcCall({ destination_phone: '+919812345678', campaign_id: null });
    for (let i = 0; i < 120; i++) await session({ listener: SUP, call: i === 0 ? known.id : randomUUID(), start: i * 100, end: i * 100 + 5, reason: 'send_backlog' });
    const res = await app.inject({ method: 'GET', url: `/proxy/agency/listen-history.csv?listener_user_id=${SUP}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['x-export-rows']).toBe('120');
    expect(res.headers['x-export-truncated']).toBeUndefined();
    const lines = res.body.trim().split('\n');
    expect(lines[0]).toBe('started_at,ended_at,listened_seconds,supervisor,supervisor_user_id,agent,agent_user_id,call_type,campaign,inbound_route,customer,customer_phone,how_it_ended,end_reason,sessions,call_id,listen_ids');
    expect(lines).toHaveLength(121);
    expect(res.body).not.toContain('9812345678');
    expect(res.body).toContain('****5678');
    expect(lines[1]).toContain('Connection too slow');
    expect(lines[1]).toContain('Soft phone');
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]![0]).toMatchObject({
      tenant_id: T, account_id: A, action: 'agency_listen_sessions.exported', resource_type: 'account', resource_id: A,
      details: { rows: 120, filters: { listener_user_id: SUP } },
    });
  });
});
