import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VoicelinkAdapter } from '../../../../src/telephony/voicelink/voicelink.adapter.js';
import type { VoicelinkConfig } from '../../../../src/telephony/voicelink/voicelink.types.js';

// ═══════════════════════════════════════════════════════════════════════════
// VoiceLink adapter EDGE-CASES — complements voicelink.adapter.test.ts (owned by
// another engineer, not touched here). Two areas:
//   1. splitDestination degenerate inputs — pins the ACTUAL current behavior of
//      the load-bearing CC split (empty, all-CC, shorter-than-CC, non-default CC).
//   2. getCallStatus CDR path — happy parse, null-on-non-ok, and the
//      401-refresh-retry (real token manager + stubbed global fetch, matching the
//      main adapter test's mocking style). getRecordingUrl is pinned here too,
//      but from the other side: it must make NO request at all (see the adapter's
//      own comment — the id we hold is our own callId, and the recording arrives
//      on the `call.completed` webhook).
// ═══════════════════════════════════════════════════════════════════════════

const VOICELINK_CONFIG: VoicelinkConfig = {
  baseUrl: 'https://app.voicelink.example/api',
  username: 'vl-user',
  password: 'super-secret-password',
  webhookBaseUrl: 'https://host/api/v1/webhooks/voicelink',
  defaultCallerId: '919228130625',
  defaultCountryCode: '91',
};

const LOGIN_OK = {
  ok: true,
  status: 200,
  json: async () => ({ data: { access_token: 'vl-token-abc', token_type: 'Bearer' } }),
  text: async () => JSON.stringify({ data: { access_token: 'vl-token-abc' } }),
};

describe('VoicelinkAdapter — splitDestination edge cases (pins CURRENT behavior)', () => {
  const adapter = new VoicelinkAdapter(VOICELINK_CONFIG);

  it('empty string → default CC with an EMPTY customer_number', () => {
    // digits='' → does not start with '91' → bottom branch → strip leading 0 → ''.
    expect(adapter.splitDestination('')).toEqual({ countryCode: '91', customerNumber: '' });
  });

  it('all-country-code input "91" → NOT peeled (length !== > cc.length), kept as the national number', () => {
    // digits='91' startsWith '91' is true, but `digits.length > cc.length` is
    // 2 > 2 === false, so the peel branch is skipped and the whole thing becomes
    // the customer_number. ⚠️ Arguably wrong (a CC-only input yields a bogus
    // national number '91' rather than an empty one), but this is the ACTUAL
    // current behavior — reported to main as a potential bug, NOT fixed here.
    expect(adapter.splitDestination('91')).toEqual({ countryCode: '91', customerNumber: '91' });
  });

  it('a national number shorter than the CC → default CC prepended, number kept as-is', () => {
    // '7' does not start with '91' → bottom branch, no leading 0 to strip.
    expect(adapter.splitDestination('7')).toEqual({ countryCode: '91', customerNumber: '7' });
    // A 2-digit number that isn't the CC prefix, same path.
    expect(adapter.splitDestination('75')).toEqual({ countryCode: '91', customerNumber: '75' });
  });

  it('a non-default CC number (US +1) with default CC 91 → MISROUTED to 91 + full US number kept', () => {
    // '+14155550100' → digits='14155550100'; does NOT start with '91' → bottom
    // branch keeps the whole thing (INCLUDING the US CC digit '1') as the
    // customer_number and stamps the India default CC '91'. ⚠️ This misroutes a
    // US number: the adapter can't recognize '1' as a CC unless configured.
    // Current behavior per the docstring's "fall back to the default CC with the
    // number as-is". Reported to main; NOT fixed here.
    expect(adapter.splitDestination('+14155550100')).toEqual({
      countryCode: '91',
      customerNumber: '14155550100',
    });
  });

  it('a US number DOES split correctly when the adapter is configured with CC=1', () => {
    // The sane path: configure the default CC to match the number's CC.
    const usAdapter = new VoicelinkAdapter({ ...VOICELINK_CONFIG, defaultCountryCode: '1' });
    expect(usAdapter.splitDestination('+14155550100')).toEqual({
      countryCode: '1',
      customerNumber: '4155550100',
    });
  });
});

describe('VoicelinkAdapter — getCallStatus / getRecordingUrl CDR path', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const cdrUrl = (u: unknown) => String(u).includes('/v1/call-log/details');
  const loginUrl = (u: unknown) => String(u).endsWith('/v1/auth/login');
  const callsTo = (pred: (u: unknown) => boolean) => fetchMock.mock.calls.filter(([u]) => pred(u));

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('happy path', () => {
    beforeEach(() => {
      fetchMock = vi.fn(async (url: string) => {
        if (loginUrl(url)) return LOGIN_OK as unknown as Response;
        if (cdrUrl(url)) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                call_id: 'vl-call-77',
                call_status: 'ANSWERED',
                talk_duration: 21,
                call_duration: 30,
                hangup_reason: 'Normal Clearing',
                recording_url: 'https://voiceflowai.elisiontec.com/rec/abc.mp3',
              },
            }),
          } as unknown as Response;
        }
        throw new Error(`unexpected fetch to ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);
    });

    it('getCallStatus parses status (lowercased), talk_duration, and hangup_reason', async () => {
      const adapter = new VoicelinkAdapter(VOICELINK_CONFIG);
      const status = await adapter.getCallStatus('vl-call-77');
      expect(status).toEqual({ status: 'answered', duration: 21, errorMessage: 'Normal Clearing' });
    });

    it('getCallStatus GETs the CDR with the call_id query param and a Bearer token', async () => {
      const adapter = new VoicelinkAdapter(VOICELINK_CONFIG);
      await adapter.getCallStatus('vl-call-77');
      const [url, init] = callsTo(cdrUrl)[0]! as [string, { headers: Record<string, string> }];
      expect(url).toContain('call_id=vl-call-77');
      expect(init.headers['Authorization']).toBe('Bearer vl-token-abc');
      expect(init.headers['Accept']).toBe('application/json');
    });

    it('getCallStatus falls back to call_duration when talk_duration is not a number', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (loginUrl(url)) return LOGIN_OK as unknown as Response;
        if (cdrUrl(url)) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: { call_status: 'ANSWERED', call_duration: 30 } }),
          } as unknown as Response;
        }
        throw new Error(`unexpected fetch to ${url}`);
      });
      const adapter = new VoicelinkAdapter(VOICELINK_CONFIG);
      const status = await adapter.getCallStatus('vl-call-77');
      expect(status).toEqual({ status: 'answered', duration: 30, errorMessage: undefined });
    });

    it('getRecordingUrl returns null and NEVER touches the CDR, even when the CDR would hit', async () => {
      // The CDR fixture in this describe block DOES carry a recording_url, so a
      // reinstated fetch would make this assertion pass on the value and fail on
      // the fetch count — which is the point. VoiceLink hands us our own callId
      // as the providerCallId, so the lookup can't match in production anyway
      // (~560 404s per ~591 dequeues), and the recording is already persisted
      // from the `call.completed` webhook body. The fetch sat in front of
      // concurrency-slot release in CallManager.handleCallEnd.
      const adapter = new VoicelinkAdapter(VOICELINK_CONFIG);
      expect(await adapter.getRecordingUrl('vl-call-77')).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('non-ok CDR response → null / unknown', () => {
    beforeEach(() => {
      fetchMock = vi.fn(async (url: string) => {
        if (loginUrl(url)) return LOGIN_OK as unknown as Response;
        if (cdrUrl(url)) {
          return { ok: false, status: 404, text: async () => 'not found' } as unknown as Response;
        }
        throw new Error(`unexpected fetch to ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);
    });

    it("getCallStatus returns { status: 'unknown' } when the CDR misses", async () => {
      const adapter = new VoicelinkAdapter(VOICELINK_CONFIG);
      expect(await adapter.getCallStatus('vl-call-77')).toEqual({ status: 'unknown' });
    });

    it('a thrown fetch (network error) is swallowed → getCallStatus unknown', async () => {
      fetchMock.mockImplementation(async (url: string) => {
        if (loginUrl(url)) return LOGIN_OK as unknown as Response;
        if (cdrUrl(url)) throw new Error('ECONNRESET');
        throw new Error(`unexpected fetch to ${url}`);
      });
      const adapter = new VoicelinkAdapter(VOICELINK_CONFIG);
      expect(await adapter.getCallStatus('vl-call-77')).toEqual({ status: 'unknown' });
    });

    it('getRecordingUrl cannot be affected by a carrier outage — it makes no request', async () => {
      fetchMock.mockImplementation(async () => {
        throw new Error('ECONNRESET');
      });
      const adapter = new VoicelinkAdapter(VOICELINK_CONFIG);
      expect(await adapter.getRecordingUrl('vl-call-77')).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('401 → token refresh → retry (exactly once)', () => {
    it('getCallStatus refreshes the token and retries the CDR fetch on a 401', async () => {
      let cdrAttempts = 0;
      fetchMock = vi.fn(async (url: string) => {
        if (loginUrl(url)) return LOGIN_OK as unknown as Response;
        if (cdrUrl(url)) {
          cdrAttempts++;
          if (cdrAttempts === 1) {
            return { ok: false, status: 401, text: async () => 'unauthorized' } as unknown as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: { call_status: 'ANSWERED', talk_duration: 12 } }),
          } as unknown as Response;
        }
        throw new Error(`unexpected fetch to ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const adapter = new VoicelinkAdapter(VOICELINK_CONFIG);
      const status = await adapter.getCallStatus('vl-call-77');

      expect(status).toEqual({ status: 'answered', duration: 12, errorMessage: undefined });
      // CDR attempted twice (401 then retry); login twice (initial + forced refresh).
      expect(callsTo(cdrUrl)).toHaveLength(2);
      expect(callsTo(loginUrl)).toHaveLength(2);
    });

    it('a second consecutive 401 does NOT retry again — the CDR miss resolves to unknown/null', async () => {
      fetchMock = vi.fn(async (url: string) => {
        if (loginUrl(url)) return LOGIN_OK as unknown as Response;
        if (cdrUrl(url)) {
          return { ok: false, status: 401, text: async () => 'still unauthorized' } as unknown as Response;
        }
        throw new Error(`unexpected fetch to ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const adapter = new VoicelinkAdapter(VOICELINK_CONFIG);
      expect(await adapter.getCallStatus('vl-call-77')).toEqual({ status: 'unknown' });
      // Exactly one retry: initial 401 + post-refresh 401, then it gives up (null CDR).
      expect(callsTo(cdrUrl)).toHaveLength(2);
    });
  });
});
