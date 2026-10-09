import { describe, it, expect } from 'vitest';

/**
 * `deliver.ts` is trimmed to `buildDedupeKey`, so only its cases live here.
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
