import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The pre-dial gates' ONE option (`PreDialGateOptions.callingHoursOverride`, contact
 * assignment CA7/CA8): the agent's own dial of one of their contacts may pass a CLOSED calling
 * window only with an unspent calling-hours override on the contact AND a valid note. Nothing
 * else moves: phone validity, an unresolvable window and DNC decide exactly as without it, and
 * DNC has no override.
 *
 * Mutation-checked: making the option skip the DNC check reds "DNC still suppresses"; dropping
 * either condition (the contact's override, the note) reds the matching refusal.
 */

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { evaluatePreDialGates } from '../../../src/agency/pre-dial-gates.js';
import type { DncCheck, DncCheckScope } from '../../../src/agency/dnc-registry.js';

const CAMPAIGN = {
  id: 'camp-1',
  tenant_id: 'tenant-1',
  account_id: 'account-1',
  calling_window_start: '09:00:00',
  calling_window_end: '20:00:00',
  calling_days: [1, 2, 3, 4, 5],
  default_timezone: 'Asia/Kolkata',
};
const GRANTED = { id: 'contact-1', phone_e164: '+14155550100', timezone: null as string | null, override_calling_hours: true };
const NOT_GRANTED = { ...GRANTED, override_calling_hours: false };

/** Tue 2026-08-11, 10:30 IST: open. */
const IN_HOURS = new Date('2026-08-11T05:00:00Z');
/** Tue 2026-08-11, 20:30 IST: just closed; opens Wed 09:00 IST. */
const AFTER_HOURS = new Date('2026-08-11T15:00:00Z');
const NOTE = 'Customer asked to be called after 9pm.';

const check = vi.fn<(t: string, p: string, scope: DncCheckScope) => Promise<DncCheck>>();
const deps = { dnc: { check } as never };

beforeEach(() => {
  vi.clearAllMocks();
  check.mockResolvedValue('clear');
});

describe('PreDialGateOptions.callingHoursOverride', () => {
  it('a closed window passes with the override AND a valid note, and says so', async () => {
    const d = await evaluatePreDialGates(
      { campaign: CAMPAIGN, contact: GRANTED, now: AFTER_HOURS }, deps, { callingHoursOverride: { note: NOTE } });
    expect(d.action).toBe('dial');
    if (d.action !== 'dial') throw new Error('unreachable');
    expect(d.callingHoursOverridden).toBe(true);
    expect(d.clearance.contactId).toBe('contact-1');
    // DNC was still asked, after the window.
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('without the contact\'s override, the note alone does not open the window', async () => {
    const d = await evaluatePreDialGates(
      { campaign: CAMPAIGN, contact: NOT_GRANTED, now: AFTER_HOURS }, deps, { callingHoursOverride: { note: NOTE } });
    expect(d).toMatchObject({ action: 'defer', gate: 'calling_hours', deferUntil: new Date('2026-08-12T03:30:00Z') });
  });

  it.each([
    ['no note', null],
    ['a short note', 'too short'],
    ['a blank note padded to length', '            '],
    ['nine emoji (18 UTF-16 units, 9 characters)', '😀'.repeat(9)],
    ['an overlong note', 'x'.repeat(501)],
  ])('the override without a valid note (%s) does not open the window', async (_label, note) => {
    const d = await evaluatePreDialGates(
      { campaign: CAMPAIGN, contact: GRANTED, now: AFTER_HOURS }, deps, { callingHoursOverride: { note } });
    expect(d.action).toBe('defer');
  });

  it('without the option, a granted contact is deferred exactly as before', async () => {
    const d = await evaluatePreDialGates({ campaign: CAMPAIGN, contact: GRANTED, now: AFTER_HOURS }, deps);
    expect(d).toMatchObject({ action: 'defer', gate: 'calling_hours' });
  });

  it('an open window is not "overridden": nothing to spend', async () => {
    const d = await evaluatePreDialGates(
      { campaign: CAMPAIGN, contact: GRANTED, now: IN_HOURS }, deps, { callingHoursOverride: { note: NOTE } });
    expect(d.action).toBe('dial');
    if (d.action !== 'dial') throw new Error('unreachable');
    expect(d.callingHoursOverridden).toBeUndefined();
  });

  it('DNC still suppresses a contact holding the override, with the note, outside the window', async () => {
    check.mockResolvedValue('suppressed');
    const d = await evaluatePreDialGates(
      { campaign: CAMPAIGN, contact: GRANTED, now: AFTER_HOURS }, deps, { callingHoursOverride: { note: NOTE } });
    expect(d).toEqual({ action: 'suppress', gate: 'dnc', suppressedReason: 'dnc' });
  });

  it('an unanswerable DNC registry still halts (fails closed) under the override', async () => {
    check.mockResolvedValue('unavailable');
    const d = await evaluatePreDialGates(
      { campaign: CAMPAIGN, contact: GRANTED, now: AFTER_HOURS }, deps, { callingHoursOverride: { note: NOTE } });
    expect(d).toEqual({ action: 'halt', gate: 'dnc_unavailable' });
  });

  it('an invalid number is still suppressed, before the window is read', async () => {
    const d = await evaluatePreDialGates(
      { campaign: CAMPAIGN, contact: { ...GRANTED, phone_e164: 'not-a-number' }, now: AFTER_HOURS },
      deps, { callingHoursOverride: { note: NOTE } });
    expect(d).toMatchObject({ action: 'suppress', gate: 'phone_invalid' });
    expect(check).not.toHaveBeenCalled();
  });

  it('an unresolvable window is not overridable (there is no window to be outside of)', async () => {
    const d = await evaluatePreDialGates(
      { campaign: { ...CAMPAIGN, default_timezone: 'Not/AZone' }, contact: GRANTED, now: AFTER_HOURS },
      deps, { callingHoursOverride: { note: NOTE } });
    expect(d).toMatchObject({ action: 'defer', gate: 'calling_hours_unresolvable' });
  });
});
