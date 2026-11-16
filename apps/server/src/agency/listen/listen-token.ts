import crypto from 'node:crypto';
import type Redis from 'ioredis';
import { createChildLogger } from '@magick-agency/observability';
import { AGENCY_CALL_ORIGINS, type AgencyCallOrigin } from '@magick-agency/contracts/agency';

const log = createChildLogger({ component: 'agency-listen-token' });

/**
 * What a listen grant carries to its socket's upgrade (`docs/listening.md` §4): everything the
 * upgrade needs to write the session row and attach the tap, decided over authenticated HTTP by
 * the grant. The socket's URL names only the session and the listen id; the rest is here, behind
 * the single-use token, so nothing on the URL is trusted.
 */
export interface ListenGrantPayload {
  listenId: string;
  /** The agent's session: the socket's `:sessionId` must match it. */
  sessionId: string;
  tenantId: string;
  accountId: string;
  /** `agency_calls.id`: the bridge session's key. */
  callId: string;
  origin: AgencyCallOrigin;
  campaignId: string | null;
  /** The spine row (attempt, manual call or inbound call). */
  correlationId: string;
  agentUserId: string;
  listenerUserId: string;
  /** The call's `recording_requested`, for the re-check's LS4 rule. */
  recording: boolean;
}

/**
 * The token could not be stored, so it could never verify. The grant answers
 * `503 listen_unavailable` rather than hand out a URL whose upgrade is certain to be refused.
 */
export class ListenTokenUnavailableError extends Error {
  constructor(readonly listenId: string, options?: { cause?: unknown }) {
    super('Listen token could not be stored', options);
    this.name = 'ListenTokenUnavailableError';
  }
}

/**
 * Consume the grant only if the token matches, in one step: the stored value is
 * `<token>|<payload JSON>`. Two upgrades racing one URL cannot both pass.
 */
const CONSUME = `
local stored = redis.call('GET', KEYS[1])
if stored == false then return false end
local prefix = ARGV[1] .. '|'
if string.sub(stored, 1, string.len(prefix)) ~= prefix then return false end
redis.call('DEL', KEYS[1])
return string.sub(stored, string.len(prefix) + 1)
`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** A stored grant read back: every field checked, so a value that is not one is no grant. */
export function parseListenGrantPayload(raw: unknown): ListenGrantPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const ids = ['listenId', 'sessionId', 'tenantId', 'accountId', 'callId', 'correlationId', 'agentUserId', 'listenerUserId'] as const;
  for (const k of ids) if (!isUuid(r[k])) return null;
  if (!(AGENCY_CALL_ORIGINS as readonly unknown[]).includes(r['origin'])) return null;
  if (r['campaignId'] !== null && !isUuid(r['campaignId'])) return null;
  if (typeof r['recording'] !== 'boolean') return null;
  return {
    listenId: r['listenId'] as string, sessionId: r['sessionId'] as string, tenantId: r['tenantId'] as string,
    accountId: r['accountId'] as string, callId: r['callId'] as string, origin: r['origin'] as AgencyCallOrigin,
    campaignId: r['campaignId'] as string | null, correlationId: r['correlationId'] as string,
    agentUserId: r['agentUserId'] as string, listenerUserId: r['listenerUserId'] as string, recording: r['recording'] as boolean,
  };
}

/**
 * The single-use tokens that authenticate a listener socket's upgrade, modelled on
 * `StationTokenStore` (`../station-token.ts`) and for the same reason: a browser `WebSocket`
 * cannot carry the Firebase bearer, so this token is the only authority on that upgrade. It is
 * worth as little as possible: one upgrade, `AGENCY_LISTEN_TOKEN_TTL_MS` (60 s by default), keyed
 * by the listen id (one grant, one listen). A reconnect mints a fresh grant over authenticated HTTP.
 *
 * Fail closed both ways: a token that cannot be stored is a 503 at the grant, and a token that
 * cannot be verified (Redis down, a value that does not parse) is a refused upgrade, never an
 * accepted one.
 */
export class ListenTokenStore {
  /** The store with no Redis configured (tests, a bare dev run): in-process. */
  private readonly local = new Map<string, { token: string; payload: ListenGrantPayload; expiresAt: number }>();

  constructor(
    private readonly redis: Redis | null,
    private readonly keyPrefix: string,
    /** `AGENCY_LISTEN_TOKEN_TTL_MS`: how long a grant's token lasts. */
    private readonly tokenTtlMs: number,
  ) {}

  /** The Redis key of a listen's grant. */
  key(listenId: string): string {
    return `${this.keyPrefix}agency:listen-token:${listenId}`;
  }

  /** Store a grant; answer its token and when it lapses. Throws {@link ListenTokenUnavailableError}. */
  async mint(payload: ListenGrantPayload): Promise<{ token: string; expiresAt: Date }> {
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + this.tokenTtlMs);
    if (this.redis) {
      try {
        await this.redis.set(this.key(payload.listenId), `${token}|${JSON.stringify(payload)}`, 'PX', this.tokenTtlMs);
      } catch (err) {
        log.warn({ err, listenId: payload.listenId }, 'Redis unavailable for the listen token — answering 503');
        throw new ListenTokenUnavailableError(payload.listenId, { cause: err });
      }
      return { token, expiresAt };
    }
    this.local.set(payload.listenId, { token, payload, expiresAt: expiresAt.getTime() });
    return { token, expiresAt };
  }

  /**
   * Verify and spend: the grant for a token that matches, else null (missing, expired, wrong,
   * already used, unverifiable). The caller closes the socket on null, never degrades to accepting.
   */
  async consume(listenId: string, token: string | undefined): Promise<ListenGrantPayload | null> {
    if (!token || token.includes('|')) return null;
    if (this.redis) {
      let raw: unknown;
      try {
        raw = await this.redis.eval(CONSUME, 1, this.key(listenId), token);
      } catch (err) {
        log.error({ err, listenId }, 'Listen token verification failed — refusing the upgrade');
        return null;
      }
      if (typeof raw !== 'string') return null;
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return null; }
      const payload = parseListenGrantPayload(parsed);
      return payload && payload.listenId === listenId ? payload : null;
    }
    const entry = this.local.get(listenId);
    if (!entry) return null;
    this.local.delete(listenId); // single-use whatever the outcome
    if (entry.expiresAt < Date.now()) return null;
    const a = Buffer.from(entry.token);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? entry.payload : null;
  }
}
