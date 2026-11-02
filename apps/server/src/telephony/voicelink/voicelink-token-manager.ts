import { createChildLogger } from '@magick-agency/observability';
import type { VoicelinkConfig, VoicelinkLoginResponse } from './voicelink.types.js';
import { CarrierRequestTimeoutError, isAbortTimeout } from '../carrier-errors.js';

const log = createChildLogger({ component: 'voicelink-token-manager' });

/**
 * VoiceLink issues Laravel-Sanctum-style bearer tokens. No expiry was observed
 * in the reverse-engineering captures, but Sanctum tokens CAN expire, so we keep
 * a conservative proactive-refresh margin and always retain the refresh-on-401
 * path. ~8 h leaves comfortable headroom for even the longest call.
 */
const REFRESH_MARGIN_MS = 8 * 60 * 60 * 1000;

/**
 * Default login timeout (`VOICELINK_LOGIN_TIMEOUT_MS`). The login is single-flight, so every
 * dial that arrives while it is in flight waits on it: without a timeout one hung login
 * held the whole floor's dials for undici's 300 s default. 10 s is far above a healthy
 * login (well under a second) and short enough that a burst fails fast and the next dial
 * starts a fresh login. A login carries no lead, so its timeout is a plain failure: no dial
 * was placed.
 */
export const DEFAULT_VOICELINK_LOGIN_TIMEOUT_MS = 10_000;

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

  /**
   * Shares one in-flight login across concurrent callers. The login is bounded by
   * `loginTimeoutMs`, and `inFlight` is cleared when it settles either way, so a timed-out
   * login rejects every waiter once and the next caller starts a new one.
   */
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
    const timeoutMs = this.config.loginTimeoutMs ?? DEFAULT_VOICELINK_LOGIN_TIMEOUT_MS;
    // One signal for the request AND the body read below: a carrier that sends headers and
    // then stalls the body is bounded too.
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: this.config.username,
          password: this.config.password,
        }),
        signal,
      });
    } catch (err) {
      if (isAbortTimeout(err)) {
        log.error({ timeoutMs }, 'VoiceLink login request timed out');
        throw new CarrierRequestTimeoutError('VoiceLink login', timeoutMs, false);
      }
      // `err` is a network error — it does not carry the request body/secrets.
      log.error({ err }, 'VoiceLink login request failed (network error)');
      throw new Error('VoiceLink login request failed');
    }

    if (!response.ok) {
      log.error({ status: response.status }, 'VoiceLink login returned non-ok status');
      throw new Error(`VoiceLink login failed: HTTP ${response.status}`);
    }

    let data: VoicelinkLoginResponse;
    try {
      data = (await response.json()) as VoicelinkLoginResponse;
    } catch (err) {
      if (isAbortTimeout(err)) {
        log.error({ timeoutMs }, 'VoiceLink login response timed out');
        throw new CarrierRequestTimeoutError('VoiceLink login', timeoutMs, false);
      }
      throw err;
    }
    const token = data?.data?.access_token;
    if (!token || typeof token !== 'string' || token.length === 0) {
      log.error({ message: data?.message }, 'VoiceLink login response missing token');
      throw new Error('VoiceLink login response missing token');
    }

    return token;
  }
}
