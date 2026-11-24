import { describe, expect, it } from 'vitest';
import {
  ABANDONED_ATTEMPT_PREDICATE_SQL,
  ABANDONMENT_GRACE_STEP_MS,
  ALLOWED_ABANDONMENT_GRACE_MS,
  DEFAULT_ABANDONMENT_GRACE_MS,
  MAX_ABANDONMENT_GRACE_MS,
  MIN_ABANDONMENT_GRACE_MS,
  isAbandonedAttempt,
  isAllowedAbandonmentGraceMs,
} from '../../../src/abandonment-predicate';

/**
 * The abandonment grace per campaign (decisions AG1–AG5): the default, the range a campaign may
 * hold, and both halves of the predicate reading the grace stamped on the attempt rather than a
 * constant. The server's real-Postgres agreement tests run the SQL half
 * (`abandonment-invariants.test.ts`, `chaos/abandonment-predicate-agreement.test.ts`).
 */
describe('the abandonment grace', () => {
  it('defaults to 3 s (AG1) and ranges over whole seconds from 1 to 5 (AG2)', () => {
    expect(DEFAULT_ABANDONMENT_GRACE_MS).toBe(3000);
    expect(MIN_ABANDONMENT_GRACE_MS).toBe(1000);
    expect(MAX_ABANDONMENT_GRACE_MS).toBe(5000);
    expect(ABANDONMENT_GRACE_STEP_MS).toBe(1000);
    expect(ALLOWED_ABANDONMENT_GRACE_MS).toEqual([1000, 2000, 3000, 4000, 5000]);
    expect(ALLOWED_ABANDONMENT_GRACE_MS).toContain(DEFAULT_ABANDONMENT_GRACE_MS);
    expect(Object.isFrozen(ALLOWED_ABANDONMENT_GRACE_MS)).toBe(true);
  });

  it('allows exactly those five values, as numbers', () => {
    for (const ok of [1000, 2000, 3000, 4000, 5000]) expect(isAllowedAbandonmentGraceMs(ok), String(ok)).toBe(true);
    for (const bad of [0, 500, 999, 1001, 1500, 2500, 6000, -1000, 3, '3000', null, undefined, Number.NaN, Infinity]) {
      expect(isAllowedAbandonmentGraceMs(bad), String(bad)).toBe(false);
    }
  });

  it('the SQL reads the attempt\'s own column, never a constant', () => {
    expect(ABANDONED_ATTEMPT_PREDICATE_SQL).toContain("bridged_at - answered_at > bridge_grace_ms * interval '1 millisecond'");
    expect(ABANDONED_ATTEMPT_PREDICATE_SQL).not.toMatch(/\d+ milliseconds/);
    // Not the campaign's column: the predicate is one row of the attempts table, with no join.
    expect(ABANDONED_ATTEMPT_PREDICATE_SQL).not.toContain('abandonment_grace_ms');
  });

  it('the in-process twin judges by the grace in its facts, `>` not `>=`', () => {
    const t0 = new Date('2026-11-24T10:00:00.000Z');
    const at = (ms: number) => new Date(t0.getTime() + ms);
    for (const bridgeGraceMs of ALLOWED_ABANDONMENT_GRACE_MS) {
      expect(isAbandonedAttempt({ answeredAt: t0, bridgedAt: at(bridgeGraceMs), outcome: 'connected', bridgeGraceMs })).toBe(false);
      expect(isAbandonedAttempt({ answeredAt: t0, bridgedAt: at(bridgeGraceMs + 1), outcome: 'connected', bridgeGraceMs })).toBe(true);
    }
    // The same bridge, two campaigns: 4 s is late for the default and in time for 5 s.
    expect(isAbandonedAttempt({ answeredAt: t0, bridgedAt: at(4000), outcome: 'connected', bridgeGraceMs: 3000 })).toBe(true);
    expect(isAbandonedAttempt({ answeredAt: t0, bridgedAt: at(4000), outcome: 'connected', bridgeGraceMs: 5000 })).toBe(false);
    // The other arms do not read the grace.
    expect(isAbandonedAttempt({ answeredAt: null, bridgedAt: null, outcome: 'abandoned', bridgeGraceMs: 1000 })).toBe(false);
    expect(isAbandonedAttempt({ answeredAt: t0, bridgedAt: null, outcome: 'connected', bridgeGraceMs: 5000 })).toBe(true);
  });
});
