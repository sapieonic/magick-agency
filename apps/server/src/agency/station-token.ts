import crypto from 'node:crypto';
import type Redis from 'ioredis';
import { createChildLogger } from '@magick-agency/observability';

const log = createChildLogger({ component: 'agency-station-token' });

/**
 * How long a station upgrade token lives. Short on purpose — it authenticates one
 * WebSocket upgrade, not a shift.
 */
export const STATION_TOKEN_TTL_MS = 120_000;

/**
 * Consume the token only if it matches, so a token is single-use. Doing this in
 * Lua rather than GET-then-DEL matters: two upgrades racing the same stolen URL
 * would both pass a read-then-delete check.
 */
const CONSUME = `
local stored = redis.call('GET', KEYS[1])
if stored == false then return 0 end
if stored ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`;

/**
 * Mints and verifies the short-lived tokens that authenticate a station socket
 * **upgrade**.
 *
 * The security model, stated once because it is the whole design: a browser
 * `WebSocket` cannot set an `Authorization` header, so the Firebase bearer is
 * unavailable on the upgrade and the server cannot authenticate it. This token is the
 * only authority on that connection. It is therefore made worth as little as
 * possible — **single-use and ~2 minutes** — and the *session* is authenticated by
 * the bound socket thereafter, not by anything replayable in a URL.
 *
 * Reconnect re-mints over ordinary authenticated HTTP, which the browser can carry
 * a bearer on. That is why there is no `reauth` frame and no long-lived secret.
 */
export class StationTokenStore {
  /** Fallback when Redis is unavailable: in-process, single-replica only. */
  private readonly local = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly redis: Redis | null,
    private readonly keyPrefix: string,
  ) {}

  private key(sessionId: string): string {
    return `${this.keyPrefix}agency:station-token:${sessionId}`;
  }

  /** Mint a fresh token, replacing any unused one for this session. */
  async mint(sessionId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + STATION_TOKEN_TTL_MS);
    if (this.redis) {
      try {
        await this.redis.set(this.key(sessionId), token, 'PX', STATION_TOKEN_TTL_MS);
        return { token, expiresAt };
      } catch (err) {
        log.warn({ err, sessionId }, 'Redis unavailable for station token — using local store');
      }
    }
    this.local.set(sessionId, { token, expiresAt: expiresAt.getTime() });
    return { token, expiresAt };
  }

  /**
   * Verify and consume. Returns false for missing, expired, wrong, or
   * already-used tokens — the caller must close the socket, never degrade to
   * accepting it.
   *
   * Note this deliberately does NOT have the `verifyWsToken` accept-on-missing-key
   * fallback the per-call browser leg uses. That fallback is defensible for a
   * token whose call id is already unguessable and short-lived; it is not
   * defensible for the credential guarding an eight-hour socket that can hear
   * every customer an agent talks to.
   */
  async verifyAndConsume(sessionId: string, token: string | undefined): Promise<boolean> {
    if (!token) return false;
    if (this.redis) {
      try {
        const res = await this.redis.eval(CONSUME, 1, this.key(sessionId), token);
        return res === 1;
      } catch (err) {
        // Fail CLOSED. An unverifiable credential on the agent media path is a
        // reason to refuse the connection, not to wave it through.
        log.error({ err, sessionId }, 'Station token verification failed — refusing upgrade');
        return false;
      }
    }
    const entry = this.local.get(sessionId);
    if (!entry) return false;
    this.local.delete(sessionId); // single-use regardless of outcome
    if (entry.expiresAt < Date.now()) return false;
    const a = Buffer.from(entry.token);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}
