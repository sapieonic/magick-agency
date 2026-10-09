import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

/**
 * The invitation token (`src/notifications/invite-token.ts`).
 *
 * ── What is at stake, so the assertions read as more than arithmetic ────────
 * This token is a bearer credential. Possession of it binds a Firebase identity
 * to a pre-created membership, with no email match, no password and no second
 * factor. Three properties are what make that safe, and each has a case below:
 *
 *  1. **It is unguessable.** 32 bytes from a CSPRNG. A token derived from a
 *     timestamp, a counter or a UUIDv4's non-random bits would be walkable, and
 *     walking it is account access.
 *  2. **Only its HASH is ever stored.** A database dump — a backup, a read
 *     replica, a support export — must contain nothing replayable. Verified by
 *     round-tripping the hash rather than by trusting the call.
 *  3. **A tampered token does not resolve.** Changing one character changes the
 *     whole digest, which is what makes the lookup an equality match on an index
 *     rather than a comparison that could leak.
 *
 * Config is mocked because `inviteTokenTtlDays` resolves it through a lazy
 * `import('../config/index.js')` — the same pattern, for the same reason, as the
 * mailer next door: a static import would drag `process.exit(1)`-on-bad-config
 * into `user.routes.ts`'s graph.
 */

const mocks = vi.hoisted(() => ({
  config: { invites: { tokenTtlDays: 7 } } as { invites: { tokenTtlDays: number } },
}));

vi.mock('../../../src/config/index.js', () => ({ config: mocks.config }));

import {
  hashInviteToken,
  isInviteExpired,
  mintInviteToken,
} from '../../../src/notifications/invite-token.js';

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  mocks.config.invites = { tokenTtlDays: 7 };
});

describe('mintInviteToken', () => {
  it('round-trips: the stored hash is sha256 of the token that was minted', async () => {
    // The whole storage contract in one assertion. If these ever disagree, every
    // link ever sent stops resolving and nothing else in the system notices —
    // the claim simply answers `not_found` for a token that is genuinely valid.
    const { token, tokenHash } = await mintInviteToken();

    expect(tokenHash).toBe(hashInviteToken(token));
    expect(tokenHash).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
  });

  it('never returns the token inside the hash, or vice versa', async () => {
    // A hash that contained the token would defeat the entire point of storing
    // the hash: the dump would be replayable after all.
    const { token, tokenHash } = await mintInviteToken();

    expect(tokenHash).not.toContain(token);
    expect(token).not.toContain(tokenHash);
    // Hex sha256 is exactly 64 characters. Pinned so a future switch to a
    // truncated or differently-encoded digest is a deliberate change.
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mints 32 bytes of entropy, base64url-encoded', async () => {
    /**
     * 43 characters is the unpadded base64 length of 32 bytes, and the alphabet
     * is checked because the ENCODING is load-bearing, not cosmetic: the token
     * travels in a URL path and in an email body that clients will linkify, so a
     * `+`, `/` or `=` is a value that needs percent-encoding, gets broken by a
     * client that stops the link early, or does not survive a copy-paste out of
     * the plain-text part.
     */
    const { token } = await mintInviteToken();

    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('mints a different token every time', async () => {
    // A CSPRNG, not a counter and not a derivation from anything about the
    // invite. 200 samples cannot prove randomness; a collision here would prove
    // its absence, which is the failure worth catching.
    const tokens = new Set<string>();
    for (let i = 0; i < 200; i += 1) tokens.add((await mintInviteToken()).token);

    expect(tokens.size).toBe(200);
  });

  it('expires at the configured TTL, in days from now', async () => {
    mocks.config.invites = { tokenTtlDays: 3 };

    const before = Date.now();
    const { expiresAt } = await mintInviteToken();

    // A window rather than an equality: `Date.now()` moves between the two reads.
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3 * DAY_MS);
    expect(expiresAt.getTime()).toBeLessThan(before + 3 * DAY_MS + 5_000);
  });

  it('takes an explicit ttl over the configured one, without reading config', async () => {
    /**
     * The short-circuit that lets the mint rule be tested with no config module
     * at all — the same property `inviteSignInUrl`'s `baseUrl` parameter
     * provides. Asserted by removing config entirely: with an explicit TTL the
     * answer must still be produced.
     */
    delete (mocks.config as Partial<typeof mocks.config>).invites;

    const before = Date.now();
    const { expiresAt } = await mintInviteToken(1);

    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + DAY_MS);
    expect(expiresAt.getTime()).toBeLessThan(before + DAY_MS + 5_000);
  });

  it('exports no local default TTL to drift from the schema', async () => {
    /**
     * There used to be a `DEFAULT_INVITE_TTL_DAYS = 7` here, justified as the
     * answer this module needs "even when config cannot be read at all". Nothing
     * referenced it and `inviteTokenTtlDays()` has never had such a fallback — it
     * awaits config and lets a failure propagate, which is right, because
     * `loadConfig()` already `process.exit(1)`s on config that does not parse. A
     * local `?? 7` would only ever fire on a broken deployment, minting
     * credentials against a TTL nobody chose.
     *
     * `invitesSchema.tokenTtlDays`'s `.default(7)` is now the single copy, so
     * there is no mirror left to drift. Asserted as the absence of the export,
     * because re-adding one is how the drift comes back.
     */
    const module = await import('../../../src/notifications/invite-token.js');
    expect(Object.keys(module)).not.toContain('DEFAULT_INVITE_TTL_DAYS');
  });
});

describe('hashInviteToken', () => {
  it('does not resolve a TAMPERED token to the original hash', async () => {
    /**
     * The property the whole lookup rests on. `findByTokenHash` is an equality
     * match on a unique index over the hash — so a token with one character
     * changed produces an entirely different digest and simply misses, rather
     * than partially matching anything.
     *
     * This is also why no constant-time comparison is needed and why the module
     * says so: there is no known target being compared against byte by byte. The
     * one thing that would create that oracle is fetching candidate rows and
     * comparing them in JavaScript, which is exactly what this lookup shape
     * avoids.
     */
    const { token, tokenHash } = await mintInviteToken();

    for (const tampered of [
      `${token}x`,
      token.slice(0, -1),
      `x${token.slice(1)}`,
      token.toUpperCase(),
      token.replace('-', '_'),
    ]) {
      if (tampered === token) continue;
      expect(hashInviteToken(tampered), tampered).not.toBe(tokenHash);
    }
  });

  it('is deterministic for the same input', () => {
    // Otherwise a token would stop resolving between the mint and the claim.
    expect(hashInviteToken('abc')).toBe(hashInviteToken('abc'));
  });

  it('distinguishes the empty string from anything else', () => {
    // A caller that passed `''` — a missing path parameter, say — must miss the
    // index rather than collide with a row.
    expect(hashInviteToken('')).not.toBe(hashInviteToken('a'));
  });
});

describe('isInviteExpired', () => {
  it('is false while the expiry is in the future', () => {
    expect(isInviteExpired(new Date(Date.now() + 1000))).toBe(false);
  });

  it('is true once the expiry has passed', () => {
    expect(isInviteExpired(new Date(Date.now() - 1000))).toBe(true);
  });

  it('treats the exact expiry instant as expired', () => {
    /**
     * `<=`, not `<`. The boundary has to fall one way and "expired at the stated
     * time" is what the email's small print says — a link that still worked at
     * the instant it claims to stop is a smaller surprise to nobody and a larger
     * one to whoever is reasoning about the window.
     */
    const now = new Date('2026-01-08T00:00:00Z');
    expect(isInviteExpired(new Date('2026-01-08T00:00:00Z'), now)).toBe(true);
  });

  it('takes an explicit clock, so the two callers cannot disagree', () => {
    /**
     * `GET /invites/:token` reporting a status and the claim refusing one both
     * go through this function. A page that says "expired" while the claim still
     * accepts it — or the reverse — is worse than either answer alone.
     */
    const expiresAt = new Date('2026-01-08T00:00:00Z');
    expect(isInviteExpired(expiresAt, new Date('2026-01-07T23:59:59Z'))).toBe(false);
    expect(isInviteExpired(expiresAt, new Date('2026-01-08T00:00:01Z'))).toBe(true);
  });
});
