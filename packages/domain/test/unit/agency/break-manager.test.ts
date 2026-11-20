// `break-manager.ts` is a leaf (imports only contracts), so it lives in
// `packages/domain/src/break-manager.ts`; the import is the package-relative one.
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Break / not-ready with reason codes.
//
// Acceptance: (a) a break requested mid-call does not interrupt the call and
// applies after wrap-up, (b) an agent in `break` is never reserved, (c) the reason
// is persisted and visible for reporting, (d) an unknown reason is rejected.
//
// (a)'s "applies after wrap-up" half lives in AgencyDialer.releaseAgent and (b) in
// the pacing engine — both asserted in their own suites, against the code that
// actually decides. This file owns the catalog resolution and the queue.
// ---------------------------------------------------------------------------

import {
  breakOverrun,
  DEFAULT_BREAK_REASONS,
  resolveBreakReasons,
  validateBreakReason,
  isReservedBreakReason,
  DEVICE_AWAY_BREAK,
  PHONE_CALL_BREAK,
  AWAY_RING_BREAK,
  breakMustWait,
  BreakRegistry,
  breakLimitMinutes,
} from '../../../src/break-manager.js';

describe('resolveBreakReasons', () => {
  it('serves the built-ins when a campaign configures none', () => {
    // `'[]'` means "the operator has no opinion", NOT "breaks are disabled". A
    // campaign that never configured breaks has an empty column, and a break menu
    // with no entries is a control the agent cannot use.
    expect(resolveBreakReasons([])).toEqual([...DEFAULT_BREAK_REASONS]);
    expect(resolveBreakReasons(null)).toEqual([...DEFAULT_BREAK_REASONS]);
    expect(resolveBreakReasons(undefined)).toEqual([...DEFAULT_BREAK_REASONS]);
  });

  it('prefers the operator catalog when there is one', () => {
    const configured = [{ code: 'chai', label: 'Chai break', is_paid: true }];
    expect(resolveBreakReasons(configured)).toEqual(configured);
  });

  it('degrades to the built-ins on a malformed catalog rather than throwing', () => {
    // The column is CHECKed to be a JSON array but nothing constrains its ELEMENTS,
    // so a hand-written or half-migrated catalog can hold junk. 500ing every break
    // request on such a campaign would strand its agents for the whole shift.
    expect(resolveBreakReasons('nonsense' as never)).toEqual([...DEFAULT_BREAK_REASONS]);
    expect(resolveBreakReasons([null, {}, { label: 'no code' }] as never)).toEqual([...DEFAULT_BREAK_REASONS]);
  });

  it('keeps only the well-formed entries of a partly-bad catalog', () => {
    const mixed = [{ code: 'ok', label: 'Fine' }, { label: 'broken' }] as never;
    expect(resolveBreakReasons(mixed)).toEqual([{ code: 'ok', label: 'Fine' }]);
  });

  it('carries no jurisdiction-specific or payroll assumptions in the defaults', () => {
    // The mechanism ships generic and operator-configured with NEUTRAL defaults.
    // `is_paid` is a payroll question no default can answer, so it is omitted
    // rather than guessed.
    for (const r of DEFAULT_BREAK_REASONS) expect(r.is_paid).toBeUndefined();
  });
});

describe('the soft phone\'s reserved reason', () => {
  // Entered only through the soft-phone switch, which checks the flag and audits it (SP7).
  it('is never in a campaign\'s catalog, whatever the column holds', () => {
    const configured = [{ code: 'lunch', label: 'Lunch' }, { code: 'soft_phone', label: 'Soft phone' }];
    expect(resolveBreakReasons(configured)).toEqual([{ code: 'lunch', label: 'Lunch' }]);
    // A catalog of only it degrades to the built-ins, which never list it either.
    const onlyIt = resolveBreakReasons([{ code: 'soft_phone', label: 'Soft phone' }]);
    expect(onlyIt).toEqual([...DEFAULT_BREAK_REASONS]);
    expect(onlyIt.map((r) => r.code)).not.toContain('soft_phone');
  });

  it('is refused by `validateBreakReason`, so `/break` answers unknown_break_reason', () => {
    const check = validateBreakReason([{ code: 'soft_phone', label: 'Soft phone' }, { code: 'lunch', label: 'Lunch' }], 'soft_phone');
    expect(check).toEqual({ ok: false, allowed: ['lunch'] });
  });
});

describe('the device-away break (the mobile app, reserved)', () => {
  it('is never in a campaign\'s catalog, whatever the column holds, so the menu can never offer it', () => {
    const configured = [{ code: 'device_away', label: 'Away' }, { code: 'lunch', label: 'Lunch' }];
    expect(resolveBreakReasons(configured)).toEqual([{ code: 'lunch', label: 'Lunch' }]);
    expect(resolveBreakReasons([{ code: 'device_away', label: 'Away' }])).toEqual([...DEFAULT_BREAK_REASONS]);
    expect(validateBreakReason(configured, 'device_away')).toEqual({ ok: false, allowed: ['lunch'] });
  });

  it('is carried by the queue as a frozen entry with the contract\'s label', () => {
    expect(DEVICE_AWAY_BREAK).toEqual({ code: 'device_away', label: 'Away (app in background)' });
    expect(Object.isFrozen(DEVICE_AWAY_BREAK)).toBe(true);
  });

  it('IQ51: the phone-call pause is reserved the same way and carried with its own label', () => {
    const configured = [{ code: 'phone_call', label: 'Phone' }, { code: 'lunch', label: 'Lunch' }];
    expect(resolveBreakReasons(configured)).toEqual([{ code: 'lunch', label: 'Lunch' }]);
    expect(validateBreakReason(configured, 'phone_call')).toEqual({ ok: false, allowed: ['lunch'] });
    expect(PHONE_CALL_BREAK).toEqual({ code: 'phone_call', label: 'On a phone call' });
    expect(Object.isFrozen(PHONE_CALL_BREAK)).toBe(true);
  });

  it('IQ58: the away-ring break is reserved the same way and carried with its own label', () => {
    const configured = [{ code: 'away_ring', label: 'Away' }, { code: 'lunch', label: 'Lunch' }];
    expect(resolveBreakReasons(configured)).toEqual([{ code: 'lunch', label: 'Lunch' }]);
    expect(validateBreakReason(configured, 'away_ring')).toEqual({ ok: false, allowed: ['lunch'] });
    expect(AWAY_RING_BREAK).toEqual({ code: 'away_ring', label: 'Away · rings for inbound' });
    expect(Object.isFrozen(AWAY_RING_BREAK)).toBe(true);
  });

  it('isReservedBreakReason names the four reserved codes and nothing else', () => {
    expect(isReservedBreakReason('soft_phone')).toBe(true);
    expect(isReservedBreakReason('device_away')).toBe(true);
    expect(isReservedBreakReason('phone_call')).toBe(true);
    expect(isReservedBreakReason('away_ring')).toBe(true);
    for (const code of ['lunch', 'break', '', null, undefined, 42]) expect(isReservedBreakReason(code)).toBe(false);
  });
});

describe('validateBreakReason', () => {
  it('(d) rejects an unknown code and echoes the valid set', () => {
    const res = validateBreakReason([{ code: 'lunch', label: 'Lunch' }], 'siesta');
    expect(res.ok).toBe(false);
    // Echoing the allowed codes is what lets a console holding a stale catalog
    // recover in one round trip instead of stranding the agent.
    if (!res.ok) expect(res.allowed).toEqual(['lunch']);
  });

  it('validates against the EFFECTIVE list, so built-ins work on an unconfigured campaign', () => {
    // One authority: bootstrap advertises the effective list and this validates
    // against the same one. Two sources would drift, and the failure mode is a
    // console offering a code the server rejects.
    expect(validateBreakReason([], 'lunch').ok).toBe(true);
    expect(validateBreakReason([], 'not_a_default').ok).toBe(false);
  });

  it('rejects a non-string code without throwing', () => {
    for (const bad of [undefined, null, 42, {}, ['lunch']]) {
      expect(validateBreakReason([], bad).ok).toBe(false);
    }
  });

  it('does not accept a code by prefix or case', () => {
    const catalog = [{ code: 'lunch', label: 'Lunch' }];
    expect(validateBreakReason(catalog, 'LUNCH').ok).toBe(false);
    expect(validateBreakReason(catalog, 'lun').ok).toBe(false);
    expect(validateBreakReason(catalog, 'lunchtime').ok).toBe(false);
  });
});

describe('breakMustWait', () => {
  it('defers a break requested while the agent is mid-call or writing up', () => {
    expect(breakMustWait('on_call')).toBe(true);
    // `wrapup` defers for the same reason one step later: the agent still owes a
    // disposition, and letting a break jump that drops the record of the call.
    expect(breakMustWait('wrapup')).toBe(true);
  });

  it('defers a break requested while RESERVED — the case that is easy to miss', () => {
    // An agent reserved for a dial that has already gone to the carrier is about to
    // be bridged to a real person who is about to answer. Applying a break there
    // produces exactly the abandoned call reserve-before-dial exists to prevent:
    // the customer picks up and there is nobody on the line.
    expect(breakMustWait('reserved')).toBe(true);
  });

  it('applies immediately from an idle state', () => {
    expect(breakMustWait('available')).toBe(false);
    expect(breakMustWait('break')).toBe(false);
    expect(breakMustWait('offline')).toBe(false);
  });

  it('applies immediately when the state is unknown', () => {
    // A null state means the lease has lapsed — the agent is gone, so there is no
    // call to protect and nothing to defer for.
    expect(breakMustWait(null)).toBe(false);
    expect(breakMustWait(undefined)).toBe(false);
  });
});

describe('BreakRegistry', () => {
  const lunch = { code: 'lunch', label: 'Lunch' };

  it('takes a queued break exactly once', () => {
    // Consumed rather than peeked: an agent who takes a break and later goes
    // available must not be silently pulled back out of the pool on their next
    // call's release.
    const r = new BreakRegistry();
    r.queue('s1', lunch);
    expect(r.take('s1')).toEqual(lunch);
    expect(r.take('s1')).toBeNull();
    expect(r.size()).toBe(0);
  });

  it('peeks without consuming', () => {
    const r = new BreakRegistry();
    r.queue('s1', lunch);
    expect(r.peek('s1')).toEqual(lunch);
    expect(r.peek('s1')).toEqual(lunch);
    expect(r.take('s1')).toEqual(lunch);
  });

  it('lets a re-queue replace the reason rather than stacking two breaks', () => {
    const r = new BreakRegistry();
    r.queue('s1', lunch);
    r.queue('s1', { code: 'meeting', label: 'Meeting' });
    expect(r.size()).toBe(1);
    expect(r.take('s1')?.code).toBe('meeting');
  });

  it('cancels a queued break and reports whether there was one', () => {
    const r = new BreakRegistry();
    expect(r.cancel('s1')).toBe(false);
    r.queue('s1', lunch);
    expect(r.cancel('s1')).toBe(true);
    expect(r.take('s1')).toBeNull();
  });

  it('keeps sessions independent', () => {
    const r = new BreakRegistry();
    r.queue('s1', lunch);
    r.queue('s2', { code: 'meeting', label: 'Meeting' });
    expect(r.take('s1')?.code).toBe('lunch');
    expect(r.peek('s2')?.code).toBe('meeting');
  });
});

// LF6, LF20: break limits. The write's rule is the contract's `isAgencyBreakLimitMinutes`; the
// catalog read keeps a stored limit only when that rule accepts it.
describe('break limits (LF6, LF20)', () => {
  it('gives the built-ins Tea 15 and Lunch 30, and no other reason a limit', () => {
    expect(DEFAULT_BREAK_REASONS.map((r) => [r.code, r.limit_minutes ?? null])).toEqual([
      ['break', null],
      ['tea', 15],
      ['lunch', 30],
      ['meeting', null],
      ['training', null],
      ['technical_issue', null],
      ['admin', null],
    ]);
    expect(DEFAULT_BREAK_REASONS.find((r) => r.code === 'tea')?.label).toBe('Tea');
  });

  it('serves an unconfigured campaign the built-ins with their limits', () => {
    expect(breakLimitMinutes('tea', [])).toBe(15);
    expect(breakLimitMinutes('lunch', null)).toBe(30);
    expect(breakLimitMinutes('break', [])).toBeNull();
  });

  it('never rewrites a campaign\'s saved list: its Lunch keeps no limit, and Tea is not added', () => {
    const saved = [{ code: 'lunch', label: 'Lunch' }, { code: 'chai', label: 'Chai', limit_minutes: 10 }];
    const resolved = resolveBreakReasons(saved);
    expect(resolved).toEqual(saved);
    expect(resolved[0]).toBe(saved[0]);
    expect(resolved.map((r) => r.code)).not.toContain('tea');
    expect(breakLimitMinutes('lunch', saved)).toBeNull();
    expect(breakLimitMinutes('chai', saved)).toBe(10);
    expect(breakLimitMinutes('tea', saved)).toBeNull();
  });

  it('drops a stored limit the rule refuses, keeping the reason on the menu', () => {
    const stored = [
      { code: 'a', label: 'A', limit_minutes: 0 },
      { code: 'b', label: 'B', limit_minutes: 241 },
      { code: 'c', label: 'C', limit_minutes: 12.5 },
      { code: 'd', label: 'D', limit_minutes: '15' },
      { code: 'e', label: 'E', limit_minutes: null },
      { code: 'f', label: 'F', limit_minutes: 1, is_paid: true },
      { code: 'g', label: 'G', limit_minutes: 240 },
    ] as never;
    expect(resolveBreakReasons(stored)).toEqual([
      { code: 'a', label: 'A' },
      { code: 'b', label: 'B' },
      { code: 'c', label: 'C' },
      { code: 'd', label: 'D' },
      { code: 'e', label: 'E' },
      { code: 'f', label: 'F', limit_minutes: 1, is_paid: true },
      { code: 'g', label: 'G', limit_minutes: 240 },
    ]);
    expect(breakLimitMinutes('b', stored)).toBeNull();
    expect(breakLimitMinutes('g', stored)).toBe(240);
  });

  it('gives a reserved code, an unknown code and no code no limit', () => {
    // A reserved code cannot be in a catalog (dropped above), so even a hand-written row naming
    // one with a limit gives it none.
    const stored = [{ code: 'device_away', label: 'Away', limit_minutes: 5 }, { code: 'lunch', label: 'Lunch', limit_minutes: 20 }];
    expect(breakLimitMinutes('device_away', stored)).toBeNull();
    expect(breakLimitMinutes('soft_phone', [])).toBeNull();
    expect(breakLimitMinutes('phone_call', [])).toBeNull();
    expect(breakLimitMinutes('away_ring', [])).toBeNull();
    expect(breakLimitMinutes('nap', stored)).toBeNull();
    expect(breakLimitMinutes(null, stored)).toBeNull();
    expect(breakLimitMinutes('lunch', stored)).toBe(20);
  });
});

describe('breakOverrun (agent station BE-12, AS12)', () => {
  const start = new Date('2026-11-20T10:00:00.000Z');
  const at = (ms: number) => new Date(start.getTime() + ms);
  const tea = [{ code: 'tea', label: 'Tea', limit_minutes: 15 }];

  it('past the limit: the limit and the whole seconds past it (floored)', () => {
    expect(breakOverrun({ code: 'tea', configured: tea, startedAt: start, endedAt: at(17 * 60_000 + 30_900) }))
      .toEqual({ limit_minutes: 15, overrun_seconds: 150 });
    // The built-ins when the campaign lists none: Lunch 30.
    expect(breakOverrun({ code: 'lunch', configured: [], startedAt: start, endedAt: at(31 * 60_000) }))
      .toEqual({ limit_minutes: 30, overrun_seconds: 60 });
  });

  it('not over: at the limit, under it, or less than a whole second past it', () => {
    // FALSIFIED: with the limit left out of the sum, or `> 0` turned into `>= 0`, these red.
    for (const ms of [15 * 60_000, 14 * 60_000, 15 * 60_000 + 999]) {
      expect(breakOverrun({ code: 'tea', configured: tea, startedAt: start, endedAt: at(ms) }), String(ms)).toBeNull();
    }
    expect(breakOverrun({ code: 'tea', configured: tea, startedAt: start, endedAt: at(15 * 60_000 + 1_000) }))
      .toEqual({ limit_minutes: 15, overrun_seconds: 1 });
  });

  it('never for a reason with no limit, an unknown code, a reserved break or no code', () => {
    const hours = at(5 * 3_600_000);
    for (const code of ['break', 'nap', 'soft_phone', 'device_away', 'phone_call', 'away_ring', null]) {
      expect(breakOverrun({ code, configured: [], startedAt: start, endedAt: hours }), String(code)).toBeNull();
    }
  });
});

describe('break reason icons (agent station BE-13)', () => {
  it('the menu keeps an icon the contract lists and drops one it does not (no icon at all)', () => {
    // FALSIFIED: with `withKnownIcon` out of `resolveBreakReasons`, the unknown icon is served.
    expect(resolveBreakReasons([
      { code: 'tea', label: 'Tea', icon: 'tea' },
      { code: 'namaz', label: 'Prayer', icon: 'mosque' as never },
      { code: 'walk', label: 'Walk' },
    ])).toEqual([
      { code: 'tea', label: 'Tea', icon: 'tea' },
      { code: 'namaz', label: 'Prayer' },
      { code: 'walk', label: 'Walk' },
    ]);
  });
});
