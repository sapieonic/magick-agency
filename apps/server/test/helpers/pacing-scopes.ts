/**
 * Dial scopes for unit tests of the pacing engine (`src/agency/pacing/dial-scopes.ts`).
 *
 * The engine's default scope source reads the database and the concurrency-control seam,
 * neither of which a unit test has: unread, it fails closed and the tick dials nothing, so
 * every dialling assertion would pass vacuously or fail for the wrong reason. A unit test
 * that is not about the scopes installs {@link UNBOUNDED_SCOPES} as the default:
 *
 *   vi.mock('../../../src/agency/pacing/dial-scopes.js', async (importOriginal) =>
 *     (await import('../../helpers/pacing-scopes.js')).withUnboundedScopes(await importOriginal()));
 *
 * A legacy-total account and no carrier account with a cap of its own: the account's cap is the
 * only bound, exactly the tick these tests were written for. A test about the scopes passes its
 * own source ({@link scriptedScopes}) as `PacingEngineOptions.scopes`.
 */
import type { PacingScopeSource } from '../../src/agency/pacing/dial-scopes.js';

export const UNBOUNDED_SCOPES: PacingScopeSource = {
  carrierShares: async () => ({ breakdown: false, shares: new Map() }),
  credentialCap: async () => null,
  carrierShareLive: async () => 0,
  credentialLive: async () => 0,
};

/** The dial-scopes module with {@link UNBOUNDED_SCOPES} as its default source. */
export function withUnboundedScopes(actual: unknown): Record<string, unknown> {
  return { ...(actual as Record<string, unknown>), repositoryScopeSource: UNBOUNDED_SCOPES };
}

/**
 * A source a test scripts: per account its carrier shares (absent: a single total), per
 * credential its cap, and the guards' live counters, which the test moves as calls start and
 * end. `fail` makes a read throw (a limit) or answer null (a counter).
 */
export function scriptedScopes() {
  const shares = new Map<string, Map<string, number>>();
  const caps = new Map<string, number | null>();
  const shareLive = new Map<string, number>();
  const credentialLive = new Map<string, number>();
  const fail = { shares: false, cap: false, shareLive: false, credentialLive: false };
  const reads = { shares: 0, cap: 0, shareLive: 0, credentialLive: 0 };
  const source: PacingScopeSource = {
    async carrierShares(tenantId, accountId) {
      reads.shares++;
      if (fail.shares) throw new Error('allocation unreadable');
      const byProvider = shares.get(`${tenantId}:${accountId}`);
      return { breakdown: byProvider !== undefined, shares: byProvider ?? new Map() };
    },
    async credentialCap(credentialId) {
      reads.cap++;
      if (fail.cap) throw new Error('cap unreadable');
      return caps.get(credentialId) ?? null;
    },
    async carrierShareLive(tenantId, accountId, provider) {
      reads.shareLive++;
      return fail.shareLive ? null : shareLive.get(`${tenantId}:${accountId}:${provider}`) ?? 0;
    },
    async credentialLive(credentialId) {
      reads.credentialLive++;
      return fail.credentialLive ? null : credentialLive.get(credentialId) ?? 0;
    },
  };
  return { source, shares, caps, shareLive, credentialLive, fail, reads };
}
