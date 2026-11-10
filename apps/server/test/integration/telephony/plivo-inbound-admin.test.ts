/**
 * Inbound on a tenant's Plivo credential, the operator side (docs/inbound.md §8.1, §8.2, IB6),
 * end to end: the real app's super-admin routes (a signed super-admin JWT), the inbound service,
 * the credential service opening the secret with a real sealer, the Plivo adapter on its fixed
 * host reaching the mock carrier through `setPlivoTransportForTests`, real Postgres.
 *
 * Covers: Enable / Health / Re-point / Disable of the Application; Link / Unlink of a number
 * (its previous app kept and restored); the §8.2 cascade from unassign and a sync that retires the
 * number; a credential disable that keeps every link and route, and an enable that answers them
 * again; revoke refused while inbound is enabled; and the partial failures (the carrier accepts
 * and our write fails, and the other way round).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(process.env, {
    FF_AGENCY_DIALER: 'true',
    PLIVO_WEBHOOK_BASE_URL: 'https://agency.test/api/v1/webhooks/plivo',
    VOICELINK_WEBHOOK_BASE_URL: 'https://agency.test/api/v1/webhooks/voicelink',
    PLIVO_REQUEST_TIMEOUT_MS: '3000',
    LOG_LEVEL: 'warn',
    SUPER_ADMIN_JWT_SECRET: 'inbound-admin-test-secret-0123456789',
  });
});

import jwt from 'jsonwebtoken';
import { telephonyCredentialRepository } from '@magick-agency/db/repositories/telephony-credential.repository';
import { getTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import { trackSuperAdminAuditWrites } from '../../helpers/drain-super-admin-audit.js';
import { agencyInboundRouteRepository } from '../../../src/db/repositories/agency.repository.js';
import { parseInboundRouteCreate } from '../../../src/agency/inbound/route-config.js';
import { hashInboundToken } from '../../../src/telephony/plivo/inbound-token.js';
import { splitInboundToken } from '../../../src/telephony/plivo/inbound-urls.js';
import { ACCOUNT, ADMIN, CALLER_ID, PLIVO_NUMBER, TENANT, closePlivoDb, initPlivoDb, startPlivoRig, type PlivoRig } from './plivo-rig.js';

const BASE = 'https://agency.test/api/v1/webhooks/plivo';
const audit = trackSuperAdminAuditWrites();
let rig: PlivoRig;
let auth: { authorization: string };
let numberId: string;
const THEIR_APP = '18000000000000001';

async function auditRows(action: string): Promise<Array<{ resource_id: string; details: Record<string, unknown> }>> {
  await audit.drain();
  const { rows } = await getTestPool().query<{ resource_id: string; details: Record<string, unknown> }>(
    'SELECT resource_id, details FROM super_admin_audit_log WHERE action = $1 ORDER BY created_at', [action]);
  return rows;
}

const post = (url: string) => rig.app.inject({ method: 'POST', url: `/super-admin${url}`, headers: auth });
const get = (url: string) => rig.app.inject({ method: 'GET', url: `/super-admin${url}`, headers: auth });
const enable = () => post(`/telephony-credentials/${rig.credentialId}/inbound/enable`);
const link = () => post(`/phone-numbers/${numberId}/inbound/link`);
const unlink = () => post(`/phone-numbers/${numberId}/inbound/unlink`);
const ourApp = () => [...rig.carrier.applications.values()].find((a) => a.app_name === `inbound-${rig.credentialId}`);

async function numberRow() {
  const { rows } = await getTestPool().query<{ inbound_linked_at: Date | null; inbound_previous_app_id: string | null; status: string }>(
    'SELECT inbound_linked_at, inbound_previous_app_id, status FROM phone_numbers WHERE id = $1', [numberId]);
  return rows[0]!;
}

async function routeWithNumber(): Promise<string> {
  const parsed = parseInboundRouteCreate({ name: 'Main line', timezone: 'Asia/Kolkata' });
  if (!parsed.ok) throw new Error('route config refused');
  const created = await agencyInboundRouteRepository.create({ tenantId: TENANT, accountId: ACCOUNT, createdBy: null, config: parsed.config });
  if (!created.ok) throw new Error('route create refused');
  const attached = await agencyInboundRouteRepository.attachNumber({
    tenantId: TENANT, accountId: ACCOUNT, routeId: created.route.id, phoneNumberId: numberId, attachedBy: null,
  });
  if (!attached.ok) throw new Error(`attach refused: ${attached.reason}`);
  return created.route.id;
}

async function liveRoute(): Promise<string | null> {
  const { rows } = await getTestPool().query<{ route_id: string }>(
    'SELECT route_id FROM agency_inbound_route_numbers WHERE phone_number_id = $1 AND detached_at IS NULL', [numberId]);
  return rows[0]?.route_id ?? null;
}

describe('inbound on a Plivo credential, operator side (integration, mock Plivo)', () => {
  beforeAll(() => initPlivoDb());

  beforeEach(async () => {
    await audit.drain();
    rig = await startPlivoRig({ bootstraps: false });
    auth = { authorization: `Bearer ${jwt.sign({ sub: ADMIN, email: 'plivo-e2e@example.com', type: 'super_admin' }, process.env['SUPER_ADMIN_JWT_SECRET']!)}` };
    numberId = (await getTestPool().query<{ id: string }>('SELECT id FROM phone_numbers WHERE phone_number = $1', [CALLER_ID])).rows[0]!.id;
    // The tenant's number already answers on an app of theirs (an IVR): Link must keep it, Unlink restore it.
    rig.carrier.addApplication({
      app_id: THEIR_APP, app_name: 'Their IVR', answer_url: 'https://ivr.example.net/answer', answer_method: 'POST',
      hangup_url: '', hangup_method: 'POST', fallback_answer_url: '', fallback_method: 'POST',
    });
    rig.carrier.numbers.find((n) => n.number === PLIVO_NUMBER)!.app_id = THEIR_APP;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rig.stop();
  });

  afterAll(async () => {
    await audit.drain();
    audit.restore();
    await closePlivoDb();
  });

  describe('the Application', () => {
    it('Enable creates one Application with our URLs and the token; stores the URLs without it and only the token`s hash', async () => {
      const res = await enable();
      expect(res.statusCode).toBe(200);
      const app = ourApp()!;
      expect(rig.carrier.applications.size).toBe(2);
      expect(res.json().inbound).toMatchObject({ enabled: true, app_id: app.app_id, linked_numbers: 0 });
      expect(res.json().webhook_base_configured).toBe(true);
      const answer = splitInboundToken(app.answer_url)!;
      expect(answer.stored).toBe(`${BASE}/inbound-answer/${rig.credentialId}`);
      expect(splitInboundToken(app.hangup_url)!.stored).toBe(`${BASE}/inbound-status/${rig.credentialId}`);
      expect(splitInboundToken(app.hangup_url)!.token).toBe(answer.token);
      expect(app).toMatchObject({ answer_method: 'POST', hangup_method: 'POST', fallback_answer_url: `${BASE}/inbound-fallback`, fallback_method: 'POST' });

      const stored = await telephonyCredentialRepository.findInbound(rig.credentialId);
      expect(stored).toMatchObject({
        app_id: app.app_id, answer_url: answer.stored, hangup_url: `${BASE}/inbound-status/${rig.credentialId}`,
        fallback_answer_url: `${BASE}/inbound-fallback`,
      });
      expect(await telephonyCredentialRepository.inboundTokenMatches(rig.credentialId, hashInboundToken(answer.token!))).toBe(true);
      // The token is nowhere in our database, the response or the audit trail.
      const dump = JSON.stringify((await getTestPool().query('SELECT * FROM telephony_credentials WHERE id = $1', [rig.credentialId])).rows);
      expect(dump).not.toContain(answer.token);
      expect(res.body).not.toContain(answer.token);
      const rows = await auditRows('telephony_credential.inbound_enabled');
      expect(rows).toEqual([{ resource_id: rig.credentialId, details: expect.objectContaining({ app_id: app.app_id, tenant_id: TENANT, adopted_existing_application: false }) }]);
      expect(JSON.stringify(rows)).not.toContain(answer.token);
      expect(rig.carrier.offHost).toEqual([]);

      // Twice: refused, and no second Application.
      const again = await enable();
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe('inbound_enabled');
      expect(rig.carrier.requestsTo('create_application')).toHaveLength(1);
    });

    it('Health: ok, then url_mismatch naming the URL changed in Plivo`s console, then app_missing, and unreachable', async () => {
      await enable();
      const health = async () => (await get(`/telephony-credentials/${rig.credentialId}/inbound/health`)).json().health;
      expect(await health()).toMatchObject({ health: 'ok', mismatched: [], stored_urls_current: true });

      const app = ourApp()!;
      const original = app.answer_url;
      app.answer_url = 'https://someone-else.example.com/answer';
      app.fallback_method = 'GET';
      expect(await health()).toMatchObject({ health: 'url_mismatch', mismatched: ['answer_url', 'fallback_answer_url'] });
      // The right URL with a token that is not ours is a mismatch too.
      app.answer_url = `${splitInboundToken(original)!.stored}?token=forged`;
      app.fallback_method = 'POST';
      expect(await health()).toMatchObject({ health: 'url_mismatch', mismatched: ['answer_url'] });

      rig.carrier.injectFault('get_application', { kind: 'status', status: 503 });
      expect(await health()).toMatchObject({ health: 'unreachable' });

      rig.carrier.applications.delete(app.app_id);
      expect(await health()).toMatchObject({ health: 'app_missing', mismatched: [] });
    });

    it('Re-point gives the Application a new token and keeps the old one for its grace; a missing Application is made again and the linked numbers moved onto it', async () => {
      await enable();
      expect((await link()).statusCode).toBe(200);
      const first = ourApp()!;
      const oldToken = splitInboundToken(first.answer_url)!.token!;
      const res = await post(`/telephony-credentials/${rig.credentialId}/inbound/repoint`);
      expect(res.statusCode).toBe(200);
      const newToken = splitInboundToken(ourApp()!.answer_url)!.token!;
      expect(newToken).not.toBe(oldToken);
      expect(await telephonyCredentialRepository.inboundTokenMatches(rig.credentialId, hashInboundToken(newToken))).toBe(true);
      expect(await telephonyCredentialRepository.inboundTokenMatches(rig.credentialId, hashInboundToken(oldToken))).toBe(true);
      expect(res.json().inbound.previous_token_expires_at).not.toBeNull();

      // Someone deleted the Application in Plivo's console: Re-point makes it again and moves the number.
      rig.carrier.applications.delete(first.app_id);
      rig.carrier.numbers.find((n) => n.number === PLIVO_NUMBER)!.app_id = null;
      const again = await post(`/telephony-credentials/${rig.credentialId}/inbound/repoint`);
      expect(again.statusCode).toBe(200);
      const second = ourApp()!;
      expect(second.app_id).not.toBe(first.app_id);
      expect(again.json().inbound.app_id).toBe(second.app_id);
      expect(rig.carrier.numberApp(PLIVO_NUMBER)).toBe(second.app_id);
      // The link and its previous app are kept.
      expect(await numberRow()).toMatchObject({ inbound_previous_app_id: THEIR_APP });
      const rows = await auditRows('telephony_credential.inbound_repointed');
      expect(rows[1]!.details).toMatchObject({ app_id: second.app_id, replaced_app_id: first.app_id, moved_numbers: [CALLER_ID] });
    });

    it('a second Re-point is refused while a call answered before the first is still live (its hangup carries the token it would drop); a call answered since does not block it', async () => {
      await enable();
      const liveCall = async (arrivedAt: string) => (await getTestPool().query<{ id: string }>(
        `INSERT INTO agency_inbound_calls (tenant_id, provider, telephony_credential_id, provider_call_id, to_e164, state, arrived_at)
         VALUES ($1, 'plivo', $2, $3, $4, 'greeting', ${arrivedAt}) RETURNING id`,
        [TENANT, rig.credentialId, `CA-${Math.random().toString(36).slice(2)}`, CALLER_ID])).rows[0]!.id;
      const before = await liveCall(`now() - interval '1 minute'`);
      const original = splitInboundToken(ourApp()!.answer_url)!.token!;
      expect((await post(`/telephony-credentials/${rig.credentialId}/inbound/repoint`)).statusCode).toBe(200);
      const afterFirst = splitInboundToken(ourApp()!.answer_url)!.token!;
      await liveCall(`now() + interval '1 minute'`);

      const refused = await post(`/telephony-credentials/${rig.credentialId}/inbound/repoint`);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toBe('inbound_previous_token_in_use');
      // Nothing changed: the carrier keeps the first Re-point's token, and both tokens still match.
      expect(splitInboundToken(ourApp()!.answer_url)!.token).toBe(afterFirst);
      expect(await telephonyCredentialRepository.inboundTokenMatches(rig.credentialId, hashInboundToken(original))).toBe(true);
      expect(await telephonyCredentialRepository.inboundTokenMatches(rig.credentialId, hashInboundToken(afterFirst))).toBe(true);

      // The call from before the first Re-point ends: the original token is needed no more.
      await getTestPool().query(`UPDATE agency_inbound_calls SET state = 'ended', outcome = 'failed', ended_at = now() WHERE id = $1`, [before]);
      expect((await post(`/telephony-credentials/${rig.credentialId}/inbound/repoint`)).statusCode).toBe(200);
      expect(await telephonyCredentialRepository.inboundTokenMatches(rig.credentialId, hashInboundToken(original))).toBe(false);
      // The call answered since keeps its token through its grace.
      expect(await telephonyCredentialRepository.inboundTokenMatches(rig.credentialId, hashInboundToken(afterFirst))).toBe(true);
      await getTestPool().query(`UPDATE agency_inbound_calls SET state = 'ended', outcome = 'failed', ended_at = now() WHERE state <> 'ended'`);
    });

    it('Disable is refused while a number is linked, then deletes the Application and forgets it; revoke is refused until then', async () => {
      await enable();
      await link();
      const refused = await post(`/telephony-credentials/${rig.credentialId}/inbound/disable`);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toBe('inbound_numbers_linked');
      const revoke = await post(`/telephony-credentials/${rig.credentialId}/revoke`);
      expect(revoke.statusCode).toBe(409);
      expect(revoke.json()).toMatchObject({ error: 'inbound_enabled' });
      expect(revoke.json().message).toMatch(/1 number is linked/);

      await unlink();
      const appId = ourApp()!.app_id;
      const off = await post(`/telephony-credentials/${rig.credentialId}/inbound/disable`);
      expect(off.statusCode).toBe(200);
      expect(off.json().inbound).toMatchObject({ enabled: false, app_id: null });
      expect(rig.carrier.applications.has(appId)).toBe(false);
      expect((await auditRows('telephony_credential.inbound_disabled'))[0]!.details).toMatchObject({ app_id: appId, application_deleted: true });
      expect((await post(`/telephony-credentials/${rig.credentialId}/revoke`)).statusCode).toBe(200);
    });

    it('Disable that Plivo cannot answer changes nothing; one Plivo has already lost is done', async () => {
      await enable();
      rig.carrier.injectFault('delete_application', { kind: 'status', status: 503 });
      const failed = await post(`/telephony-credentials/${rig.credentialId}/inbound/disable`);
      expect(failed.statusCode).toBe(502);
      expect((await telephonyCredentialRepository.findInbound(rig.credentialId))!.app_id).toBe(ourApp()!.app_id);
      rig.carrier.applications.delete(ourApp()!.app_id);
      const done = await post(`/telephony-credentials/${rig.credentialId}/inbound/disable`);
      expect(done.statusCode).toBe(200);
      expect((await auditRows('telephony_credential.inbound_disabled'))[0]!.details).toMatchObject({ application_already_gone: true });
    });

    it('a dead account (the carrier refuses the credential, which is disabled) can still forget its Application, audited for removal by hand', async () => {
      await enable();
      const appId = ourApp()!.app_id;
      expect((await post(`/telephony-credentials/${rig.credentialId}/disable`)).statusCode).toBe(200);
      rig.carrier.rotateAuthToken('tenantRotatedTheirToken-0002');
      const off = await post(`/telephony-credentials/${rig.credentialId}/inbound/disable`);
      expect(off.statusCode).toBe(200);
      expect(rig.carrier.applications.has(appId)).toBe(true);
      expect((await auditRows('telephony_credential.inbound_disabled'))[0]!.details).toMatchObject({ app_id: appId, application_deleted: false });
    });

    it('an active credential the carrier refuses cannot forget its Application', async () => {
      await enable();
      rig.carrier.rotateAuthToken('tenantRotatedTheirToken-0002');
      const off = await post(`/telephony-credentials/${rig.credentialId}/inbound/disable`);
      expect(off.statusCode).toBe(422);
      expect(off.json().error).toBe('carrier_rejected');
      expect((await telephonyCredentialRepository.findInbound(rig.credentialId))!.app_id).not.toBeNull();
    });

    it('Enable without a public callback base is refused (503 inbound_unconfigured) before anything reaches Plivo', async () => {
      const { config } = await import('../../../src/config/index.js');
      const saved = config.telephony.plivo.webhookBaseUrl;
      config.telephony.plivo.webhookBaseUrl = '';
      try {
        const res = await enable();
        expect(res.statusCode).toBe(503);
        expect(res.json().error).toBe('inbound_unconfigured');
        expect(rig.carrier.requestsTo('create_application')).toHaveLength(0);
        expect((await get(`/telephony-credentials/${rig.credentialId}/inbound`)).json().webhook_base_configured).toBe(false);
      } finally {
        config.telephony.plivo.webhookBaseUrl = saved;
      }
    });
  });

  describe('partial failures of Enable', () => {
    it('Plivo created the Application and our write failed: it is deleted on the spot, and the retry makes one', async () => {
      vi.spyOn(telephonyCredentialRepository, 'enableInbound').mockRejectedValueOnce(new Error('database went away'));
      expect((await enable()).statusCode).toBe(500);
      expect(ourApp()).toBeUndefined();
      expect((await telephonyCredentialRepository.findInbound(rig.credentialId))!.app_id).toBeNull();
      expect((await enable()).statusCode).toBe(200);
      expect([...rig.carrier.applications.values()].filter((a) => a.app_name === `inbound-${rig.credentialId}`)).toHaveLength(1);
    });

    it('…and the delete failed too: the retry finds the orphan by name and adopts it, creating none', async () => {
      vi.spyOn(telephonyCredentialRepository, 'enableInbound').mockRejectedValueOnce(new Error('database went away'));
      rig.carrier.injectFault('delete_application', { kind: 'status', status: 503 });
      expect((await enable()).statusCode).toBe(500);
      const orphan = ourApp()!;
      expect(orphan).toBeDefined();
      const res = await enable();
      expect(res.statusCode).toBe(200);
      expect(res.json().inbound.app_id).toBe(orphan.app_id);
      expect(rig.carrier.requestsTo('create_application')).toHaveLength(1);
      // Adopted with this Enable's token, which is the stored one.
      const token = splitInboundToken(ourApp()!.answer_url)!.token!;
      expect(await telephonyCredentialRepository.inboundTokenMatches(rig.credentialId, hashInboundToken(token))).toBe(true);
      expect((await auditRows('telephony_credential.inbound_enabled'))[0]!.details).toMatchObject({ adopted_existing_application: true });
    });

    it('Plivo refused the create: nothing is stored', async () => {
      rig.carrier.injectFault('create_application', { kind: 'status', status: 400 });
      const res = await enable();
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe('carrier_refused');
      expect((await telephonyCredentialRepository.findInbound(rig.credentialId))!.app_id).toBeNull();
    });
  });

  describe('numbers', () => {
    it('Link keeps the number`s previous app and puts it on the Application; Unlink restores it and detaches its route', async () => {
      const before = await get(`/phone-numbers/${numberId}/inbound`);
      expect(before.json()).toMatchObject({ link: { linked: false }, link_blocker: 'inbound_not_enabled', credential: { id: rig.credentialId, inbound_enabled: false } });
      const early = await link();
      expect(early.statusCode).toBe(409);
      expect(early.json().error).toBe('phone_number_not_linkable');

      await enable();
      const appId = ourApp()!.app_id;
      const linked = await link();
      expect(linked.statusCode).toBe(200);
      expect(linked.json()).toMatchObject({ link: { linked: true, previous_app_id: THEIR_APP, route: null }, link_blocker: null });
      expect(rig.carrier.numberApp(PLIVO_NUMBER)).toBe(appId);
      expect((await auditRows('phone_number.inbound_linked'))[0]!.details).toMatchObject({ phone_number: CALLER_ID, app_id: appId, previous_app_id: THEIR_APP });
      // Twice: nothing more happens (the carrier is not asked again).
      const updates = rig.carrier.requestsTo('update_number').length;
      expect((await link()).statusCode).toBe(200);
      expect(rig.carrier.requestsTo('update_number')).toHaveLength(updates);

      const routeId = await routeWithNumber();
      expect((await get(`/phone-numbers/${numberId}/inbound`)).json().link.route).toEqual({ id: routeId, name: 'Main line', account_id: ACCOUNT });
      const state = (await get(`/telephony-credentials/${rig.credentialId}/inbound`)).json();
      expect(state.inbound.linked_numbers).toBe(1);
      expect(state.numbers).toEqual([expect.objectContaining({ phone_number: CALLER_ID, assigned: true, link: expect.objectContaining({ linked: true }) })]);

      const off = await unlink();
      expect(off.statusCode).toBe(200);
      expect(off.json().link).toMatchObject({ linked: false, route: null });
      expect(rig.carrier.numberApp(PLIVO_NUMBER)).toBe(THEIR_APP);
      expect(await numberRow()).toMatchObject({ inbound_linked_at: null, inbound_previous_app_id: null });
      expect(await liveRoute()).toBeNull();
      expect((await auditRows('phone_number.inbound_unlinked'))[0]!.details).toMatchObject({
        cause: 'unlinked', carrier: 'restored', previous_app_id: THEIR_APP, detached_route_id: routeId,
      });
      expect((await unlink()).json().error).toBe('phone_number_not_linked');
    });

    it('Link that Plivo refuses links nothing; Unlink that Plivo cannot answer unlinks nothing', async () => {
      await enable();
      rig.carrier.injectFault('update_number', { kind: 'status', status: 503 });
      expect((await link()).statusCode).toBe(502);
      expect((await numberRow()).inbound_linked_at).toBeNull();
      expect(rig.carrier.numberApp(PLIVO_NUMBER)).toBe(THEIR_APP);

      expect((await link()).statusCode).toBe(200);
      rig.carrier.injectFault('update_number', { kind: 'reset' });
      expect((await unlink()).statusCode).toBe(502);
      expect((await numberRow()).inbound_linked_at).not.toBeNull();
      expect(rig.carrier.numberApp(PLIVO_NUMBER)).toBe(ourApp()!.app_id);
    });

    it('a number Plivo no longer has is refused (carrier_number_missing), nothing linked', async () => {
      await enable();
      rig.carrier.numbers = rig.carrier.numbers.filter((n) => n.number !== PLIVO_NUMBER);
      const res = await link();
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('carrier_number_missing');
      expect((await numberRow()).inbound_linked_at).toBeNull();
    });

    it('a number not assigned to the credential`s tenant cannot be linked', async () => {
      await enable();
      await getTestPool().query('DELETE FROM tenant_phone_assignments WHERE phone_number_id = $1', [numberId]);
      const res = await link();
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'phone_number_not_linkable' });
      expect((await get(`/phone-numbers/${numberId}/inbound`)).json().link_blocker).toBe('not_assigned');
    });
  });

  describe('the §8.2 cascade', () => {
    beforeEach(async () => {
      await enable();
      expect((await link()).statusCode).toBe(200);
    });

    it('unassigning the number from the tenant unlinks it, restores its app at Plivo and detaches its route', async () => {
      const routeId = await routeWithNumber();
      const res = await rig.app.inject({ method: 'DELETE', url: `/super-admin/phone-numbers/${numberId}/assign/${TENANT}`, headers: auth });
      expect(res.statusCode).toBe(200);
      expect((await numberRow()).inbound_linked_at).toBeNull();
      expect(rig.carrier.numberApp(PLIVO_NUMBER)).toBe(THEIR_APP);
      expect(await liveRoute()).toBeNull();
      const { rows } = await getTestPool().query('SELECT detached_reason FROM agency_inbound_route_numbers WHERE route_id = $1', [routeId]);
      expect(rows).toEqual([{ detached_reason: 'number_unlinked' }]);
      expect((await auditRows('phone_number.inbound_unlinked'))[0]!.details).toMatchObject({ cause: 'unassigned', carrier: 'restored', detached_route_id: routeId });
    });

    it('a sync that retires the number unlinks it without asking Plivo about a number it no longer has', async () => {
      rig.carrier.numbers = rig.carrier.numbers.filter((n) => n.number !== PLIVO_NUMBER);
      const updates = rig.carrier.requestsTo('update_number').length;
      const res = await post(`/telephony-credentials/${rig.credentialId}/sync-numbers`);
      expect(res.statusCode).toBe(200);
      expect(res.json().sync.retired).toEqual([CALLER_ID]);
      expect(await numberRow()).toMatchObject({ status: 'retired', inbound_linked_at: null });
      expect(rig.carrier.requestsTo('update_number')).toHaveLength(updates);
      expect((await auditRows('phone_number.inbound_unlinked'))[0]!.details).toMatchObject({ cause: 'retired_by_sync', carrier: 'skipped_not_active' });
      // Inbound itself stays enabled, with no number linked: it can now be disabled.
      expect((await post(`/telephony-credentials/${rig.credentialId}/inbound/disable`)).statusCode).toBe(200);
    });

    it('a sync that keeps the number leaves its link alone', async () => {
      const res = await post(`/telephony-credentials/${rig.credentialId}/sync-numbers`);
      expect(res.statusCode).toBe(200);
      expect((await numberRow()).inbound_linked_at).not.toBeNull();
      expect(await auditRows('phone_number.inbound_unlinked')).toEqual([]);
    });

    it('retiring the number by hand unlinks it', async () => {
      await getTestPool().query('DELETE FROM tenant_phone_assignments WHERE phone_number_id = $1', [numberId]);
      // (Retire needs no assignment; removing it above went around the route, so its cascade did not run.)
      expect((await numberRow()).inbound_linked_at).not.toBeNull();
      const res = await rig.app.inject({ method: 'DELETE', url: `/super-admin/phone-numbers/${numberId}`, headers: auth });
      expect(res.statusCode).toBe(200);
      expect((await numberRow()).inbound_linked_at).toBeNull();
      expect((await auditRows('phone_number.inbound_unlinked'))[0]!.details).toMatchObject({ cause: 'retired', carrier: 'skipped_not_active' });
    });

    it('disabling the credential keeps the link, the route and the number on our Application; enabling it again answers as before', async () => {
      const routeId = await routeWithNumber();
      const linkedAt = (await numberRow()).inbound_linked_at;
      const updates = rig.carrier.requestsTo('update_number').length;
      const res = await post(`/telephony-credentials/${rig.credentialId}/disable`);
      expect(res.statusCode).toBe(200);
      expect(res.json().credential.status).toBe('disabled');
      expect(await numberRow()).toMatchObject({ inbound_linked_at: linkedAt, inbound_previous_app_id: THEIR_APP });
      expect(await liveRoute()).toBe(routeId);
      expect(rig.carrier.numberApp(PLIVO_NUMBER)).toBe(ourApp()!.app_id);
      expect(rig.carrier.requestsTo('update_number')).toHaveLength(updates); // nothing asked of the carrier
      expect(await auditRows('phone_number.inbound_unlinked')).toEqual([]);
      // While disabled the numbers stay listed as linked (its calls hear the closed message, §10).
      const state = await get(`/telephony-credentials/${rig.credentialId}/inbound`);
      expect(state.json().inbound.linked_numbers).toBe(1);
      expect(state.json().numbers[0].link).toMatchObject({ linked: true, route: { id: routeId } });

      const on = await post(`/telephony-credentials/${rig.credentialId}/enable`);
      expect(on.statusCode).toBe(200);
      expect(on.json().credential.status).toBe('active');
      expect(await numberRow()).toMatchObject({ inbound_linked_at: linkedAt, inbound_previous_app_id: THEIR_APP });
      expect(await liveRoute()).toBe(routeId);
      expect(rig.carrier.numberApp(PLIVO_NUMBER)).toBe(ourApp()!.app_id);
    });

    it('the cascade clears our side even when Plivo cannot restore the number, and audits the app to put back by hand', async () => {
      rig.carrier.injectFault('update_number', { kind: 'status', status: 503 });
      const res = await rig.app.inject({ method: 'DELETE', url: `/super-admin/phone-numbers/${numberId}/assign/${TENANT}`, headers: auth });
      expect(res.statusCode).toBe(200);
      expect((await numberRow()).inbound_linked_at).toBeNull();
      expect(rig.carrier.numberApp(PLIVO_NUMBER)).toBe(ourApp()!.app_id);
      expect((await auditRows('phone_number.inbound_unlinked'))[0]!.details).toMatchObject({ cause: 'unassigned', carrier: 'failed', previous_app_id: THEIR_APP });
    });

    it('the number`s Inbound panel counts its Missed calls that reached no account, and the credential says whether agents can be connected', async () => {
      const at = new Date('2026-11-08T10:00:00Z');
      for (const [i, from] of [['1', '+447700900001'], ['2', null]] as const) {
        await getTestPool().query(
          `INSERT INTO agency_inbound_calls
             (tenant_id, account_id, phone_number_id, telephony_credential_id, provider_call_id, to_e164, from_e164, state, outcome,
              arrived_at, answered_at, ended_at, settled_at, follow_up_status, follow_up_reason)
           VALUES ($1, NULL, $2, $3, $4, $5, $6, 'ended', 'closed', $7, $7, $7, $7, 'open', 'closed')`,
          [TENANT, numberId, rig.credentialId, `CA-unrouted-${i}`, CALLER_ID, from, new Date(at.getTime() + Number(i) * 60_000)]);
      }
      const res = await get(`/phone-numbers/${numberId}/inbound`);
      expect(res.statusCode).toBe(200);
      expect(res.json().unrouted_missed).toEqual({ open: 2, latest_at: '2026-11-08T10:02:00.000Z', latest_from: null });
      expect((await get(`/telephony-credentials/${rig.credentialId}/inbound`)).json().connects_agents).toBe(true);
      await getTestPool().query(`DELETE FROM agency_inbound_calls WHERE provider_call_id LIKE 'CA-unrouted-%'`);
    });
  });
});
