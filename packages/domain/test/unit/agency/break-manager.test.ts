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
  DEFAULT_BREAK_REASONS,
  resolveBreakReasons,
  validateBreakReason,
  breakMustWait,
  BreakRegistry,
} from '../../../src/break-manager.js';

describe('resolveBreakReasons', () => {
  it('serves the built-ins when a campaign configures none', () => {
    // `'[]'` means "the operator has no opinion", NOT "breaks are disabled". Every
    // campaign created before migration 078 has an empty column, and a break menu
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

  it('carries no jurisdiction-specific or payroll assumptions in the defaults (D8)', () => {
    // The mechanism ships generic and operator-configured with NEUTRAL defaults.
    // `is_paid` is a payroll question no default can answer, so it is omitted
    // rather than guessed.
    for (const r of DEFAULT_BREAK_REASONS) expect(r.is_paid).toBeUndefined();
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
