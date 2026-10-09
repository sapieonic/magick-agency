// PORT NOTE (magick-agency): ported from core src/telephony/voicelink/voicelink-token-manager.ts@4850d1d9; only the logger import specifier changed.
import { createChildLogger } from '@magick-agency/observability';
import type { VoicelinkConfig, VoicelinkLoginResponse } from './voicelink.types.js';

const log = createChildLogger({ component: 'voicelink-token-manager' });

/**
 * VoiceLink issues Laravel-Sanctum-style bearer tokens. No expiry was observed
 * in the reverse-engineering captures, but Sanctum tokens CAN expire, so we keep
 * a conservative proactive-refresh margin and always retain the refresh-on-401
 * path (mirrors z99). ~8 h leaves comfortable headroom for even the longest call.
 */
const REFRESH_MARGIN_MS = 8 * 60 * 60 * 1000;

/**
 * Manages the VoiceLink bearer-token lifecycle: lazy login, in-memory cache,
 * proactive refresh before the margin, and forced refresh on demand (a 401 from
 * a REST call).
 *
 * Single-flight: concurrent callers share one in-flight `POST /v1/auth/login`
 * so a burst of calls never stampedes the auth endpoint.
 *
 * Secret-safe: the username, password, and token are never written to a log
 * line — only outcome/provenance.
 */
export class VoicelinkTokenManager {
  private readonly config: VoicelinkConfig;
  private cached: { token: string; fetchedAt: number } | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(config: VoicelinkConfig) {
    this.config = config;
  }

  /**
   * Returns a valid Bearer token; logs in lazily, caches it, and refreshes
   * proactively once the cached token passes the refresh margin.
   */
  async getToken(): Promise<string> {
    if (this.cached && Date.now() - this.cached.fetchedAt < REFRESH_MARGIN_MS) {
      return this.cached.token;
    }
    return this.login();
  }

  /**
   * Forces a re-login regardless of cache freshness (called on a 401 from any
   * VoiceLink REST call). Single-flight: concurrent callers await the same
   * in-flight login promise.
   */
  async refresh(): Promise<string> {
    this.cached = null;
    return this.login();
  }

  /** Shares one in-flight login across concurrent callers. */
  private login(): Promise<string> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doLogin()
      .then((token) => {
        this.cached = { token, fetchedAt: Date.now() };
        log.info('VoiceLink login successful');
        return token;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async doLogin(): Promise<string> {
    const url = `${this.config.baseUrl}/v1/auth/login`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: this.config.username,
          password: this.config.password,
        }),
      });
    } catch (err) {
      // `err` is a network error — it does not carry the request body/secrets.
      log.error({ err }, 'VoiceLink login request failed (network error)');
      throw new Error('VoiceLink login request failed');
    }

    if (!response.ok) {
      log.error({ status: response.status }, 'VoiceLink login returned non-ok status');
      throw new Error(`VoiceLink login failed: HTTP ${response.status}`);
    }

    const data = (await response.json()) as VoicelinkLoginResponse;
    const token = data?.data?.access_token;
    if (!token || typeof token !== 'string' || token.length === 0) {
      log.error({ message: data?.message }, 'VoiceLink login response missing token');
      throw new Error('VoiceLink login response missing token');
    }

    return token;
  }
}
