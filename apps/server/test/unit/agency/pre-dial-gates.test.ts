// PORT NOTE (magick-agency, Phase 6): ported from core
// test/unit/agency/pre-dial-gates.test.ts@4850d1d9 (20 cases). Deleted: none.
// Modified (decision B8 — the DNC collapse; `pre-dial-gates.ts` now passes the scope
// the DB-backed registry requires):
//  - `CAMPAIGN` fixture gains `account_id` (the gate input's Pick now names it);
//  - the `check` mock's type takes the third `scope` argument;
//  - "asks the DNC set for this tenant and this number" asserts the call WITH
//    `{ accountId, campaignId }`. The assertion is still exact (`toHaveBeenCalledWith`),
//    so a two-argument call — the old, now non-compiling form that would only check
//    tenant-wide entries — is red.
// The logger mock specifier follows the path rule.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// AD-P3-C-05 + AD-P3-C-06 — the pre-dial gates as a decision, before any wiring.
//
// This file tests the DECISION only. Whether the tick honours it — whether a
// `suppress` really writes `suppressed_reason='dnc'`, whether a `halt` really
// stops the contacts claimed alongside it — is §16.6 question 2 and lives in
// `pacing-engine-gates.test.ts`. A green decision table proves nothing about
// where it is consumed, so do not read this file as coverage of the dial path.
//
// Exact instants throughout, never ranges: every `defer` value is clock-derived
// and an approximate assertion on one is how a doubled fake clock hid.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  evaluatePreDialGates,
  rejectClearance,
  CLEARANCE_MAX_AGE_MS,
  UNRESOLVABLE_WINDOW_PARK_MS,
  type PreDialClearance,
} from '../../../src/agency/pre-dial-gates.js';
import type { DncCheck, DncCheckScope } from '../../../src/agency/dnc-registry.js';

const CAMPAIGN = {
  id: 'camp-1',
  tenant_id: 'tenant-1',
  account_id: 'account-1', // PORT NOTE: B8 — the DNC scope reads it.
  calling_window_start: '09:00:00',
  calling_window_end: '20:00:00',
  calling_days: [1, 2, 3, 4, 5],
  default_timezone: 'Asia/Kolkata',
};

const CONTACT = { id: 'contact-1', phone_e164: '+14155550100', timezone: null as string | null };

/** Tue 2026-08-11, 10:30 IST — squarely inside the window. */
const IN_HOURS = new Date('2026-08-11T05:00:00Z');
/** Tue 2026-08-11, 20:30 IST — just closed. */
const AFTER_HOURS = new Date('2026-08-11T15:00:00Z');

// PORT NOTE: B8 — the registry's `check` takes a required scope.
const check = vi.fn<(t: string, p: string, scope: DncCheckScope) => Promise<DncCheck>>();
const deps = { dnc: { check } as never };

beforeEach(() => {
  vi.clearAllMocks();
  check.mockResolvedValue('clear');
});

describe('the clear path', () => {
  it('dials and mints a clearance bound to this contact and this instant', async () => {
    const decision = await evaluatePreDialGates({ campaign: CAMPAIGN, contact: CONTACT, now: IN_HOURS }, deps);

    expect(decision.action).toBe('dial');
    if (decision.action !== 'dial') throw new Error('unreachable');
    // Bound to the contact, so it cannot be moved to one nobody checked, and
    // stamped with the instant, so it cannot outlive the reservation.
    expect(decision.clearance.contactId).toBe('contact-1');
    expect(decision.clearance.checkedAt).toEqual(IN_HOURS);
    expect(rejectClearance(decision.clearance, 'contact-1', IN_HOURS)).toBeNull();
  });

  it('asks the DNC set for this tenant and this number', async () => {
    await evaluatePreDialGates({ campaign: CAMPAIGN, contact: CONTACT, now: IN_HOURS }, deps);
    // The tenant comes from the campaign, never from the contact row: a contact
    // whose tenant_id disagreed with its campaign's would otherwise be checked
    // against the wrong tenant's DNC list, which is a check that always passes.
    // PORT NOTE (B8): and with this account and this campaign, so an account- or
    // campaign-scoped `dnc_entries` row stops the dial too (core's set held only
    // tenant-wide entries and was called with two arguments).
    expect(check).toHaveBeenCalledWith('tenant-1', '+14155550100', {
      accountId: 'account-1', campaignId: 'camp-1',
    });
  });
});

describe('DNC', () => {
  it('suppresses a member with reason dnc, and does not dial', async () => {
    check.mockResolvedValue('suppressed');
    expect(await evaluatePreDialGates({ campaign: CAMPAIGN, contact: CONTACT, now: IN_HOURS }, deps))
      .toEqual({ action: 'suppress', gate: 'dnc', suppressedReason: 'dnc' });
  });

  it('HALTS when the registry cannot answer', async () => {
    // The whole point of the ticket. `unavailable` covers no Redis, an unsynced
    // tenant, and a read error — all campaign-wide, so the campaign stops rather
    // than placing one unchecked call.
    check.mockResolvedValue('unavailable');
    expect(await evaluatePreDialGates({ campaign: CAMPAIGN, contact: CONTACT, now: IN_HOURS }, deps))
      .toEqual({ action: 'halt', gate: 'dnc_unavailable' });
  });

  it('does not halt for a per-contact verification failure', async () => {
    // `unverifiable` is about one row; `unavailable` is about the registry.
    // Collapsing them means one junk CSV row stops the campaign, and the outage
    // reads as a Redis problem.
    check.mockResolvedValue('unverifiable');
    const decision = await evaluatePreDialGates({ campaign: CAMPAIGN, contact: CONTACT, now: IN_HOURS }, deps);
    expect(decision.action).toBe('suppress');
    expect(decision).toMatchObject({ suppressedReason: 'invalid' });
  });
});

describe('phone validity is checked first, and is terminal', () => {
  it('suppresses a malformed number without asking Redis or the clock', async () => {
    const decision = await evaluatePreDialGates(
      { campaign: CAMPAIGN, contact: { ...CONTACT, phone_e164: 'not-a-number' }, now: IN_HOURS }, deps,
    );
    expect(decision).toEqual({ action: 'suppress', gate: 'phone_invalid', suppressedReason: 'invalid' });
    expect(check).not.toHaveBeenCalled();
  });

  it('suppresses a malformed number even out of hours, rather than deferring it forever', async () => {
    // Order matters here and only here: with calling hours first, a row that can
    // never be dialed would be deferred to the next window every night for the
    // life of the campaign instead of leaving the roster once.
    const decision = await evaluatePreDialGates(
      { campaign: CAMPAIGN, contact: { ...CONTACT, phone_e164: '' }, now: AFTER_HOURS }, deps,
    );
    expect(decision.action).toBe('suppress');
  });

  it('agrees with the registry about what a number is', async () => {
    // Gate 1 and the registry both use `normalizeE164`, which is what makes the
    // `unverifiable` arm unreachable. Pinned, because the comment saying so is not
    // evidence (§16.6 rule 3) and a divergence would fall through to `dial`.
    const { normalizeE164 } = await import('../../../src/agency/dnc-registry.js');
    for (const phone of ['+14155550100', '14155550100', 'nope', '', '+0123']) {
      const decision = await evaluatePreDialGates(
        { campaign: CAMPAIGN, contact: { ...CONTACT, phone_e164: phone }, now: IN_HOURS }, deps,
      );
      const gateRefused = decision.action === 'suppress' && decision.gate === 'phone_invalid';
      expect(gateRefused).toBe(normalizeE164(phone) === null);
    }
  });
});

describe('calling hours', () => {
  it('defers to the exact next window open and never to now', async () => {
    const decision = await evaluatePreDialGates({ campaign: CAMPAIGN, contact: CONTACT, now: AFTER_HOURS }, deps);

    expect(decision.action).toBe('defer');
    if (decision.action !== 'defer') throw new Error('unreachable');
    expect(decision.gate).toBe('calling_hours');
    // Wed 09:00 IST. Exact, because "some time later" is satisfied by `now()+1ms`,
    // which re-claims the contact on the next tick — the 4-claims-per-second spin
    // §4.2 exists to prevent.
    expect(decision.deferUntil.toISOString()).toBe('2026-08-12T03:30:00.000Z');
    expect(decision.deferUntil.getTime()).toBeGreaterThan(AFTER_HOURS.getTime());
  });

  it('does not spend a DNC round trip on a contact it is not going to dial', async () => {
    // Also the reason for this ordering: with DNC first, a campaign that is out of
    // hours would HALT on a Redis outage instead of deferring cleanly, and the
    // difference is "paused because it is 3am" versus "paused, cause unknown".
    check.mockResolvedValue('unavailable');
    const decision = await evaluatePreDialGates({ campaign: CAMPAIGN, contact: CONTACT, now: AFTER_HOURS }, deps);
    expect(decision.action).toBe('defer');
    expect(check).not.toHaveBeenCalled();
  });

  it('defers a New York contact to 09:00 New York, not 09:00 in the campaign zone', async () => {
    // D4 end to end through the gate: 10:30 IST is 01:00 in New York.
    const decision = await evaluatePreDialGates(
      { campaign: CAMPAIGN, contact: { ...CONTACT, timezone: 'America/New_York' }, now: IN_HOURS }, deps,
    );
    expect(decision).toMatchObject({ action: 'defer', gate: 'calling_hours' });
    if (decision.action !== 'defer') throw new Error('unreachable');
    expect(decision.deferUntil.toISOString()).toBe('2026-08-11T13:00:00.000Z');
  });

  it('parks for an hour when the window cannot be computed, rather than halting', async () => {
    // An unusable campaign default means the campaign's own config is broken. A
    // per-contact gate cannot pause a campaign, so it parks — bounded, so the
    // roster returns on its own once someone fixes the config, and long enough
    // not to re-defer the same rows four times a second.
    const decision = await evaluatePreDialGates(
      { campaign: { ...CAMPAIGN, default_timezone: 'Not/AZone' }, contact: CONTACT, now: IN_HOURS }, deps,
    );
    expect(decision).toEqual({
      action: 'defer',
      gate: 'calling_hours_unresolvable',
      deferUntil: new Date(IN_HOURS.getTime() + UNRESOLVABLE_WINDOW_PARK_MS),
    });
  });

  it('parks rather than returning now when no window will ever open', async () => {
    // Empty `calling_days`: closed, and `nextWindowOpen` has no answer. Returning
    // `now()` here is the spin; returning null would crash the caller.
    const decision = await evaluatePreDialGates(
      { campaign: { ...CAMPAIGN, calling_days: [] }, contact: CONTACT, now: IN_HOURS }, deps,
    );
    expect(decision.action).toBe('defer');
    if (decision.action !== 'defer') throw new Error('unreachable');
    expect(decision.deferUntil).toEqual(new Date(IN_HOURS.getTime() + UNRESOLVABLE_WINDOW_PARK_MS));
    expect(decision.deferUntil.getTime()).toBeGreaterThan(IN_HOURS.getTime());
  });

  it('parks a same-start-as-end window instead of treating it as always open', async () => {
    const decision = await evaluatePreDialGates(
      { campaign: { ...CAMPAIGN, calling_window_end: '09:00:00' }, contact: CONTACT, now: IN_HOURS }, deps,
    );
    expect(decision.action).toBe('defer');
    expect(check).not.toHaveBeenCalled();
  });
});

describe('every defer is strictly in the future', () => {
  it('holds across every deferring input', async () => {
    // The single invariant behind §4.2's unclaim rule, asserted over the whole
    // set rather than case by case: a contact returned at `now()` is re-claimed
    // immediately, and the campaign burns agent reservations all night.
    const inputs = [
      { campaign: CAMPAIGN, contact: CONTACT, now: AFTER_HOURS },
      { campaign: CAMPAIGN, contact: { ...CONTACT, timezone: 'America/New_York' }, now: IN_HOURS },
      { campaign: { ...CAMPAIGN, default_timezone: 'Not/AZone' }, contact: CONTACT, now: IN_HOURS },
      { campaign: { ...CAMPAIGN, calling_days: [] }, contact: CONTACT, now: IN_HOURS },
      { campaign: { ...CAMPAIGN, calling_days: [0] }, contact: CONTACT, now: IN_HOURS },
      { campaign: { ...CAMPAIGN, calling_window_end: '09:00:00' }, contact: CONTACT, now: IN_HOURS },
    ];
    for (const input of inputs) {
      const decision = await evaluatePreDialGates(input, deps);
      expect(decision.action).toBe('defer');
      if (decision.action !== 'defer') throw new Error('unreachable');
      expect(decision.deferUntil.getTime()).toBeGreaterThan(input.now.getTime());
    }
  });
});

describe('rejectClearance — the dial choke point', () => {
  const clearance = (contactId: string, checkedAt: Date): PreDialClearance =>
    ({ contactId, checkedAt } as unknown as PreDialClearance);

  it('accepts a fresh clearance for the right contact', () => {
    expect(rejectClearance(clearance('c1', IN_HOURS), 'c1', IN_HOURS)).toBeNull();
    expect(rejectClearance(clearance('c1', IN_HOURS), 'c1',
      new Date(IN_HOURS.getTime() + CLEARANCE_MAX_AGE_MS))).toBeNull();
  });

  it('refuses a missing one', () => {
    expect(rejectClearance(undefined, 'c1', IN_HOURS)).toBe('missing');
    // A cast can defeat the brand; a shape check cannot be cast away.
    expect(rejectClearance({} as PreDialClearance, 'c1', IN_HOURS)).toBe('missing');
  });

  it('refuses one issued for a different contact', () => {
    // The realistic failure: `dialUpTo` pairs `reserved[index]` with
    // `contacts[index]`, and an indexing mistake hands a valid clearance to a
    // contact nobody checked — a dial to an unchecked number with every type
    // satisfied.
    expect(rejectClearance(clearance('c2', IN_HOURS), 'c1', IN_HOURS)).toBe('wrong_contact');
  });

  it('refuses one older than the pre-dial reservation lease', () => {
    // One millisecond past, so the boundary is the assertion rather than a
    // comfortable margin either side of it.
    expect(rejectClearance(clearance('c1', IN_HOURS), 'c1',
      new Date(IN_HOURS.getTime() + CLEARANCE_MAX_AGE_MS + 1))).toBe('stale');
  });

  it('refuses one from the future', () => {
    // A negative age is a clock stepping backwards or a fabricated token. Neither
    // is evidence the gates ran, so it is not treated as fresh.
    expect(rejectClearance(clearance('c1', new Date(IN_HOURS.getTime() + 1)), 'c1', IN_HOURS))
      .toBe('stale');
  });
});
