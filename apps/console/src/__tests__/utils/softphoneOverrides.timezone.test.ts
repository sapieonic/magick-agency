import { describe, it, expect } from 'vitest';
import { describeDncRefusal, describeHoursRefusal, formatNextOpening } from '../../utils/softphone/overrides';
import type { SoftphoneDncListedRefusal, SoftphoneOutsideHoursRefusal } from '../../api/softphone';

/**
 * Timezone-sensitive: the window's next opening is read in the WINDOW's zone —
 * the customer's, or the campaign's default — whatever zone the agent's browser
 * is in. The reader is moved to Los Angeles (this file's `forks` project is where
 * a `TZ` assignment actually moves the clock), so a formatter that leaned on the
 * reader's clock would print 20:30 the day before.
 */
function inZone<T>(zone: string, run: () => T): T {
  const previous = process.env['TZ'];
  process.env['TZ'] = zone;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env['TZ'];
    else process.env['TZ'] = previous;
  }
}

const HOURS: SoftphoneOutsideHoursRefusal = {
  code: 'outside_calling_hours',
  status: 409,
  message: 'Outside calling hours',
  window: { start: '09:00:00', end: '20:00', days: [1, 2, 3, 4, 5], timezone: 'Asia/Kolkata' },
  timezone_source: 'contact',
  // 03:30 UTC = 09:00 in Kolkata, Monday 2 Nov 2026.
  next_open_at: '2026-11-02T03:30:00.000Z',
};

describe('the calling-hours override says when the window opens, in its own zone', () => {
  it('formats the next opening in the window’s timezone and names it', () => {
    const text = inZone('America/Los_Angeles', () => formatNextOpening(HOURS.next_open_at, 'Asia/Kolkata'));
    // The reader's own clock says Sun 1 Nov, 20:30.
    expect(text).not.toMatch(/20:30/);
    expect(text).toMatch(/09:00/);
    expect(text).toMatch(/2 Nov/);
    expect(text).toMatch(/\(Asia\/Kolkata\)$/);
  });

  it('describes the window, whose zone it is and the next opening', () => {
    const d = describeHoursRefusal(HOURS, { campaignName: 'Home Loan Renewals' });
    expect(d.title).toBe('Home Loan Renewals is outside its calling hours');
    const facts = Object.fromEntries(d.facts.map((f) => [f.label, f.value]));
    expect(facts['Calling hours']).toBe('09:00–20:00, Mon–Fri');
    expect(facts['Timezone']).toMatch(/customer’s, from the roster/);
    expect(facts['Opens again']).toMatch(/09:00/);
  });

  it('says so when the window never opens, and when the zone is the campaign’s default', () => {
    const d = describeHoursRefusal(
      { ...HOURS, next_open_at: null, timezone_source: 'campaign_default' },
      { campaignName: null },
    );
    const facts = Object.fromEntries(d.facts.map((f) => [f.label, f.value]));
    expect(facts['Opens again']).toMatch(/Never/);
    expect(facts['Timezone']).toMatch(/campaign’s default/);
  });
});

describe('the DNC override says exactly what matched', () => {
  const DNC: SoftphoneDncListedRefusal = {
    code: 'dnc_listed',
    status: 409,
    message: 'Listed',
    entry: { id: 'dnc-1', scope: 'campaign', reason: 'Asked not to be called', created_at: '2026-10-12T09:00:00.000Z' },
  };

  it('names the scope, the reason and the date', () => {
    const d = describeDncRefusal(DNC, { number: '+919820461733', campaignName: 'Home Loan Renewals' });
    const facts = Object.fromEntries(d.facts.map((f) => [f.label, f.value]));
    expect(facts['Number']).toBe('+91 98204 61733');
    expect(facts['Listed for']).toBe('The campaign Home Loan Renewals');
    expect(facts['Reason']).toBe('Asked not to be called');
    expect(facts['Added']).toBe('12 Oct 2026');
    expect(d.consequence).toMatch(/logged with your name/);
  });

  it('says when no reason was recorded, and a workspace-wide entry as such', () => {
    const d = describeDncRefusal(
      { ...DNC, entry: { ...DNC.entry, scope: 'tenant', reason: null } },
      { number: '+919820461733', campaignName: null },
    );
    const facts = Object.fromEntries(d.facts.map((f) => [f.label, f.value]));
    expect(facts['Listed for']).toBe('Every campaign and account in this workspace');
    expect(facts['Reason']).toBe('No reason was recorded');
  });
});
