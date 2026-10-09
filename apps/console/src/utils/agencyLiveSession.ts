import type {
  AgencyAgentState,
  AgencySessionBootstrap,
  AgencySessionConflict,
} from '../types/agency';

/**
 * This browser's knowledge of the agent's live station, so a second join can
 * be refused locally instead of charging core with a 409 it will only warn on.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Core enforces one live session per agent per tenant. The console already
 * renders that refusal (`session_on_other_campaign`) — *after* `POST /sessions`
 * has gone out and core has logged "Agency join refused — agent already live
 * on another campaign". In chitboss UAT that was two warnings from one tester
 * opening a second campaign while still joined to the first, plus a StrictMode
 * double-mount that fired the same POST twice on a single visit.
 *
 * `agencyCampaignControls` already refuses a *supervisor* click the state
 * forbids, so the click never becomes a 409. The join path had no equivalent:
 * the only way to learn "you are live elsewhere" was to ask core. Once this
 * browser has been told — a successful join, or a 409 that named the other
 * campaign — asking again is log noise. The conflict screen is shown from the
 * cache and `POST /sessions` is not issued.
 *
 * ── What this is not ─────────────────────────────────────────────────────────
 * It is not a source of truth. Core still owns the session. A cache miss
 * (another device, a reaped session, a first visit) still POSTs, and a genuine
 * race still 409s — the join effect then *writes* the cache from that body so
 * a retry in this browser does not. `confirmSwitch` still POSTs to the campaign
 * named in the conflict (that is a resume of the live session, not a second
 * join) because Leave needs the `session_id` the 409 body never carries.
 *
 * A record older than {@link LIVE_SESSION_MAX_AGE_MS} is treated as a miss.
 * The station refreshes `rememberedAt` while it is open; after Exit / a crash
 * the heartbeat lease dies in ~45s, and refusing forever would strand an
 * agent on a campaign they are no longer on. `confirmSwitch` resuming a
 * *reaped* session against a still-running campaign would join them there.
 *
 * ── Two stores, same record ──────────────────────────────────────────────────
 * Memory wins for the StrictMode remount on the same fibre (the 409 may not
 * have reached `localStorage` before the second effect runs). `localStorage`
 * wins across tabs and reloads: an agent with the station open in tab A who
 * then opens campaign B in tab B is the case the 1:1 rule exists for.
 * `localStorage` throws in some privacy modes; a throw degrades to memory-only
 * rather than blocking the join. A `storage` event from another tab updates
 * memory, so Leave in tab A unsticks tab B.
 */

const STORAGE_KEY_PREFIX = 'mv:agency-live-session:';

/**
 * How long a remembered station is enough to refuse a join locally.
 *
 * Core's heartbeat lease is 45s; this is a small buffer so Exit → open
 * another campaign while the session is still live still refuses, and a
 * crashed tab older than that is allowed to POST.
 */
export const LIVE_SESSION_MAX_AGE_MS = 60_000;

/** How often an open station bumps `rememberedAt` so a long available shift does not expire. */
export const LIVE_SESSION_TOUCH_MS = 20_000;

const AGENT_STATES: ReadonlySet<string> = new Set<AgencyAgentState>([
  'offline',
  'available',
  'reserved',
  'on_call',
  'wrapup',
  'break',
]);

export interface RememberedLiveSession {
  tenantId: string;
  campaignId: string;
  campaignName: string;
  /** Present after a successful join; absent when we only learned this from a 409. */
  sessionId: string | null;
  state: AgencyAgentState;
  /** `Date.now()` when this record was last written or touched. */
  rememberedAt: number;
}

function storageKey(tenantId: string): string {
  return `${STORAGE_KEY_PREFIX}${tenantId}`;
}

let memory: RememberedLiveSession | null = null;

type InflightJoin = { key: string; promise: Promise<unknown> };
let inflight: InflightJoin | null = null;

function isAgentState(value: unknown): value is AgencyAgentState {
  return typeof value === 'string' && AGENT_STATES.has(value);
}

function parseRecord(raw: unknown, tenantId: string): RememberedLiveSession | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const campaignId = record['campaignId'];
  const campaignName = record['campaignName'];
  const state = record['state'];
  const sessionId = record['sessionId'];
  const rememberedAt = record['rememberedAt'];
  if (typeof campaignId !== 'string' || campaignId.trim().length === 0) return null;
  if (typeof campaignName !== 'string' || campaignName.trim().length === 0) return null;
  if (!isAgentState(state)) return null;
  if (sessionId !== null && typeof sessionId !== 'string') return null;
  if (typeof sessionId === 'string' && sessionId.trim().length === 0) return null;
  if (typeof rememberedAt !== 'number' || !Number.isFinite(rememberedAt)) return null;
  return {
    tenantId,
    campaignId,
    campaignName,
    sessionId: typeof sessionId === 'string' ? sessionId : null,
    state,
    rememberedAt,
  };
}

function writeStorage(session: RememberedLiveSession): void {
  try {
    localStorage.setItem(storageKey(session.tenantId), JSON.stringify(session));
  } catch {
    // Memory still holds it for this page life.
  }
}

function readStorage(tenantId: string): RememberedLiveSession | null {
  try {
    const raw = localStorage.getItem(storageKey(tenantId));
    if (raw === null) return null;
    return parseRecord(JSON.parse(raw) as unknown, tenantId);
  } catch {
    return null;
  }
}

function removeStorage(tenantId: string): void {
  try {
    localStorage.removeItem(storageKey(tenantId));
  } catch {
    // Best-effort.
  }
}

function removeAllStorage(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(STORAGE_KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // Best-effort.
  }
}

/** The live station this browser last learned about for this tenant, or `null`. */
export function readLiveSession(tenantId: string): RememberedLiveSession | null {
  if (memory?.tenantId === tenantId) return memory;
  const stored = readStorage(tenantId);
  if (stored) memory = stored;
  return stored;
}

function writeLiveSession(session: RememberedLiveSession): void {
  memory = session;
  writeStorage(session);
}

function isFresh(session: RememberedLiveSession, now: number): boolean {
  return now - session.rememberedAt <= LIVE_SESSION_MAX_AGE_MS;
}

/** A successful join — we now know the session id as well as the campaign. */
export function rememberLiveSessionFromBootstrap(
  tenantId: string,
  session: Pick<AgencySessionBootstrap, 'session_id' | 'campaign_id' | 'campaign_name' | 'state'>,
  now: number = Date.now(),
): void {
  if (tenantId.trim().length === 0) return;
  if (session.campaign_id.trim().length === 0) return;
  if (session.campaign_name.trim().length === 0) return;
  writeLiveSession({
    tenantId,
    campaignId: session.campaign_id,
    campaignName: session.campaign_name,
    sessionId: session.session_id,
    state: session.state,
    rememberedAt: now,
  });
}

/**
 * A 409 that named the other campaign. No session id — Leave still has to
 * resume that campaign to learn one, which is `confirmSwitch`'s first request.
 */
export function rememberLiveSessionFromConflict(
  tenantId: string,
  conflict: AgencySessionConflict,
  now: number = Date.now(),
): void {
  if (tenantId.trim().length === 0) return;
  if (conflict.campaign_id.trim().length === 0) return;
  if (conflict.campaign_name.trim().length === 0) return;
  writeLiveSession({
    tenantId,
    campaignId: conflict.campaign_id,
    campaignName: conflict.campaign_name,
    sessionId: null,
    state: conflict.state,
    rememberedAt: now,
  });
}

/**
 * Keep the cached state in step with the open station, so a second tab that
 * reads it can still refuse a mid-call switch. Also bumps `rememberedAt`
 * even when the state did not change — a long available shift would otherwise
 * age out under {@link LIVE_SESSION_MAX_AGE_MS}.
 */
export function touchLiveSessionState(
  tenantId: string,
  campaignId: string,
  state: AgencyAgentState,
  now: number = Date.now(),
): void {
  const live = readLiveSession(tenantId);
  if (!live || live.campaignId !== campaignId) return;
  if (live.state === state && live.rememberedAt === now) return;
  writeLiveSession({ ...live, state, rememberedAt: now });
}

/** The agent left — this browser no longer has a live station to refuse with. */
export function clearLiveSession(tenantId: string): void {
  if (memory?.tenantId === tenantId) memory = null;
  removeStorage(tenantId);
}

/**
 * Drop every remembered station. Logout is origin-wide: the next person on
 * this browser must not inherit a join refusal that was never theirs.
 */
export function clearAllLiveSessions(): void {
  memory = null;
  removeAllStorage();
}

/**
 * The local equivalent of core's `session_on_other_campaign` 409.
 *
 * `null` when we have no cache, when the cache is older than
 * {@link LIVE_SESSION_MAX_AGE_MS}, or when the cache IS the campaign being
 * joined (that join is a resume-in-place and must still POST). Same shape as
 * {@link parseJoinConflict}'s success so the page can render one screen.
 */
export function localJoinConflict(
  tenantId: string,
  joiningCampaignId: string,
  now: number = Date.now(),
): AgencySessionConflict | null {
  const live = readLiveSession(tenantId);
  if (!live) return null;
  if (!isFresh(live, now)) return null;
  if (live.campaignId === joiningCampaignId) return null;
  return {
    error: 'Conflict',
    code: 'session_on_other_campaign',
    campaign_id: live.campaignId,
    campaign_name: live.campaignName,
    state: live.state,
  };
}

/**
 * One in-flight `POST /sessions` per campaign, so React StrictMode's
 * mount → cleanup → remount does not issue two joins (and two 409s) for one
 * visit. Settled promises are not reused: a later attempt (Leave & join,
 * a real retry) must be allowed to talk to core again.
 */
export function coalesceJoin<T>(key: string, start: () => Promise<T>): Promise<T> {
  if (inflight?.key === key) return inflight.promise as Promise<T>;
  const promise = start();
  inflight = { key, promise };
  void promise.finally(() => {
    if (inflight?.promise === promise) inflight = null;
  }).catch(() => {
    // The returned promise is what callers catch. This branch only exists so
    // a rejection is not also an unhandled-rejection from the `finally` chain.
  });
  return promise;
}

/**
 * Another tab wrote or cleared this origin's live-session key. Memory is
 * what `readLiveSession` returns first (StrictMode), so without this a Leave
 * in tab A leaves tab B refusing a join the agent is no longer on.
 */
function onStorage(event: StorageEvent): void {
  if (!event.key || !event.key.startsWith(STORAGE_KEY_PREFIX)) return;
  const tenantId = event.key.slice(STORAGE_KEY_PREFIX.length);
  if (event.newValue === null) {
    if (memory?.tenantId === tenantId) memory = null;
    return;
  }
  try {
    const parsed = parseRecord(JSON.parse(event.newValue) as unknown, tenantId);
    if (parsed) memory = parsed;
  } catch {
    // A malformed write from another tab is not ours to repair.
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', onStorage);
}

/** Test isolation — production code never needs a process-wide wipe. */
export function resetLiveSessionForTests(): void {
  memory = null;
  inflight = null;
  removeAllStorage();
}
