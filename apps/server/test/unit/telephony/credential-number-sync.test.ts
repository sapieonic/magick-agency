// The carrier number sync (decisions B18–B22): the Plivo spec's `listNumbers` (fixed host,
// Basic auth, no redirects, a timeout, pages built from the offset and bounded, non-voice
// and malformed numbers skipped, E.164 normalisation) and the service's `syncNumbers`
// (only an active credential, nothing written on any carrier refusal or an incomplete
// list, the repository's verdict mapped). The inventory write is pinned against real
// Postgres in packages/db (`phone-number-sync.repository.test.ts`).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import type {
  CreateTelephonyCredentialInput,
  TelephonyCredentialRecord,
  TelephonyCredentialSecretRecord,
} from '@magick-agency/db/models/telephony-credential.model';
import type { NumberSyncResult } from '@magick-agency/db/models/phone-number.model';
import { CredentialSealer, EnvKeyringWrapper } from '../../../src/telephony/credentials/credential-sealer.js';
import { TelephonyCredentialService, type CredentialRepo } from '../../../src/telephony/credentials/credential-service.js';
import {
  findCredentialSpec, plivoNumberIsOnAccount, plivoNumberToE164, PLIVO_API_BASE, PLIVO_NUMBERS_MAX_PAGES, PLIVO_NUMBERS_PAGE_SIZE,
  type FetchLike,
} from '../../../src/telephony/credentials/credential-specs.js';

const AUTH_ID = 'MAABCDEFGHIJKLMNOPQR';
const TOKEN = 'canaryTokenValue0123456789';
const TENANT = '11111111-1111-4111-8111-111111111111';
const ADMIN = '99999999-9999-4999-8999-999999999999';
const BASE = `${PLIVO_API_BASE}/v1/Account/${AUTH_ID}/Number/`;

const spec = findCredentialSpec('plivo')!;
const pub = { auth_id: AUTH_ID };
const sec = { auth_token: TOKEN };

type Obj = Record<string, unknown>;
const num = (n: string, o: Obj = {}): Obj => ({ number: n, voice_enabled: true, alias: null, ...o });
const page = (objects: Obj[], next: string | null = null) => ({ meta: { limit: 20, offset: 0, next, total_count: 0 }, objects });

/** A carrier that answers each GET with the next scripted page (or status/throw). */
function carrier(pages: Array<unknown | { status: number } | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = pages[Math.min(calls.length - 1, pages.length - 1)];
    if (next instanceof Error) throw next;
    if (next && typeof next === 'object' && 'status' in next && !('objects' in next)) return { status: (next as { status: number }).status };
    return { status: 200, json: async () => next };
  };
  return { calls, fetchImpl };
}

const full = (start: number) => Array.from({ length: PLIVO_NUMBERS_PAGE_SIZE }, (_, i) => num(String(14155550000 + start + i)));

describe('plivoNumberToE164', () => {
  it.each([
    ['18135401302', '+18135401302'], ['+918000000001', '+918000000001'], [' 14155550100 ', '+14155550100'],
    ['0123456789', null], ['abc', null], ['', null], ['1234567890123456', null], [12345, null],
  ])('%s → %s', (raw, want) => {
    expect(plivoNumberToE164(raw)).toBe(want);
  });
});

describe('the Plivo spec\'s listNumbers', () => {
  it('reads the account\'s numbers from the fixed host with Basic auth, no redirects and a timeout', async () => {
    const c = carrier([page([num('14155550100', { alias: '  Sales line ' }), num('+14155550101')])]);
    const out = await spec.listNumbers!(pub, sec, c.fetchImpl);
    expect(out).toEqual({
      result: 'ok', listed: 2, skipped: [],
      numbers: [{ phone_number: '+14155550100', label: 'Sales line' }, { phone_number: '+14155550101', label: null }],
    });
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]!.url).toBe(`${BASE}?limit=20&offset=0`);
    const init = c.calls[0]!.init;
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Basic ${Buffer.from(`${AUTH_ID}:${TOKEN}`).toString('base64')}`);
  });

  it('skips a number that cannot carry voice, and one that is not a phone number, and says why', async () => {
    const c = carrier([page([
      num('14155550100'), num('14155550101', { voice_enabled: false }), num('14155550102', { voice_enabled: undefined }),
      num('0800'), num('x'.repeat(40)), null as unknown as Obj,
    ])]);
    const out = await spec.listNumbers!(pub, sec, c.fetchImpl);
    expect(out).toEqual({
      result: 'ok', listed: 6, numbers: [{ phone_number: '+14155550100', label: null }],
      skipped: [
        { number: '14155550101', reason: 'not_voice' }, { number: '14155550102', reason: 'not_voice' },
        { number: '0800', reason: 'invalid_number' }, { number: 'x'.repeat(32), reason: 'invalid_number' },
        { number: '', reason: 'not_voice' },
      ],
    });
  });

  it('a main account`s list: a number transferred to a subaccount is that account`s, skipped `other_account`; its own are kept', async () => {
    const SUB = 'SAABCDEFGHIJKLMNOPQR';
    const c = carrier([page([
      num('14155550100', { sub_account: null }),
      num('14155550101', { sub_account: SUB }),
      num('14155550102', { sub_account: `/v1/Account/${AUTH_ID}/Subaccount/${SUB}/` }),
      num('14155550103'),
      // Not voice AND another account's: reported as another account's, not as ours to fix.
      num('14155550104', { sub_account: SUB, voice_enabled: false }),
      num('14155550105', { sub_account: { auth_id: SUB } }),
    ])]);
    const out = await spec.listNumbers!(pub, sec, c.fetchImpl);
    expect(out).toEqual({
      result: 'ok', listed: 6,
      numbers: [{ phone_number: '+14155550100', label: null }, { phone_number: '+14155550103', label: null }],
      skipped: [
        { number: '14155550101', reason: 'other_account' }, { number: '14155550102', reason: 'other_account' },
        { number: '14155550104', reason: 'other_account' }, { number: '14155550105', reason: 'other_account' },
      ],
    });
  });

  it('a subaccount`s own credential keeps the numbers listed as its own', async () => {
    const SUB = 'SAABCDEFGHIJKLMNOPQR';
    const c = carrier([page([
      num('14155550101', { sub_account: SUB }),
      num('14155550102', { sub_account: `/v1/Account/MAZZZZZZZZZZZZZZZZZZ/Subaccount/${SUB}/` }),
      num('14155550103', { sub_account: 'SAOTHEROTHEROTHER000' }),
    ])]);
    const out = await spec.listNumbers!({ auth_id: SUB }, sec, c.fetchImpl);
    expect(out).toEqual({
      result: 'ok', listed: 3,
      numbers: [{ phone_number: '+14155550101', label: null }, { phone_number: '+14155550102', label: null }],
      skipped: [{ number: '14155550103', reason: 'other_account' }],
    });
  });

  it.each([
    [null, true], [undefined, true], ['', true], ['MAABCDEFGHIJKLMNOPQR', true], ['SAOTHER', false],
    ['/v1/Account/MAX/Subaccount/MAABCDEFGHIJKLMNOPQR/', true], ['/v1/Account/MAABCDEFGHIJKLMNOPQR/Subaccount/SAX/', false],
    [42, false], [{}, false],
  ])('plivoNumberIsOnAccount(%j) for the account itself → %s', (sub, want) => {
    expect(plivoNumberIsOnAccount(sub, AUTH_ID)).toBe(want);
  });

  it('pages by offset until a short page, and builds each URL itself (meta.next is never followed)', async () => {
    const c = carrier([
      page(full(0), 'https://evil.example/steal'), page(full(20), '/v1/Account/OTHER/Number/?offset=999'), page([num('14155559999')]),
    ]);
    const out = await spec.listNumbers!(pub, sec, c.fetchImpl);
    expect(out).toMatchObject({ result: 'ok', listed: 41 });
    expect(c.calls.map((x) => x.url)).toEqual([
      `${BASE}?limit=20&offset=0`, `${BASE}?limit=20&offset=20`, `${BASE}?limit=20&offset=40`,
    ]);
  });

  it('stops on a full page whose meta.next is null', async () => {
    const c = carrier([page(full(0), null)]);
    expect(await spec.listNumbers!(pub, sec, c.fetchImpl)).toMatchObject({ result: 'ok', listed: 20 });
    expect(c.calls).toHaveLength(1);
  });

  it(`reads at most ${PLIVO_NUMBERS_MAX_PAGES} pages, then refuses the incomplete list rather than returning it`, async () => {
    const c = carrier([page(full(0), '/next')]); // every page full, always another
    const out = await spec.listNumbers!(pub, sec, c.fetchImpl);
    expect(out.result).toBe('too_many');
    expect(c.calls).toHaveLength(PLIVO_NUMBERS_MAX_PAGES);
    expect(c.calls.at(-1)!.url).toBe(`${BASE}?limit=20&offset=${(PLIVO_NUMBERS_MAX_PAGES - 1) * PLIVO_NUMBERS_PAGE_SIZE}`);
  });

  it.each([
    [{ status: 401 }, 'rejected'], [{ status: 403 }, 'rejected'], [{ status: 500 }, 'unreachable'], [{ status: 404 }, 'unreachable'],
    [Object.assign(new Error('t'), { name: 'TimeoutError' }), 'unreachable'], [new TypeError('fetch failed'), 'unreachable'],
    [{ objects: 'nope' }, 'unreachable'], [null, 'unreachable'],
  ])('a carrier answer of %o is %s, and never echoes the token', async (answer, result) => {
    const c = carrier([answer]);
    const out = await spec.listNumbers!(pub, sec, c.fetchImpl);
    expect(out.result).toBe(result);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it('a failure on a later page discards the pages already read', async () => {
    const c = carrier([page(full(0), '/next'), { status: 503 }]);
    expect(await spec.listNumbers!(pub, sec, c.fetchImpl)).toEqual({ result: 'unreachable', reason: 'Plivo answered HTTP 503' });
  });

  it('an unreadable body (a JSON parse error) is unreachable', async () => {
    const fetchImpl: FetchLike = async () => ({ status: 200, json: async () => { throw new SyntaxError('bad json'); } });
    expect(await spec.listNumbers!(pub, sec, fetchImpl)).toEqual({ result: 'unreachable', reason: 'Plivo sent an unreadable number list' });
  });
});

// ── TelephonyCredentialService.syncNumbers ──────────────────────────────────

const keyring = `v1:${crypto.randomBytes(32).toString('base64')}`;
let rows: Map<string, TelephonyCredentialRecord>;
let secrets: TelephonyCredentialSecretRecord[];
let fetchPages: ReturnType<typeof carrier>;
let syncForCredential: ReturnType<typeof vi.fn>;
let findCampaignsHoldingInactiveNumbers: ReturnType<typeof vi.fn>;
let svc: TelephonyCredentialService;

/** Just enough of the repository for create and resolve. */
function repo(): CredentialRepo {
  return {
    async create(i: CreateTelephonyCredentialInput) {
      const now = new Date();
      const row: TelephonyCredentialRecord = {
        id: i.id, tenant_id: i.tenant_id, provider: i.provider, label: i.label, status: 'active', account_ref: i.account_ref,
        public_config: i.public_config, secret_version: 1, secret_hint: i.sealed.secret_hint, verified_at: i.verified_at,
        last_error: null, created_by: i.created_by, updated_by: i.created_by, created_at: now, updated_at: now,
        revoked_at: null, shredded_at: null,
      };
      rows.set(i.id, row);
      secrets.push({
        credential_id: i.id, secret_version: 1, secret_ciphertext: i.sealed.secret_ciphertext, wrapped_dek: i.sealed.wrapped_dek,
        kek_id: i.sealed.kek_id, created_at: now, retired_at: null,
      });
      return { ...row };
    },
    async findById(id: string) { const r = rows.get(id); return r ? { ...r } : null; },
    async findOpenableSecrets(id: string) { return secrets.filter((s) => s.credential_id === id); },
  } as unknown as CredentialRepo;
}

function service(sealer: CredentialSealer | null = new CredentialSealer(new EnvKeyringWrapper(keyring, 'v1'))) {
  return new TelephonyCredentialService({
    repo: repo(), sealer, tenants: { findById: async (id) => (id === TENANT ? { id } : null) },
    // create's check is the first call; every later one is the number list.
    fetchImpl: async (url, init) => (url.endsWith('/Number/') || url.includes('/Number/?') ? fetchPages.fetchImpl(url, init) : { status: 200 }),
    numbers: { syncForCredential: syncForCredential as never, findCampaignsHoldingInactiveNumbers: findCampaignsHoldingInactiveNumbers as never },
  });
}

async function credential(): Promise<string> {
  const r = await svc.create({ tenantId: TENANT, provider: 'plivo', label: 'Main', fields: { auth_id: AUTH_ID, auth_token: TOKEN }, adminId: ADMIN });
  if (!r.ok) throw new Error(r.code);
  return r.value.id;
}

const WRITTEN: NumberSyncResult = {
  added: ['+14155550100'], reactivated: [], unchanged: [], retired: ['+14155550199'],
  conflicts: [{ phone_number: '+14155550101', reason: 'registered_elsewhere' }], active: 1,
};

beforeEach(() => {
  rows = new Map();
  secrets = [];
  fetchPages = carrier([page([num('14155550100'), num('14155550101'), num('14155550102', { voice_enabled: false })])]);
  syncForCredential = vi.fn().mockResolvedValue(WRITTEN);
  findCampaignsHoldingInactiveNumbers = vi.fn().mockResolvedValue([]);
  svc = service();
});

describe('TelephonyCredentialService.syncNumbers', () => {
  it('lists the account with the stored secret and writes the voice numbers, as the admin; answers what changed', async () => {
    const id = await credential();
    const r = await svc.syncNumbers(id, ADMIN);
    expect(syncForCredential).toHaveBeenCalledWith(id, [
      { phone_number: '+14155550100', label: null }, { phone_number: '+14155550101', label: null },
    ], ADMIN);
    expect(r).toEqual({
      ok: true,
      value: {
        credential: expect.objectContaining({ id, status: 'active' }),
        sync: {
          listed: 3, added: ['+14155550100'], reactivated: [], unchanged: [], retired: ['+14155550199'],
          skipped: [{ number: '14155550102', reason: 'not_voice' }],
          conflicts: [{ phone_number: '+14155550101', reason: 'registered_elsewhere' }], active_numbers: 1,
          campaigns_holding_retired: [],
        },
      },
    });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('names the live campaigns still holding the credential\'s retired numbers, read after the write (PL13)', async () => {
    const id = await credential();
    findCampaignsHoldingInactiveNumbers.mockImplementation(async () => {
      // Read after the sync wrote, so a number it just retired is counted.
      expect(syncForCredential).toHaveBeenCalled();
      return [{
        campaign_id: 'c-1', campaign_name: 'Collections', account_id: 'a-1', account_name: 'North',
        status: 'running', caller_ids: ['+14155550199'],
      }];
    });
    const r = await svc.syncNumbers(id, ADMIN);
    expect(findCampaignsHoldingInactiveNumbers).toHaveBeenCalledWith(id);
    expect(r.ok && r.value.sync.campaigns_holding_retired).toEqual([{
      campaign_id: 'c-1', campaign_name: 'Collections', account_id: 'a-1', account_name: 'North',
      status: 'running', retired_caller_ids: ['+14155550199'],
    }]);
  });

  it.each(['disabled', 'invalid', 'revoked'] as const)('a %s credential is refused before the carrier is asked', async (status) => {
    const id = await credential();
    rows.get(id)!.status = status;
    const r = await svc.syncNumbers(id, ADMIN);
    expect(r).toMatchObject({ ok: false, code: 'credential_not_active' });
    expect(fetchPages.calls).toHaveLength(0);
    expect(syncForCredential).not.toHaveBeenCalled();
  });

  it('an unknown credential is not_found', async () => {
    expect(await svc.syncNumbers(crypto.randomUUID(), ADMIN)).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('no keyring on this server: credential_store_unavailable, the carrier is not asked', async () => {
    const id = await credential();
    const r = await service(null).syncNumbers(id, ADMIN);
    expect(r).toMatchObject({ ok: false, code: 'credential_store_unavailable' });
    expect(fetchPages.calls).toHaveLength(0);
  });

  it.each([
    [[{ status: 401 }], 'carrier_rejected'],
    [[{ status: 502 }], 'carrier_unreachable'],
    [[page(full(0), '/next')], 'too_many_numbers'],
  ])('a carrier answer %o is %s and nothing is written', async (pages, code) => {
    const id = await credential();
    fetchPages = carrier(pages);
    expect(await svc.syncNumbers(id, ADMIN)).toMatchObject({ ok: false, code });
    expect(syncForCredential).not.toHaveBeenCalled();
    // A refusal here is not a verdict on the credential: verify owns that.
    expect(rows.get(id)!.status).toBe('active');
  });

  it('a credential that stops being active while the carrier answers: the write refuses (null) and so does the sync', async () => {
    const id = await credential();
    syncForCredential.mockResolvedValue(null);
    expect(await svc.syncNumbers(id, ADMIN)).toMatchObject({ ok: false, code: 'credential_not_active' });
  });
});
