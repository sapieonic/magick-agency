import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, insertTenant } from '../setup/factories.js';
import { parseInboundRouteCreate } from '../../../src/agency/inbound/route-config.js';
import { AgencyInboundCallRouter } from '../../../src/agency/inbound/inbound-call-router.js';
import { agencyInboundRouteRepository } from '../../../src/db/repositories/agency.repository.js';
import type { InboundCallArrival } from '../../../src/seams/inbound-call-router.js';
import type { WebRtcInboundAcceptance } from '../../../src/core/webrtc-bridge-manager.js';

/**
 * Why a call was answered closed (`agency_inbound_calls.closed_cause`, 0030; docs/inbound.md §11),
 * stamped by the router at arrival on real Postgres, the bridge faked: out of the route's `hours`,
 * the kill switch (`switched_off`), a number that reaches `no_route` (a matched caller's account,
 * and the tenant default), and a carrier credential that is not active (`credential_inactive`). A
 * caller the route is open for carries none. The inbound summary counts the four apart, and the
 * Missed list words a row by it.
 *
 * Mutation-checked: making the router's cause `hours` for every closed plan turns the switched-off,
 * no-route and inactive-credential cases red; dropping `closedCause` from the insert turns every
 * case but the open one red.
 */

const X = DEFAULTS.tenantId;
const XA = DEFAULTS.accountId;
const CALLER = '+447700900123';
const pool = () => getTestPool();

let plivoId: string;
let cred: string;
let seq = 0;

async function linkedNumber(): Promise<{ id: string; e164: string }> {
  const e164 = `+1415557${String(1000 + ++seq).padStart(4, '0')}`;
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO phone_numbers (phone_number, provider_id, telephony_credential_id, status, inbound_linked_at)
     VALUES ($1, $2, $3, 'active', now()) RETURNING id`,
    [e164, plivoId, cred]);
  await pool().query('INSERT INTO tenant_phone_assignments (tenant_id, phone_number_id) VALUES ($1, $2)', [X, rows[0]!.id]);
  return { id: rows[0]!.id, e164 };
}

const ALWAYS = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '00:00', end: '24:00' }));

/** A route of the account answering a fresh linked number: open always, or never (`weekly_hours: []`). */
async function routedNumber(o: Record<string, unknown> = {}): Promise<string> {
  const n = await linkedNumber();
  const parsed = parseInboundRouteCreate({ name: `Route ${++seq}`, timezone: 'UTC', weekly_hours: ALWAYS, ...o });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const created = await agencyInboundRouteRepository.create({ tenantId: X, accountId: XA, createdBy: null, config: parsed.config });
  if (!created.ok) throw new Error(created.reason);
  const attached = await agencyInboundRouteRepository.attachNumber({ tenantId: X, accountId: XA, routeId: created.route.id, phoneNumberId: n.id, attachedBy: null });
  if (!attached.ok) throw new Error(attached.reason);
  return n.e164;
}

const ADMITTED: WebRtcInboundAcceptance = { accepted: true, streamUrl: 'wss://agency.test/stream', maxDurationSeconds: 1800, capacity: 'admitted' };

function harness(enabled = true) {
  const bridge = {
    acceptInboundCall: vi.fn(async (): Promise<WebRtcInboundAcceptance> => ADMITTED),
    playClipSequenceThenHangUp: vi.fn(async () => 'completed' as const),
  };
  return new AgencyInboundCallRouter({
    bridge: bridge as never,
    dnc: { check: async () => 'clear', checkEntry: async () => ({ result: 'clear' }) } as never,
    connect: { connector: null, enabled: async () => enabled, mediaWorkers: 0 },
  });
}

const arrival = (toE164: string, o: Partial<InboundCallArrival> = {}): InboundCallArrival => ({
  credentialId: cred, tenantId: X, provider: 'plivo', credentialStatus: 'active',
  carrierCallId: `CA-${randomUUID()}`, fromE164: CALLER, toE164, ...o,
});

async function answered(router: AgencyInboundCallRouter, a: InboundCallArrival) {
  await router.answer(a);
  await router.drain();
  const { rows } = await pool().query<{ account_id: string | null; outcome: string; follow_up_reason: string | null; closed_cause: string | null }>(
    'SELECT account_id, outcome, follow_up_reason, closed_cause FROM agency_inbound_calls WHERE provider_call_id = $1', [a.carrierCallId]);
  return rows[0]!;
}

beforeAll(() => {
  initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });
});

beforeEach(async () => {
  await truncateAll();
  plivoId = (await pool().query<{ id: string }>(`INSERT INTO telephony_providers (name, display_name) VALUES ('plivo', 'Plivo') RETURNING id`)).rows[0]!.id;
  await insertTenant({ id: X });
  await pool().query(`INSERT INTO accounts (id, tenant_id, name, slug) VALUES ($1, $2, 'Acct', $3)`, [XA, X, `a-${randomUUID()}`]);
  cred = (await pool().query<{ id: string }>(
    `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref) VALUES ($1, 'plivo', 'Main', 'MACCCCCCCCCCCCCCCCCC') RETURNING id`, [X])).rows[0]!.id;
});

afterAll(async () => {
  // 0024's Down refuses while inbound calls exist: leave none for the down → up suites.
  await truncateAll();
  await closePool();
});

describe('closed_cause: why the answer treated the caller as closed', () => {
  it('out of the route`s hours: `hours`', async () => {
    const to = await routedNumber({ weekly_hours: [] });
    expect(await answered(harness(), arrival(to))).toEqual({ account_id: XA, outcome: 'closed', follow_up_reason: 'closed', closed_cause: 'hours' });
  });

  it('the kill switch on an open route: `switched_off`', async () => {
    const to = await routedNumber();
    expect(await answered(harness(false), arrival(to))).toEqual({ account_id: XA, outcome: 'closed', follow_up_reason: 'closed', closed_cause: 'switched_off' });
  });

  it('the kill switch outside the route`s hours: still `switched_off` (the switch, not the hours, closed it)', async () => {
    const to = await routedNumber({ weekly_hours: [] });
    expect((await answered(harness(false), arrival(to))).closed_cause).toBe('switched_off');
  });

  it('a credential that is not active: `credential_inactive`, whatever the route`s hours', async () => {
    const to = await routedNumber();
    expect(await answered(harness(), arrival(to, { credentialStatus: 'disabled' })))
      .toEqual({ account_id: XA, outcome: 'closed', follow_up_reason: 'closed', closed_cause: 'credential_inactive' });
  });

  it('a number with no route: `no_route`, for a matched caller`s account and for the tenant default', async () => {
    const bare = await linkedNumber();
    expect(await answered(harness(), arrival(bare.e164)))
      .toEqual({ account_id: null, outcome: 'closed', follow_up_reason: 'closed', closed_cause: 'no_route' });

    // A caller on the account's roster: the call is the account's, and still has no route.
    const { rows: [campaign] } = await pool().query<{ id: string }>(
      `INSERT INTO agency_campaigns (tenant_id, account_id, name, caller_ids, status) VALUES ($1, $2, 'C', ARRAY['+14155550100'], 'paused') RETURNING id`,
      [X, XA]);
    await pool().query(
      `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164) VALUES ($1, $2, $3, $4)`, [campaign!.id, X, XA, CALLER]);
    expect(await answered(harness(), arrival(bare.e164)))
      .toEqual({ account_id: XA, outcome: 'closed', follow_up_reason: 'closed', closed_cause: 'no_route' });
  });

  it('a caller the route is open for carries none', async () => {
    const to = await routedNumber();
    expect(await answered(harness(), arrival(to))).toMatchObject({ account_id: XA, outcome: 'overflow', closed_cause: null });
  });
});

/**
 * IQ52: the route's wrap-up window is captured on the call at arrival (`wrapup_seconds`, 0032), so
 * an edit of the route afterwards never moves the countdown of a call already taken; a call with
 * no route captures none. Mutation-checked: dropping `wrapupSeconds` from the router's insert turns
 * this red.
 */
describe('wrapup_seconds: the route`s window, captured at arrival (IQ52)', () => {
  const windowOf = async (carrierCallId: string) => (await pool().query<{ wrapup_seconds: number | null }>(
    'SELECT wrapup_seconds FROM agency_inbound_calls WHERE provider_call_id = $1', [carrierCallId])).rows[0]!.wrapup_seconds;

  it('the route`s window on the call, unchanged by a later edit of the route; none without a route', async () => {
    const to = await routedNumber({ wrapup_seconds: 75 });
    const a = arrival(to);
    await answered(harness(), a);
    expect(await windowOf(a.carrierCallId)).toBe(75);
    await pool().query('UPDATE agency_inbound_routes SET wrapup_seconds = 20');
    expect(await windowOf(a.carrierCallId)).toBe(75);
    const b = arrival(to);
    await answered(harness(), b);
    expect(await windowOf(b.carrierCallId)).toBe(20);

    const bare = await linkedNumber();
    const c = arrival(bare.e164);
    await answered(harness(), c);
    expect(await windowOf(c.carrierCallId)).toBeNull();
  });
});
