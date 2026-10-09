// PORT NOTE (magick-agency, Phase 6): ported from core test/unit/agency/station-token.test.ts@4850d1d9 (5 → 5).
// Verbatim. Import paths only (logger → `@magick-agency/observability`). No case deleted or modified.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { StationTokenStore, STATION_TOKEN_TTL_MS } from '../../../src/agency/station-token.js';

/** Minimal Redis double with the GET/SET/DEL semantics the Lua script relies on. */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
    // Mirrors CONSUME: match-then-delete, atomically from the caller's view.
    eval: vi.fn(async (_script: string, _n: number, key: string, token: string) => {
      const stored = store.get(key);
      if (stored === undefined || stored !== token) return 0;
      store.delete(key);
      return 1;
    }),
  };
}

describe('StationTokenStore', () => {
  it('mints a token that verifies exactly once', async () => {
    const redis = fakeRedis();
    const tokens = new StationTokenStore(redis as any, '');
    const { token, expiresAt } = await tokens.mint('s1');

    expect(await tokens.verifyAndConsume('s1', token)).toBe(true);
    // Single-use: a replayed URL is worthless the moment it has been used once.
    expect(await tokens.verifyAndConsume('s1', token)).toBe(false);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(STATION_TOKEN_TTL_MS);
  });

  it('rejects a missing, wrong, or foreign-session token', async () => {
    const tokens = new StationTokenStore(fakeRedis() as any, '');
    const { token } = await tokens.mint('s1');

    expect(await tokens.verifyAndConsume('s1', undefined)).toBe(false);
    expect(await tokens.verifyAndConsume('s1', 'not-the-token')).toBe(false);
    // A token minted for one session must not open another agent's socket.
    expect(await tokens.verifyAndConsume('s2', token)).toBe(false);
  });

  it('re-minting invalidates the previous token', async () => {
    const redis = fakeRedis();
    const tokens = new StationTokenStore(redis as any, '');
    const first = await tokens.mint('s1');
    const second = await tokens.mint('s1');

    expect(await tokens.verifyAndConsume('s1', first.token)).toBe(false);
    expect(await tokens.verifyAndConsume('s1', second.token)).toBe(true);
  });

  it('FAILS CLOSED when Redis errors', async () => {
    const redis = fakeRedis();
    const tokens = new StationTokenStore(redis as any, '');
    const { token } = await tokens.mint('s1');
    redis.eval.mockRejectedValueOnce(new Error('redis down'));

    // Unlike the per-call browser leg's accept-on-missing-key fallback, an
    // unverifiable credential on an 8-hour agent socket must refuse the upgrade.
    expect(await tokens.verifyAndConsume('s1', token)).toBe(false);
  });

  it('works without Redis (single replica), still single-use', async () => {
    const tokens = new StationTokenStore(null, '');
    const { token } = await tokens.mint('s1');
    expect(await tokens.verifyAndConsume('s1', token)).toBe(true);
    expect(await tokens.verifyAndConsume('s1', token)).toBe(false);
  });
});
