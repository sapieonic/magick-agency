import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * NEW (magick-agency, Phase 8): the runtime routes through the REAL app (`buildApp` with a real
 * context: the agency runtime, real Redis 6383 / this worktree's db, real Postgres 5436), with
 * lane A's real session → tenant-context → RBAC chain (Firebase's token check is the one stub),
 * master's `proxy-agency-agent.routes.ts` and core's `agency.routes.ts` bodies behind `callCore`.
 *
 * What it pins (lead rulings and review findings, Phase 8):
 *  1. **Ownership (access control).** The actor core checks is the AUTHENTICATED user — master's
 *     `resolveAgencyActor` overwrites any `agent_user_id` / `on_behalf` in the body, and the
 *     private core instance is reachable only through `callCore`. Agent A cannot disposition,
 *     hang up, write notes on, or DNC-with-disposition agent B's attempt (403
 *     `not_your_attempt`, nothing written); a session or attempt of another tenant or a sibling
 *     account is a 404; a supervisor may act on behalf.
 *  2. **Session ownership (Q8, Manas 2026-10-09).** Core's `requireOwnedSession` checked tenant
 *     + account + `left_at` only and master passed no actor, so an agent could act on another
 *     agent's session in the SAME account (mint its station token, open its station socket).
 *     Pinned as CURRENT BEHAVIOR until the ruling; now master sends the actor and core refuses a
 *     non-owner with the not-found 404 (supervisors only on `force-available`). The flipped cases
 *     below assert the refusal, the owner's success and the supervisor's reach.
 *  3. **The CONTRACT-DIFF fields are produced**, with real values: `intervals.deferred_hangup_ms`
 *     on the session bootstrap (core's `DEFERRED_HANGUP_MS`) and `callback_requested_at` on a
 *     callback disposition (the instant the agent asked for).
 *  4. **Decision B8, one transaction:** the agent's DNC mark writes the roster suppression, the
 *     optional disposition and the `dnc_entries` row together — a genuine failure of the DNC
 *     insert (a trigger raising inside it) rolls back the suppression and the disposition.
 *     Mutation-checked (see PORTING §8): running the three writes outside the shared client
 *     leaves the contact suppressed and reds case 4.
 *  5. **The station socket at the console's path** refuses a tokenless upgrade (4401), a token
 *     minted for a different session (4401, core's single-use token is bound to its session),
 *     and a path-escaping id (1008).
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'runtime-routes-secret-0123456789';
  return { verifyIdToken: vi.fn() };
});

vi.mock('../../../src/auth/firebase.js', () => ({
  initFirebase: vi.fn(),
  verifyIdToken: mocks.verifyIdToken,
}));

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { closePool, getPool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  insertAccount,
  insertMembership,
  insertTenant,
  insertUser,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { insertAgencyAttempt, insertAgencyCampaign, insertAgencyContact, insertAgentSession } from '../agency/agency-factories.js';
import { config } from '../../../src/config/index.js';
import { buildApp } from '../../../src/app.js';
import type { AppContext } from '../../../src/app-context.js';
import { resetAgencyRuntimeForTests } from '../../../src/bootstrap/agency.js';
import { resetVoiceEngineForTests } from '../../../src/bootstrap/voice.js';
import { DEFERRED_HANGUP_MS } from '@magick-agency/domain/timers';

const CATALOG = JSON.stringify([
  { code: 'interested', label: 'Interested', is_success: true, terminal: true },
  { code: 'callback', label: 'Call back', is_success: false, terminal: false, requires_datetime: true },
]);

let app: FastifyInstance;

/**
 * Q7/Q9 (Manas, 2026-10-09): the app now trusts `TRUST_PROXY_HOPS` proxies, so `request.ip`
 * (the rate limiter's key) reads `raw.socket.remoteAddress` through proxy-addr. `injectWS`
 * builds its upgrade request as a bare object with NO `socket` (a real upgrade always has
 * one), which proxy-addr dereferences — a 500 before the route. The upgrade context supplies
 * the socket address a real connection carries; nothing else about the upgrade changes.
 */
const WS_UPGRADE = { socket: { remoteAddress: '127.0.0.1' } } as unknown as Parameters<FastifyInstance['injectWS']>[1];

interface W {
  tenant: string; account: string; sibling: string;
  otherTenant: string; otherAccount: string;
  agentA: { id: string; tok: string };
  agentB: { id: string; tok: string };
  supervisor: { id: string; tok: string };
  campaign: string; siblingCampaign: string; foreignCampaign: string;
  sessionB: string; attemptB: string; contactB: string;
  siblingSession: string; siblingAttempt: string;
  foreignSession: string; foreignAttempt: string;
}
let w: W;

async function flag(tenantId: string) {
  await getTestPool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value)
     VALUES ('agency_dialer_enabled', 'tenant', $1, 'true'::jsonb)`,
    [tenantId],
  );
}

async function user(tenant: string, account: string, role: string) {
  const u = await insertUser();
  await insertMembership({ user_id: u.id, tenant_id: tenant, account_id: account, role });
  return { id: u.id as string, tok: `tok:${u.firebase_uid as string}` };
}

/** An ended, bridged attempt reserved by `sessionId` on `campaign` — dispositionable. */
async function bridgedAttempt(campaign: string, tenant: string, account: string, sessionId: string, phone: string) {
  const contact = await insertAgencyContact(campaign, { tenant_id: tenant, account_id: account, phone_e164: phone, state: 'connected' });
  const attempt = await insertAgencyAttempt(campaign, contact.id, {
    tenant_id: tenant, account_id: account, state: 'ended', outcome: 'connected',
    reserved_agent_id: sessionId, bridged_at: new Date(Date.now() - 60_000), ended_at: new Date(),
  });
  return { contact: contact.id as string, attempt: attempt.id as string };
}

beforeAll(async () => {
  initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 6 });
  mocks.verifyIdToken.mockImplementation(async (token: string) => {
    if (!token.startsWith('tok:')) throw new Error('bad token');
    return { uid: token.slice(4), email: 'rt@example.com', email_verified: true };
  });
  await flushTestRedis();
  resetVoiceEngineForTests();
  await resetAgencyRuntimeForTests();
  const ctx: AppContext = { config, pool: getPool(), redis: getTestRedis() };
  app = await buildApp({ ctx });
  await app.ready();
});

beforeEach(async () => {
  await truncateAll();
  const tenant = (await insertTenant()).id as string;
  const account = (await insertAccount({ tenant_id: tenant })).id as string;
  const sibling = (await insertAccount({ tenant_id: tenant })).id as string;
  const otherTenant = (await insertTenant()).id as string;
  const otherAccount = (await insertAccount({ tenant_id: otherTenant })).id as string;
  await flag(tenant);
  await flag(otherTenant);
  const agentA = await user(tenant, account, 'agent');
  const agentB = await user(tenant, account, 'agent');
  const supervisor = await user(tenant, account, 'account_admin');

  const base = { status: 'running', disposition_catalog: CATALOG };
  const campaign = (await insertAgencyCampaign({ ...base, tenant_id: tenant, account_id: account })).id as string;
  const siblingCampaign = (await insertAgencyCampaign({ ...base, tenant_id: tenant, account_id: sibling })).id as string;
  const foreignCampaign = (await insertAgencyCampaign({ ...base, tenant_id: otherTenant, account_id: otherAccount })).id as string;

  const sessionB = (await insertAgentSession(campaign, { tenant_id: tenant, account_id: account, agent_user_id: agentB.id, state: 'wrapup' })).id as string;
  const b = await bridgedAttempt(campaign, tenant, account, sessionB, '+919811100001');
  // Other agents' sessions (agent A must stay free to join in the bootstrap case: one live
  // session per agent per tenant, `uq_agency_agent_live_tenant`).
  const siblingSession = (await insertAgentSession(siblingCampaign, { tenant_id: tenant, account_id: sibling, agent_user_id: randomUUID() })).id as string;
  const s = await bridgedAttempt(siblingCampaign, tenant, sibling, siblingSession, '+919811100002');
  const foreignSession = (await insertAgentSession(foreignCampaign, { tenant_id: otherTenant, account_id: otherAccount, agent_user_id: randomUUID() })).id as string;
  const f = await bridgedAttempt(foreignCampaign, otherTenant, otherAccount, foreignSession, '+919811100003');

  w = {
    tenant, account, sibling, otherTenant, otherAccount, agentA, agentB, supervisor,
    campaign, siblingCampaign, foreignCampaign,
    sessionB, attemptB: b.attempt, contactB: b.contact,
    siblingSession, siblingAttempt: s.attempt, foreignSession, foreignAttempt: f.attempt,
  };
});

afterEach(async () => {
  await getTestPool().query('DROP TRIGGER IF EXISTS p8_fail_dnc ON dnc_entries');
  await getTestPool().query('DROP FUNCTION IF EXISTS p8_fail_dnc()');
});

afterAll(async () => {
  await app?.close();
  await resetAgencyRuntimeForTests();
  resetVoiceEngineForTests();
  await closePool();
  await closeTestPool();
  await closeTestRedis();
});

function as(who: { tok: string }, extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${who.tok}`,
    'x-tenant-id': w.tenant,
    'x-account-id': w.account,
    'content-type': 'application/json',
    ...extra,
  };
}

function post(url: string, who: { tok: string }, body: unknown = {}, extra: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url, headers: as(who, extra), payload: JSON.stringify(body) });
}

async function attemptRow(id: string) {
  const { rows } = await getTestPool().query('SELECT disposition_code, notes, dispositioned_by_user_id FROM agency_call_attempts WHERE id = $1', [id]);
  return rows[0];
}
async function contactState(id: string): Promise<string> {
  const { rows } = await getTestPool().query<{ state: string }>('SELECT state FROM agency_contacts WHERE id = $1', [id]);
  return rows[0]!.state;
}
async function dncCount(): Promise<number> {
  const { rows } = await getTestPool().query<{ n: number }>('SELECT count(*)::int AS n FROM dnc_entries');
  return rows[0]!.n;
}

describe('runtime routes through the real app (integration)', () => {
  describe('the session bootstrap', () => {
    it('produces intervals.deferred_hangup_ms (core DEFERRED_HANGUP_MS) and a console-path station URL; the actor is the session user, never the body', async () => {
      const res = await post('/proxy/agency/sessions', w.agentA, {
        campaign_id: w.campaign, agent_user_id: w.agentB.id, on_behalf: true,
      });
      expect(res.statusCode, res.body).toBe(201);
      const body = res.json();
      expect(body.intervals.deferred_hangup_ms).toBe(DEFERRED_HANGUP_MS);
      expect(DEFERRED_HANGUP_MS).toBeGreaterThan(0);
      expect(body.station_ws_url).toMatch(new RegExp(`^/proxy/agency/station/${body.session_id}\\?token=`));
      expect(body.agent_user_id).toBe(w.agentA.id);
      const { rows } = await getTestPool().query('SELECT agent_user_id FROM agency_agent_sessions WHERE id = $1', [body.session_id]);
      expect(rows[0].agent_user_id).toBe(w.agentA.id);
    });

    it("another tenant's or a sibling account's campaign is a 404", async () => {
      for (const campaign_id of [w.foreignCampaign, w.siblingCampaign]) {
        const res = await post('/proxy/agency/sessions', w.agentA, { campaign_id });
        expect(res.statusCode).toBe(404);
      }
    });
  });

  describe("attempt actions on another agent's attempt (same account)", () => {
    it.each([
      ['disposition', { disposition_code: 'interested' }],
      ['hangup', {}],
      ['notes', { notes: 'A was here' }],
      ['dnc', { disposition_code: 'interested' }],
    ] as const)('%s by agent A on agent B\'s attempt is 403 not_your_attempt, and nothing is written', async (action, body) => {
      const before = await attemptRow(w.attemptB);
      const res = await post(`/proxy/agency/attempts/${w.attemptB}/${action}`, w.agentA, body);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().code).toBe('not_your_attempt');
      expect(await attemptRow(w.attemptB)).toEqual(before);
      expect(await contactState(w.contactB)).toBe('connected');
      expect(await dncCount()).toBe(0);
    });

    it('a body naming agent B as the actor changes nothing: master overwrites it with the session user', async () => {
      const res = await post(`/proxy/agency/attempts/${w.attemptB}/disposition`, w.agentA, {
        disposition_code: 'interested', agent_user_id: w.agentB.id, on_behalf: true,
      });
      expect(res.statusCode).toBe(403);
      expect((await attemptRow(w.attemptB)).disposition_code).toBeNull();
    });

    it('the reserved agent B may; a supervisor may on behalf (recorded)', async () => {
      const own = await post(`/proxy/agency/attempts/${w.attemptB}/notes`, w.agentB, { notes: 'mine' });
      expect(own.statusCode, own.body).toBe(200);
      const sup = await post(`/proxy/agency/attempts/${w.attemptB}/disposition`, w.supervisor, { disposition_code: 'interested' });
      expect(sup.statusCode, sup.body).toBe(200);
      const row = await attemptRow(w.attemptB);
      expect(row.disposition_code).toBe('interested');
      expect(row.dispositioned_by_user_id).toBe(w.supervisor.id);
    });

    it('a callback disposition echoes callback_requested_at — the instant asked for — beside next_attempt_at', async () => {
      const asked = new Date(Date.now() + 2 * 24 * 3600_000);
      asked.setUTCHours(10, 30, 0, 0);
      const res = await post(`/proxy/agency/attempts/${w.attemptB}/disposition`, w.agentB, {
        disposition_code: 'callback', callback_at: asked.toISOString(),
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body.callback_requested_at).toBe(asked.toISOString());
      expect(typeof body.next_attempt_at).toBe('string');
    });
  });

  describe('tenant and account isolation for sessions and attempts', () => {
    it.each([
      ['station-token', 'foreignSession'], ['available', 'foreignSession'], ['break', 'foreignSession'],
      ['break/cancel', 'foreignSession'], ['leave', 'foreignSession'],
      ['station-token', 'siblingSession'], ['leave', 'siblingSession'],
    ] as const)('POST /sessions/:id/%s on %s is a 404, never data', async (action, which) => {
      const res = await post(`/proxy/agency/sessions/${w[which]}/${action}`, w.agentA, action === 'break' ? { reason: 'lunch' } : {});
      expect(res.statusCode, res.body).toBe(404);
      expect(res.body).not.toContain('token=');
    });

    it.each([
      ['disposition', 'foreignAttempt'], ['hangup', 'foreignAttempt'], ['notes', 'foreignAttempt'], ['dnc', 'foreignAttempt'],
      ['disposition', 'siblingAttempt'], ['dnc', 'siblingAttempt'],
    ] as const)('POST /attempts/:id/%s on %s is a 404, and nothing is written', async (action, which) => {
      const body = action === 'notes' ? { notes: 'x' } : action === 'disposition' ? { disposition_code: 'interested' } : {};
      const res = await post(`/proxy/agency/attempts/${w[which]}/${action}`, w.supervisor, body);
      expect(res.statusCode, res.body).toBe(404);
      expect(await dncCount()).toBe(0);
    });

    it('force-available: an agent is refused by RBAC; a supervisor on another account\'s session gets a 404', async () => {
      expect((await post(`/proxy/agency/sessions/${w.sessionB}/force-available`, w.agentA)).statusCode).toBe(403);
      expect((await post(`/proxy/agency/sessions/${w.siblingSession}/force-available`, w.supervisor)).statusCode).toBe(404);
    });

    it('a malformed session or attempt id is a 404, never a 500', async () => {
      expect((await post('/proxy/agency/sessions/not-a-uuid/leave', w.agentA)).statusCode).toBe(404);
      expect((await post('/proxy/agency/attempts/not-a-uuid/notes', w.agentA, { notes: 'x' })).statusCode).toBe(404);
    });
  });

  describe('Q8 (Manas, 2026-10-09): session routes act only for the session\'s own agent', () => {
    async function sessionRow(id: string) {
      const { rows } = await getTestPool().query('SELECT state, left_at FROM agency_agent_sessions WHERE id = $1', [id]);
      return rows[0];
    }

    /** Open the station socket and resolve with its first frame or its close code. */
    async function firstStationEvent(url: string) {
      const ws = await app.injectWS(url, WS_UPGRADE);
      const first = await new Promise<{ kind: 'frame'; frame: Record<string, unknown> } | { kind: 'close'; code: number }>((resolve) => {
        ws.on('message', (raw: Buffer) => resolve({ kind: 'frame', frame: JSON.parse(raw.toString()) as Record<string, unknown> }));
        ws.on('close', (code: number) => resolve({ kind: 'close', code }));
      });
      return { ws, first };
    }

    async function closeAndSettle(ws: Awaited<ReturnType<FastifyInstance['injectWS']>>, sessionId: string) {
      const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));
      ws.close();
      await closed;
      // Let the server's close handler finish (offline mirror) before the next truncate.
      const deadline = Date.now() + 5_000;
      for (;;) {
        const { rows } = await getTestPool().query<{ state: string }>('SELECT state FROM agency_agent_sessions WHERE id = $1', [sessionId]);
        if (rows[0]?.state === 'offline' || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    it("agent A cannot mint agent B's station token: the same 404 as a session that does not exist", async () => {
      const res = await post(`/proxy/agency/sessions/${w.sessionB}/station-token`, w.agentA);
      expect(res.statusCode, res.body).toBe(404);
      expect(res.body).not.toContain('token=');
      const missing = await post(`/proxy/agency/sessions/${randomUUID()}/station-token`, w.agentA);
      expect(missing.statusCode).toBe(404);
      expect(res.json()).toEqual(missing.json());
    });

    it.each([
      ['available', {}], ['break', { reason: 'lunch' }], ['break/cancel', {}], ['leave', {}],
    ] as const)("agent A on agent B's session: POST /sessions/:id/%s is a 404 and B's session is untouched", async (action, body) => {
      const before = await sessionRow(w.sessionB);
      const res = await post(`/proxy/agency/sessions/${w.sessionB}/${action}`, w.agentA, body);
      expect(res.statusCode, res.body).toBe(404);
      expect(await sessionRow(w.sessionB)).toEqual(before);
    });

    it("the owner mints their own token, and it opens their own station socket (ready)", async () => {
      const res = await post(`/proxy/agency/sessions/${w.sessionB}/station-token`, w.agentB);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().session_id).toBe(w.sessionB);
      const token = new URL(`http://x${res.json().station_ws_url}`).searchParams.get('token')!;
      const { ws, first } = await firstStationEvent(`/proxy/agency/station/${w.sessionB}?token=${token}`);
      expect(first).toMatchObject({ kind: 'frame', frame: { event: 'ready' } });
      await closeAndSettle(ws, w.sessionB);
    });

    it("a supervisor cannot mint another agent's station token or drive their presence", async () => {
      for (const [action, body] of [['station-token', {}], ['available', {}], ['break', { reason: 'lunch' }], ['leave', {}]] as const) {
        const res = await post(`/proxy/agency/sessions/${w.sessionB}/${action}`, w.supervisor, body);
        expect(res.statusCode, `${action}: ${res.body}`).toBe(404);
      }
    });

    it("a supervisor may force-available another agent's session in their account", async () => {
      const res = await post(`/proxy/agency/sessions/${w.sessionB}/force-available`, w.supervisor, { reason: 'stuck' });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().session_id).toBe(w.sessionB);
    });
  });

  describe('the agent DNC mark is ONE transaction (decision B8)', () => {
    it('a DNC insert that fails rolls back the suppression and the disposition; the route answers a masked 500', async () => {
      await getTestPool().query(`
        CREATE FUNCTION p8_fail_dnc() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'p8 injected dnc failure'; END $$`);
      await getTestPool().query('CREATE TRIGGER p8_fail_dnc BEFORE INSERT ON dnc_entries FOR EACH ROW EXECUTE FUNCTION p8_fail_dnc()');

      const res = await post(`/proxy/agency/attempts/${w.attemptB}/dnc`, w.agentB, { disposition_code: 'interested' });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('p8 injected');
      expect(await contactState(w.contactB)).toBe('connected');
      expect((await attemptRow(w.attemptB)).disposition_code).toBeNull();
      expect(await dncCount()).toBe(0);
    });

    it('the same mark with a healthy table commits all three', async () => {
      const res = await post(`/proxy/agency/attempts/${w.attemptB}/dnc`, w.agentB, { disposition_code: 'interested' });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ contact_state: 'suppressed', dnc_recorded: true, campaign_id: w.campaign });
      expect(await contactState(w.contactB)).toBe('suppressed');
      expect((await attemptRow(w.attemptB)).disposition_code).toBe('interested');
      const { rows } = await getTestPool().query('SELECT campaign_id, source, added_by FROM dnc_entries');
      expect(rows).toEqual([{ campaign_id: w.campaign, source: 'agent', added_by: w.agentB.id }]);
    });
  });

  describe('the station socket at /proxy/agency/station/:sessionId', () => {
    async function closeCode(url: string): Promise<number> {
      const ws = await app.injectWS(url, WS_UPGRADE);
      return new Promise<number>((resolve) => ws.on('close', (code: number) => resolve(code)));
    }

    it('refuses a tokenless upgrade with 4401 and a path-escaping id with 1008', async () => {
      expect(await closeCode(`/proxy/agency/station/${w.sessionB}`)).toBe(4401);
      // `%2E%2E` decodes to `..`, a traversal segment once interpolated into the core path.
      expect(await closeCode('/proxy/agency/station/%2E%2E?token=t')).toBe(1008);
    });

    it("refuses a token minted for a different session (4401): the token is bound to its session", async () => {
      const minted = await post(`/proxy/agency/sessions/${w.sessionB}/station-token`, w.agentB);
      expect(minted.statusCode).toBe(200);
      const token = new URL(`http://x${minted.json().station_ws_url}`).searchParams.get('token')!;
      const other = (await insertAgentSession(w.campaign, { tenant_id: w.tenant, account_id: w.account, agent_user_id: w.agentA.id })).id;
      expect(await closeCode(`/proxy/agency/station/${other}?token=${token}`)).toBe(4401);
    });
  });
});
