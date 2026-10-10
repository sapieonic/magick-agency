import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The token manager logs through a CHILD logger (createChildLogger → logger.child).
// To make the secret-safety assertions real (not a vacuous parent-logger spy),
// mock the logger module so `createChildLogger` returns a shared spy object that
// IS the logger the manager writes to. vi.mock is hoisted above the import below,
// so the manager's module-level `log` binds to this spy at import time.
const logMocks = vi.hoisted(() => ({
  child: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => logMocks.child,
  logger: logMocks.child,
}));

import { VoicelinkTokenManager } from '../../../../src/telephony/voicelink/voicelink-token-manager.js';
import type { VoicelinkConfig } from '../../../../src/telephony/voicelink/voicelink.types.js';

const VOICELINK_CONFIG: VoicelinkConfig = {
  baseUrl: 'https://app.voicelink.example/api',
  username: 'vl-user',
  password: 'super-secret-password',
  webhookBaseUrl: 'https://host/api/v1/webhooks/voicelink',
  defaultCountryCode: '91',
};

const TOKEN = '42|laravelSanctumStyleTokenAbc123';

// VoiceLink nests the token at data.access_token (Laravel-Sanctum style).
function loginOk(token = TOKEN) {
  const payload = { data: { access_token: token, token_type: 'Bearer', user: { id: 1 } } };
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

describe('VoicelinkTokenManager', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    logMocks.child.info.mockClear();
    logMocks.child.error.mockClear();
    logMocks.child.warn.mockClear();
    logMocks.child.debug.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('logs in once on first getToken and returns the token from data.access_token', async () => {
    mockFetch.mockResolvedValue(loginOk());
    const mgr = new VoicelinkTokenManager(VOICELINK_CONFIG);

    const token = await mgr.getToken();

    expect(token).toBe(TOKEN);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://app.voicelink.example/api/v1/auth/login');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    // No businessName field (unlike z99) — login is username/password only.
    expect(body).toEqual({ username: 'vl-user', password: 'super-secret-password' });
  });

  it('returns the cached token without a second fetch when still fresh', async () => {
    mockFetch.mockResolvedValue(loginOk());
    const mgr = new VoicelinkTokenManager(VOICELINK_CONFIG);

    await mgr.getToken();
    const second = await mgr.getToken();

    expect(second).toBe(TOKEN);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('re-logs-in once the cached token passes the refresh margin', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'));
    mockFetch.mockResolvedValueOnce(loginOk('first-token')).mockResolvedValueOnce(loginOk('second-token'));
    const mgr = new VoicelinkTokenManager(VOICELINK_CONFIG);

    const first = await mgr.getToken();
    expect(first).toBe('first-token');

    // Advance past the 8h refresh margin.
    vi.setSystemTime(new Date('2026-07-11T08:30:00Z'));
    const second = await mgr.getToken();

    expect(second).toBe('second-token');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('shares a single in-flight login across concurrent getToken callers', async () => {
    let resolveLogin: (v: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      resolveLogin = resolve;
    });
    mockFetch.mockReturnValue(pending.then(() => loginOk()));
    const mgr = new VoicelinkTokenManager(VOICELINK_CONFIG);

    const p1 = mgr.getToken();
    const p2 = mgr.getToken();
    resolveLogin(null);
    const [t1, t2] = await Promise.all([p1, p2]);

    expect(t1).toBe(TOKEN);
    expect(t2).toBe(TOKEN);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('coalesces N concurrent getToken callers into a single login', async () => {
    let resolveLogin: (v: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      resolveLogin = resolve;
    });
    mockFetch.mockReturnValue(pending.then(() => loginOk()));
    const mgr = new VoicelinkTokenManager(VOICELINK_CONFIG);

    const promises = Array.from({ length: 12 }, () => mgr.getToken());
    resolveLogin(null);
    const tokens = await Promise.all(promises);

    expect(tokens.every((t) => t === TOKEN)).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('coalesces N concurrent refresh() callers into a single login', async () => {
    let resolveLogin: (v: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      resolveLogin = resolve;
    });
    mockFetch.mockReturnValue(pending.then(() => loginOk()));
    const mgr = new VoicelinkTokenManager(VOICELINK_CONFIG);

    const promises = Array.from({ length: 8 }, () => mgr.refresh());
    resolveLogin(null);
    const tokens = await Promise.all(promises);

    expect(tokens.every((t) => t === TOKEN)).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('refresh() forces a fresh login even when the cache is still warm', async () => {
    mockFetch.mockResolvedValueOnce(loginOk('first-token')).mockResolvedValueOnce(loginOk('second-token'));
    const mgr = new VoicelinkTokenManager(VOICELINK_CONFIG);

    const first = await mgr.getToken();
    const refreshed = await mgr.refresh();
    const afterRefresh = await mgr.getToken();

    expect(first).toBe('first-token');
    expect(refreshed).toBe('second-token');
    // After refresh the new token is cached — no third login.
    expect(afterRefresh).toBe('second-token');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('never writes the token to a log line on the success path', async () => {
    mockFetch.mockResolvedValue(loginOk());
    const mgr = new VoicelinkTokenManager(VOICELINK_CONFIG);

    await mgr.getToken();

    const serialized = JSON.stringify([...logMocks.child.info.mock.calls, ...logMocks.child.error.mock.calls]);
    expect(serialized).not.toContain(TOKEN);
  });

  // ─── refresh-margin boundary (fake timers) ───────────────────────────────
  describe('refresh-margin boundary', () => {
    it('does NOT re-login just before the 8h margin', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-11T00:00:00Z'));
      mockFetch.mockResolvedValue(loginOk());
      const mgr = new VoicelinkTokenManager(VOICELINK_CONFIG);

      await mgr.getToken();
      // 1 ms before the 8h margin — still cached.
      vi.setSystemTime(new Date('2026-07-11T00:00:00Z').getTime() + 8 * 60 * 60 * 1000 - 1);
      await mgr.getToken();

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('re-logs-in exactly at the 8h margin (margin is exclusive)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-11T00:00:00Z'));
      mockFetch.mockResolvedValueOnce(loginOk('t1')).mockResolvedValueOnce(loginOk('t2'));
      const mgr = new VoicelinkTokenManager(VOICELINK_CONFIG);

      const first = await mgr.getToken();
      // `Date.now() - fetchedAt < MARGIN` is false at exactly the margin → re-login.
      vi.setSystemTime(new Date('2026-07-11T00:00:00Z').getTime() + 8 * 60 * 60 * 1000);
      const second = await mgr.getToken();

      expect(first).toBe('t1');
      expect(second).toBe('t2');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // ─── login failure modes (each throws and does NOT cache) ─────────────────
  describe('login failure modes', () => {
    const assertNoCache = async (mgr: VoicelinkTokenManager) => {
      // A subsequent successful login must perform a fresh fetch — proving the
      // failed attempt cached nothing.
      mockFetch.mockReset();
      mockFetch.mockResolvedValue(loginOk('recovered'));
      const token = await mgr.getToken();
      expect(token).toBe('recovered');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    };

    it('non-ok HTTP status', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}), text: async () => 'err' });
      const mgr = new VoicelinkTokenManager(VOICELINK_CONFIG);
      await expect(mgr.getToken()).rejects.toThrow(/VoiceLink login failed: HTTP 500/);
      await assertNoCache(mgr);
    });

    it('ok but data.access_token missing', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { token_type: 'Bearer' }, message: 'ok' }),
        text: async () => '{}',
      });
      const mgr = new VoicelinkTokenManager(VOICELINK_CONFIG);
      await expect(mgr.getToken()).rejects.toThrow(/VoiceLink login response missing token/);
      await assertNoCache(mgr);
    });

    it('ok but empty access_token string', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { access_token: '' } }),
        text: async () => '{}',
      });
      const mgr = new VoicelinkTokenManager(VOICELINK_CONFIG);
      await expect(mgr.getToken()).rejects.toThrow(/VoiceLink login response missing token/);
      await assertNoCache(mgr);
    });

    it('ok but data field missing entirely', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ message: 'no data' }),
        text: async () => '{}',
      });
      const mgr = new VoicelinkTokenManager(VOICELINK_CONFIG);
      await expect(mgr.getToken()).rejects.toThrow(/VoiceLink login response missing token/);
      await assertNoCache(mgr);
    });

    it('ok but access_token is a non-string (typeof guard)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { access_token: { nested: 'x' } } }),
        text: async () => '{}',
      });
      const mgr = new VoicelinkTokenManager(VOICELINK_CONFIG);
      await expect(mgr.getToken()).rejects.toThrow(/VoiceLink login response missing token/);
      await assertNoCache(mgr);
    });

    it('ok but json() itself throws (malformed body)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
        text: async () => 'not json',
      });
      const mgr = new VoicelinkTokenManager(VOICELINK_CONFIG);
      await expect(mgr.getToken()).rejects.toThrow(/Unexpected token/);
      await assertNoCache(mgr);
    });

    it('network rejection on fetch is wrapped as "VoiceLink login request failed"', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const mgr = new VoicelinkTokenManager(VOICELINK_CONFIG);
      await expect(mgr.getToken()).rejects.toThrow(/VoiceLink login request failed/);
      await assertNoCache(mgr);
    });

    it('a failed login clears the in-flight slot so a later success caches normally', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}), text: async () => 'no' });
      const mgr = new VoicelinkTokenManager(VOICELINK_CONFIG);
      await expect(mgr.getToken()).rejects.toThrow();

      mockFetch.mockResolvedValue(loginOk('after-failure'));
      const t1 = await mgr.getToken();
      const t2 = await mgr.getToken(); // now cached
      expect(t1).toBe('after-failure');
      expect(t2).toBe('after-failure');
      // 1 failed + 1 success = 2 total; the cached second call adds none.
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // ─── secret safety, exhaustively across modes ─────────────────────────────
  describe('secret safety', () => {
    const SECRETS = ['super-secret-password', 'vl-user'];
    const serializedLogs = () =>
      JSON.stringify([
        ...logMocks.child.info.mock.calls,
        ...logMocks.child.error.mock.calls,
        ...logMocks.child.warn.mock.calls,
        ...logMocks.child.debug.mock.calls,
      ]);

    it('positive control: the leak matcher WOULD fire if a secret were logged', () => {
      // Mutation-style proof the assertion is non-vacuous.
      const leaky = JSON.stringify([['login attempt', { password: 'super-secret-password' }]]);
      expect(leaky).toContain('super-secret-password');
    });

    it('no secret leaks on the success path', async () => {
      mockFetch.mockResolvedValue(loginOk());
      const mgr = new VoicelinkTokenManager(VOICELINK_CONFIG);
      await mgr.getToken();
      const logs = serializedLogs();
      for (const s of SECRETS) expect(logs).not.toContain(s);
      expect(logs).not.toContain(TOKEN);
    });

    it('no secret leaks on the non-ok failure path', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}), text: async () => 'err' });
      const mgr = new VoicelinkTokenManager(VOICELINK_CONFIG);
      await expect(mgr.getToken()).rejects.toThrow();
      expect(logMocks.child.error).toHaveBeenCalled();
      const logs = serializedLogs();
      for (const s of SECRETS) expect(logs).not.toContain(s);
    });

    it('no secret leaks on the network-error path', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const mgr = new VoicelinkTokenManager(VOICELINK_CONFIG);
      await expect(mgr.getToken()).rejects.toThrow();
      expect(logMocks.child.error).toHaveBeenCalled();
      const logs = serializedLogs();
      for (const s of SECRETS) expect(logs).not.toContain(s);
    });

    it('no secret leaks on the missing-token path', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: {} }),
        text: async () => '{}',
      });
      const mgr = new VoicelinkTokenManager(VOICELINK_CONFIG);
      await expect(mgr.getToken()).rejects.toThrow();
      const logs = serializedLogs();
      for (const s of SECRETS) expect(logs).not.toContain(s);
    });
  });
});
