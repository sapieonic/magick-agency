import { describe, it, expect } from 'vitest';

/**
 * PORT NOTE (magick-agency): `deliver.ts` is trimmed to `buildDedupeKey` (see its
 * header), so of master's suite only the six `buildDedupeKey` cases are kept,
 * verbatim. Deleted, because the code they drive was reached only by the credits
 * digest runner (plan §3.3/§3.5): `dispatchNotification` (17), `scopeToken` (1),
 * 'the claim, per SendEmailOutcome' (5 table rows + 4), 'partial outcomes across
 * one fan-out' (4), 'writes that fail after the mail has gone' (4), 'scopeToken
 * edges' (4), 'buildDedupeKey edges' › 'composes with scopeToken to separate the
 * two scopes of one tenant' (1), 'the transport guard, once more' (4) — 44 of
 * master's 50. With them went master's mocks (config, delivery repository,
 * mailjet client, logger) and fixtures (`input`, `claimAll`, `RENDERED`, `ACCOUNT`).
 */

import { buildDedupeKey } from '../../../../src/notifications/engine/deliver.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('buildDedupeKey', () => {
  it('joins its parts stably', () => {
    expect(buildDedupeKey('weekly', '2026-09-07', 'tenant:x')).toBe('weekly:2026-09-07:tenant:x');
    expect(buildDedupeKey('job', 42)).toBe('job:42');
  });

  it('gives different keys to the two cadences of one period', () => {
    // A tenant can have one person subscribed daily and another weekly. The
    // weekly run's claim must not suppress the daily one.
    expect(buildDedupeKey('daily', '2026-09-07', 'tenant:x'))
      .not.toBe(buildDedupeKey('weekly', '2026-09-07', 'tenant:x'));
  });
});

describe('buildDedupeKey edges', () => {
  it('keeps an empty part as an empty SEGMENT rather than dropping it', () => {
    // Dropping it would make `('daily', '', 'tenant:x')` and
    // `('daily', 'tenant:x')` the same key — two different notifications
    // claiming one row, one of which is then never sent.
    expect(buildDedupeKey('daily', '', 'tenant:x')).toBe('daily::tenant:x');
    expect(buildDedupeKey('daily', '', 'tenant:x')).not.toBe(buildDedupeKey('daily', 'tenant:x'));
  });

  it('stringifies a numeric part', () => {
    expect(buildDedupeKey('job', 0)).toBe('job:0');
    expect(buildDedupeKey('job', 42)).toBe('job:42');
    expect(buildDedupeKey(0, 0)).toBe('0:0');
  });

  it('gives a single part back unchanged, with no separator', () => {
    expect(buildDedupeKey('job')).toBe('job');
    expect(buildDedupeKey('')).toBe('');
  });

  it('distinguishes two periods of one cadence and scope', () => {
    // The property the whole ledger rests on: every tick inside one period
    // resolves to the same key, and two periods never do.
    expect(buildDedupeKey('weekly', '2026-09-07', `tenant:${TENANT}`))
      .not.toBe(buildDedupeKey('weekly', '2026-09-14', `tenant:${TENANT}`));
  });

});
