/**
 * The per-campaign leader lease in Redis — the pacing engine's EFFICIENCY
 * mechanism (it stops N replicas doing the same work), never its correctness
 * one: see `PacingEngine`'s header for why the contact claim, not this, is what
 * prevents double-dialing. Split out of `pacing-engine.ts`; its log lines keep the
 * engine's component name.
 */
import type Redis from 'ioredis';
import { createChildLogger } from '@magick-agency/observability';

const log = createChildLogger({ component: 'agency-pacing-engine' });

/** Leader lease. Renewed at a third of its length. */
export const LEADER_LEASE_MS = 15_000;
export const LEADER_RENEW_MS = 5_000;

/**
 * Renew a leader lease only if we still hold it. Losing leadership and then
 * re-taking it by blind SET is how two leaders end up dialing one campaign.
 */
const RENEW_LEASE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`;

const RELEASE_LEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

/** What a renewal learned: still ours, taken by someone else, or not known (Redis failed). */
export type LeaseRenewal = 'held' | 'lost' | 'unknown';

export class LeaderLease {
  constructor(
    private readonly redis: Redis | null,
    private readonly keyPrefix: string,
    private readonly replicaId: string,
  ) {}

  private key(campaignId: string): string {
    return `${this.keyPrefix}agency:leader:${campaignId}`;
  }

  async tryAcquire(campaignId: string): Promise<boolean> {
    // No Redis ⇒ single replica by definition; lead everything. Fail-open is right
    // here (unlike the DNC check): the DB claim still prevents double-dialing.
    if (!this.redis) return true;
    try {
      const res = await this.redis.set(
        this.key(campaignId), this.replicaId, 'PX', LEADER_LEASE_MS, 'NX',
      );
      return res === 'OK';
    } catch (err) {
      log.warn({ err, campaignId }, 'Leader lease acquire failed');
      return false;
    }
  }

  /** Extend the lease if we still hold it. No Redis ⇒ always `held`. */
  async renew(campaignId: string): Promise<LeaseRenewal> {
    if (!this.redis) return 'held';
    try {
      const ok = await this.redis.eval(RENEW_LEASE, 1, this.key(campaignId), this.replicaId, LEADER_LEASE_MS);
      return ok === 1 ? 'held' : 'lost';
    } catch (err) {
      log.warn({ err, campaignId }, 'Leader lease renew failed');
      return 'unknown';
    }
  }

  /** Give the lease up if we still hold it. Best effort: it TTLs out otherwise. */
  async release(campaignId: string): Promise<void> {
    if (!this.redis) return;
    await this.redis.eval(RELEASE_LEASE, 1, this.key(campaignId), this.replicaId)
      .catch(() => { /* it will TTL out */ });
  }
}
