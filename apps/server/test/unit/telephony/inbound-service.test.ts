// `TelephonyInboundService` against fakes (the repositories, the carrier, the transaction): the
// rules the integration suite (`test/integration/telephony/plivo-inbound-admin.test.ts`) does not
// reach through the mock carrier — the external fallback URL and its GET method, the health
// check's "stored URLs current", a link to a number already on the Application, which numbers
// the §8.2 cascade releases for each cause, and that the cascade never throws.
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import type { PhoneNumberInboundLinkRecord } from '@magick-agency/db/models/phone-number.model';
import type { TelephonyCredentialInboundRecord } from '@magick-agency/db/models/telephony-credential.model';
import {
  TelephonyInboundService,
  inboundApplicationName,
  inboundLinkBlocker,
  type InboundCarrierApi,
} from '../../../src/telephony/credentials/inbound-service.js';
import { hashInboundToken } from '../../../src/telephony/plivo/inbound-token.js';
import { splitInboundToken } from '../../../src/telephony/plivo/inbound-urls.js';
import { PlivoApiError } from '../../../src/telephony/plivo/plivo-inbound.wire.js';

const CRED = '0f9c2a4e-6b1d-4c3e-9a8f-1b2c3d4e5f60';
const TENANT = '11111111-1111-4111-8111-111111111111';
const BASE = 'https://agency.example.com/api/v1/webhooks/plivo';
const EXTERNAL = 'https://static.example.net/plivo/inbound-fallback.xml';
const ACTOR = { adminId: 'admin-1', adminEmail: 'admin@example.com' };

function inboundRecord(over: Partial<TelephonyCredentialInboundRecord> = {}): TelephonyCredentialInboundRecord {
  return {
    credential_id: CRED, tenant_id: TENANT, provider: 'plivo', status: 'active', app_id: null,
    answer_url: null, hangup_url: null, fallback_answer_url: null, enabled_at: null,
    previous_token_expires_at: null, linked_numbers: 0, ...over,
  };
}

function numberRecord(over: Partial<PhoneNumberInboundLinkRecord> = {}): PhoneNumberInboundLinkRecord {
  return {
    phone_number_id: 'pn-1', phone_number: '+14155550101', status: 'active', telephony_credential_id: CRED,
    inbound_linked_at: null, inbound_previous_app_id: null, credential_label: 'Main', credential_status: 'active',
    credential_tenant_id: TENANT, credential_app_id: 'app-1', assigned: true, route_id: null, route_name: null,
    route_account_id: null, ...over,
  };
}

let settings: { webhookBaseUrl: string; inboundFallbackAnswerUrl: string };
let stored: TelephonyCredentialInboundRecord;
let numbers: PhoneNumberInboundLinkRecord[];
let tokens: Set<string>;
let carrier: { [K in keyof InboundCarrierApi]: ReturnType<typeof vi.fn> };
let audit: ReturnType<typeof vi.fn<(entry: { action: string; resource_id?: string; details?: Record<string, unknown> }) => void>>;
let svc: TelephonyInboundService;

beforeEach(() => {
  settings = { webhookBaseUrl: BASE, inboundFallbackAnswerUrl: '' };
  stored = inboundRecord();
  numbers = [];
  tokens = new Set();
  audit = vi.fn();
  carrier = {
    createInboundApplication: vi.fn().mockResolvedValue('app-1'),
    getInboundApplication: vi.fn(),
    updateInboundApplication: vi.fn().mockResolvedValue('updated'),
    deleteInboundApplication: vi.fn().mockResolvedValue('deleted'),
    findInboundApplications: vi.fn().mockResolvedValue([]),
    getNumberApp: vi.fn().mockResolvedValue({ appId: null }),
    setNumberApp: vi.fn().mockResolvedValue('updated'),
  };
  svc = new TelephonyInboundService({
    credentials: { resolve: vi.fn().mockResolvedValue({ id: CRED }) } as never,
    repo: {
      findById: vi.fn(),
      findInbound: vi.fn(async () => stored),
      lockInbound: vi.fn(async () => stored),
      enableInbound: vi.fn(async (_id, input: { appId: string; answerUrl: string; hangupUrl: string; fallbackAnswerUrl: string; tokenHash: string }) => {
        tokens.add(input.tokenHash);
        stored = inboundRecord({ app_id: input.appId, answer_url: input.answerUrl, hangup_url: input.hangupUrl, fallback_answer_url: input.fallbackAnswerUrl, enabled_at: new Date() });
        return stored;
      }),
      repointInbound: vi.fn(),
      disableInbound: vi.fn(),
      inboundTokenMatches: vi.fn(async (_id: string, hash: string) => tokens.has(hash)),
    } as never,
    numbers: {
      findInboundLink: vi.fn(async (id: string) => numbers.find((n) => n.phone_number_id === id) ?? null),
      listInboundForCredential: vi.fn(async () => numbers),
      linkInbound: vi.fn(async (input: { phoneNumberId: string; previousAppId: string | null }) => {
        const n = numbers.find((x) => x.phone_number_id === input.phoneNumberId)!;
        n.inbound_linked_at = new Date();
        n.inbound_previous_app_id = input.previousAppId;
        return { id: n.phone_number_id };
      }),
      clearInboundLink: vi.fn(async (id: string) => {
        const n = numbers.find((x) => x.phone_number_id === id);
        if (!n?.inbound_linked_at) return null;
        const was = { phone_number_id: id, phone_number: n.phone_number, status: n.status, telephony_credential_id: CRED, inbound_linked_at: n.inbound_linked_at, inbound_previous_app_id: n.inbound_previous_app_id };
        n.inbound_linked_at = null;
        n.inbound_previous_app_id = null;
        return was;
      }),
    } as never,
    routes: { detachNumberEverywhere: vi.fn().mockResolvedValue(null) } as never,
    calls: { anyLiveArrivedBefore: vi.fn().mockResolvedValue(false) },
    carrierFor: () => carrier as unknown as InboundCarrierApi,
    settings: () => settings,
    audit,
    pool: { connect: async () => ({ query: async () => ({ rows: [] }), release: () => undefined }) } as never,
  });
});

describe('TelephonyInboundService', () => {
  it('names the Application after the credential (how an orphan is found again)', () => {
    expect(inboundApplicationName(CRED)).toBe(`inbound-${CRED}`);
  });

  it('gives an operator-hosted fallback answer URL, fetched with GET, when one is configured; our own route, POSTed, otherwise', async () => {
    settings.inboundFallbackAnswerUrl = EXTERNAL;
    expect((await svc.enable(CRED, ACTOR)).ok).toBe(true);
    const urls = carrier.createInboundApplication.mock.calls[0]![1];
    expect(urls).toEqual({
      answerUrl: `${BASE}/inbound-answer/${CRED}`, hangupUrl: `${BASE}/inbound-status/${CRED}`,
      fallbackAnswerUrl: EXTERNAL, fallbackMethod: 'GET',
    });
    expect(stored.fallback_answer_url).toBe(EXTERNAL);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'telephony_credential.inbound_enabled', details: expect.objectContaining({ fallback: 'external' }) }));
  });

  it('health compares address, method and token; the fallback`s method follows whose it is; "stored URLs current" follows env', async () => {
    settings.inboundFallbackAnswerUrl = EXTERNAL;
    await svc.enable(CRED, ACTOR);
    const [, urls, token] = carrier.createInboundApplication.mock.calls[0]!;
    const live = {
      appId: 'app-1', appName: inboundApplicationName(CRED),
      answerUrl: `${urls.answerUrl}?token=${token}`, answerMethod: 'POST',
      hangupUrl: `${urls.hangupUrl}?token=${token}`, hangupMethod: 'POST',
      fallbackAnswerUrl: EXTERNAL, fallbackMethod: 'GET',
    };
    carrier.getInboundApplication.mockResolvedValue(live);
    const check = async () => { const r = await svc.health(CRED); if (!r.ok) throw new Error(r.code); return r.value.health; };
    expect(await check()).toMatchObject({ health: 'ok', mismatched: [], stored_urls_current: true });

    carrier.getInboundApplication.mockResolvedValue({ ...live, hangupMethod: 'GET', fallbackMethod: 'POST' });
    expect(await check()).toMatchObject({ health: 'url_mismatch', mismatched: ['hangup_url', 'fallback_answer_url'] });
    carrier.getInboundApplication.mockResolvedValue({ ...live, answerUrl: urls.answerUrl });
    expect((await check()).mismatched).toEqual(['answer_url']); // no token at all

    // The deployment moved: the Application still matches what is stored, but a Re-point is due.
    carrier.getInboundApplication.mockResolvedValue(live);
    settings.webhookBaseUrl = 'https://new-host.example.com/api/v1/webhooks/plivo';
    expect(await check()).toMatchObject({ health: 'ok', stored_urls_current: false });
    settings.webhookBaseUrl = '';
    expect((await check()).stored_urls_current).toBe(false);
  });

  it('health: a carrier that refuses the credential is a refusal (rotate it), not "unreachable"', async () => {
    stored = inboundRecord({ app_id: 'app-1', answer_url: 'a', hangup_url: 'h', fallback_answer_url: 'f', enabled_at: new Date() });
    carrier.getInboundApplication.mockRejectedValue(new PlivoApiError('auth_rejected', 'op', 401, 'no'));
    expect(await svc.health(CRED)).toMatchObject({ ok: false, code: 'carrier_rejected' });
    carrier.getInboundApplication.mockRejectedValue(new PlivoApiError('unreachable', 'op', null, 'down'));
    expect(await svc.health(CRED)).toMatchObject({ ok: true, value: { health: { health: 'unreachable' } } });
  });

  it('a number already on the Application is linked with no previous app (it cannot be known)', async () => {
    numbers = [numberRecord()];
    carrier.getNumberApp.mockResolvedValue({ appId: 'app-1' });
    expect((await svc.link('pn-1', ACTOR)).ok).toBe(true);
    expect(numbers[0]!.inbound_previous_app_id).toBeNull();
  });

  it.each([
    [{ telephony_credential_id: null }, 'not_synced'],
    [{ status: 'retired' as const }, 'not_active'],
    [{ assigned: false }, 'not_assigned'],
    [{ credential_status: 'disabled' }, 'credential_not_active'],
    [{ credential_app_id: null }, 'inbound_not_enabled'],
    [{}, null],
  ])('a number %o is %s for a link', (over, blocker) => {
    expect(inboundLinkBlocker(numberRecord(over))).toBe(blocker);
  });

  it('the cascade for one number releases it only when it is linked and may no longer be (not active, or not assigned)', async () => {
    numbers = [
      numberRecord({ phone_number_id: 'kept', inbound_linked_at: new Date() }),
      numberRecord({ phone_number_id: 'unassigned', inbound_linked_at: new Date(), assigned: false, inbound_previous_app_id: 'theirs' }),
      numberRecord({ phone_number_id: 'retired', inbound_linked_at: new Date(), status: 'retired' }),
      numberRecord({ phone_number_id: 'never-linked', assigned: false }),
      // A credential the carrier refused keeps its links (§10): only its disable releases them.
      numberRecord({ phone_number_id: 'invalid-credential', inbound_linked_at: new Date(), credential_status: 'invalid' }),
    ];
    expect(await svc.reconcileNumber('kept', 'unassigned', ACTOR)).toBe(false);
    expect(await svc.reconcileNumber('never-linked', 'unassigned', ACTOR)).toBe(false);
    expect(await svc.reconcileNumber('invalid-credential', 'retired', ACTOR)).toBe(false);
    expect(await svc.reconcileNumber('unassigned', 'unassigned', ACTOR)).toBe(true);
    expect(carrier.setNumberApp).toHaveBeenCalledWith('+14155550101', 'theirs');
    carrier.setNumberApp.mockClear();
    expect(await svc.reconcileNumber('retired', 'retired', ACTOR)).toBe(true);
    expect(carrier.setNumberApp).not.toHaveBeenCalled(); // not the account's any more
    expect(audit.mock.calls.map(([e]) => [e.resource_id, e.details!.cause, e.details!.carrier])).toEqual([
      ['unassigned', 'unassigned', 'restored'], ['retired', 'retired', 'skipped_not_active'],
    ]);
  });

  it('the cascade for a credential: after a sync, the retired (as retired_by_sync) and the unassigned (as unassigned); on disable, every link', async () => {
    const fresh = () => [
      numberRecord({ phone_number_id: 'kept', inbound_linked_at: new Date() }),
      numberRecord({ phone_number_id: 'gone', inbound_linked_at: new Date(), status: 'retired' }),
      numberRecord({ phone_number_id: 'unassigned', inbound_linked_at: new Date(), assigned: false }),
    ];
    numbers = fresh();
    expect(await svc.reconcileCredential(CRED, 'retired_by_sync', ACTOR)).toBe(2);
    expect(audit.mock.calls.map(([e]) => [e.resource_id, e.details!.cause])).toEqual([['gone', 'retired_by_sync'], ['unassigned', 'unassigned']]);
    audit.mockClear();
    numbers = fresh();
    expect(await svc.reconcileCredential(CRED, 'credential_disabled', ACTOR)).toBe(3);
    expect(audit.mock.calls.map(([e]) => e.details!.cause)).toEqual(['credential_disabled', 'credential_disabled', 'credential_disabled']);
  });

  it('the cascade never throws: a failing read or write is logged and counted as not released', async () => {
    numbers = [numberRecord({ inbound_linked_at: new Date(), assigned: false })];
    const failing = new TelephonyInboundService({
      ...(svc as unknown as { deps: ConstructorParameters<typeof TelephonyInboundService>[0] }).deps,
      numbers: { findInboundLink: vi.fn().mockRejectedValue(new Error('db down')), listInboundForCredential: vi.fn().mockRejectedValue(new Error('db down')) } as never,
    });
    await expect(failing.reconcileNumber('pn-1', 'unassigned', ACTOR)).resolves.toBe(false);
    await expect(failing.reconcileCredential(CRED, 'credential_disabled', ACTOR)).resolves.toBe(0);
  });

  it('the token given to the carrier is the one whose hash is stored, and never audited', async () => {
    await svc.enable(CRED, ACTOR);
    const token = carrier.createInboundApplication.mock.calls[0]![2] as string;
    expect(tokens.has(hashInboundToken(token))).toBe(true);
    expect(JSON.stringify(audit.mock.calls)).not.toContain(token);
    expect(splitInboundToken(`${BASE}/inbound-answer/${CRED}?token=${token}`)).toEqual({ stored: `${BASE}/inbound-answer/${CRED}`, token });
  });
});
