/**
 * The capacity scopes a paced dial is admitted against BESIDES its account's own cap, and how
 * much room each leaves this tick (docs/carriers.md CR13, decisions PL14, B22).
 *
 * Bridge admission takes up to four scopes at once (`core/telephony-guard-host.ts`): the global
 * cap, the account's cap, the account's share for the carrier when the account's concurrency is
 * split by carrier (`concurrency_allocation_mode = 'provider_breakdown'`), and the cap of the
 * tenant carrier account the call is placed on (`telephony_credentials.max_concurrent_calls`,
 * tenant-wide across every account of the tenant). The tick already paces against the account
 * cap (`planTick`); this module is the other two. Without them a tick whose binding scope is the
 * carrier share or the carrier account's cap reserved agents, claimed contacts and inserted
 * attempts every round, only for admission to refuse the surplus (`provider_concurrency_limit`,
 * `carrier_account_concurrency_limit`). The global cap is a process-wide safety ceiling and is
 * left to admission.
 *
 * ── What is read, and from where ──────────────────────────────────────────────
 * The LIMITS are what admission reads (the account's allocation; the credential's cap), cached
 * in the engine and dropped by the same invalidations that drop the guards' caches
 * (`account_limit_changed`, `credential_limit_changed`: `pacing/limit-invalidation.ts`). The LIVE
 * calls are the guards' own Redis counters, read through the concurrency-control seam
 * (`getProviderCount`, `getCredentialCounts`): admission compares against exactly these, and
 * they hold calls pacing did not make (an inbound call on the carrier account, a soft-phone dial,
 * another account's campaigns on the same credential), which no database count of this account
 * could see. Each scope is read once per round, however many ticks of the round dial on it.
 *
 * ── Granted but not yet counted: the scope ledger ────────────────────────────
 * A dial enters the guard's counter at admission, inside the dispatch, so between its grant and
 * its admission it is in no counter. The engine keeps, per scope, the dials granted on it that
 * have not yet SETTLED (been dispatched: admitted or refused), and a running total of every dial
 * ever granted on it. A reading snapshots both, synchronously, BEFORE it issues the Redis read;
 * the room it leaves at any later instant is
 *
 *     room = limit − live − pendingAtSnapshot − (grantedNow − grantedAtSnapshot)
 *
 * (`scopeRoom`). A dial granted before the snapshot is in `pendingAtSnapshot` (or, settled, in
 * `live`); one granted after it is in the difference of the totals, whichever account's split
 * granted it and whichever round. A dial admitted between the snapshot and the read is counted
 * twice: an under-dial of one, for one round, never an over-dial. Every grant is charged
 * synchronously inside the split that makes it (`PacingRound`'s `onGrant`), so two splits (two
 * accounts of one tenant on one credential, in one round or in two) can never both spend the
 * same room: JavaScript runs one split at a time. That is what makes the credential's headroom,
 * shared across accounts, safe inside one process without any lock or Redis reservation.
 *
 * ── Failure direction ─────────────────────────────────────────────────────────
 * As admission's: a capped call is refused when its cap or its live count cannot be read
 * (`allocation_unavailable`, `redis_unavailable`), so a scope that cannot be read leaves NO room
 * and the tick plans 0 for that campaign (`no_slots`), rather than dial into refusals.
 */
import { providerConcurrencyRepository } from '@magick-agency/db/repositories/provider-concurrency.repository';
import { telephonyCredentialRepository } from '@magick-agency/db/repositories/telephony-credential.repository';
import { getConcurrencyControl } from '../../seams/concurrency-control.js';

/** An account's concurrency allocation as pacing needs it: whether it is split by carrier, and each carrier's share. */
export interface AccountCarrierShares {
  breakdown: boolean;
  /** Carrier name (lower case) → its share. Absent: none allocated (PL14). */
  shares: ReadonlyMap<string, number>;
}

/**
 * Where the scope reads go. The default ({@link repositoryScopeSource}) is the repositories
 * admission reads and the concurrency-control seam's counters; tests pass their own.
 */
export interface PacingScopeSource {
  /** The account's allocation. Throws when it cannot be read. */
  carrierShares(tenantId: string, accountId: string): Promise<AccountCarrierShares>;
  /** A carrier account's own cap, null for none. Throws when it cannot be read. */
  credentialCap(credentialId: string): Promise<number | null>;
  /** Live calls in the account's share of `provider`, from the guard's counter; null when unreadable. */
  carrierShareLive(tenantId: string, accountId: string, provider: string): Promise<number | null>;
  /** Live calls on the carrier account, from the guard's counter; null when unreadable. */
  credentialLive(credentialId: string): Promise<number | null>;
}

/** A cap as the credential guard reads it: a positive integer, anything else none (`resolveCap`). */
export function normaliseCredentialCap(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null;
}

export const repositoryScopeSource: PacingScopeSource = {
  async carrierShares(tenantId, accountId) {
    const allocation = await providerConcurrencyRepository.getAllocation(tenantId, accountId);
    return {
      breakdown: allocation.mode === 'provider_breakdown',
      shares: new Map(allocation.providers.map((p) => [p.provider.toLowerCase(), p.max_concurrent_calls])),
    };
  },
  async credentialCap(credentialId) {
    return normaliseCredentialCap(await telephonyCredentialRepository.getConcurrencyCap(credentialId));
  },
  async carrierShareLive(tenantId, accountId, provider) {
    try {
      return await getConcurrencyControl().getProviderCount(tenantId, accountId, provider);
    } catch {
      return null;
    }
  },
  async credentialLive(credentialId) {
    try {
      const read = await getConcurrencyControl().getCredentialCounts([credentialId]);
      return read.status === 'available' ? read.counts.get(credentialId) ?? 0 : null;
    } catch {
      return null;
    }
  },
};

/** The ledger key of an account's share of one carrier. */
export function carrierShareScopeKey(accountKey: string, provider: string): string {
  return `provider:${accountKey}:${provider}`;
}

/** The ledger key of a tenant carrier account. */
export function credentialScopeKey(credentialId: string): string {
  return `credential:${credentialId}`;
}

/** One scope as one round read it. */
export interface ScopeReading {
  key: string;
  kind: 'carrier_share' | 'carrier_account';
  limit: number;
  /** The guard's counter at the read. */
  live: number;
  /** The scope's unsettled grants, snapshotted before the read was issued. */
  pendingAtSnapshot: number;
  /** The scope's running total of grants, snapshotted with them. */
  grantedAtSnapshot: number;
}

/** The room `reading` leaves when the scope's running total of grants is `grantedNow`. Never negative. */
export function scopeRoom(reading: ScopeReading, grantedNow: number): number {
  const since = Math.max(0, grantedNow - reading.grantedAtSnapshot);
  return Math.max(0, Math.floor(reading.limit - reading.live - reading.pendingAtSnapshot - since));
}

/** A scope as a share claim carries it into the split: its key and its room right now. */
export interface ScopeRoom {
  key: string;
  room(): number;
}

/** The smallest room of `scopes` right now; Infinity for none. */
export function tightestRoom(scopes: readonly ScopeRoom[] | undefined): number {
  let room = Number.POSITIVE_INFINITY;
  for (const s of scopes ?? []) room = Math.min(room, Math.max(0, Math.floor(s.room())));
  return room;
}
