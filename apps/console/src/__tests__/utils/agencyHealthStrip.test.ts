import { describe, it, expect } from 'vitest';
import {
  AGENCY_STALL_LABELS,
  AGENCY_STALL_PRIORITY,
  sortStallCodes,
  splitFact,
  stallCopy,
} from '../../utils/agencyHealthStrip';
import { AGENCY_STALL_PRIORITY as CONTRACT_STALL_PRIORITY, CARRIER_ACCOUNT_PAUSE_REASONS } from '@magick-agency/contracts/agency';
import type { AgencyStall, AgencyStallCode } from '../../types/agency-campaign';
import { CARRIER_PAUSE_COPY } from '../../utils/agencyCarriers';

/**
 * The health strip's derivations.
 *
 * Everything here is a claim made to a supervisor about a live campaign, so the
 * cases that matter are the ones where being wrong sends them after the wrong
 * problem: the ranking that decides which single diagnosis they read, and the
 * two "we don't know" values that must never render as reassuring zeroes.
 */

/** A fixed stand-in for the locale formatter, so no test depends on the host. */
const at = (iso: string) => `«${iso}»`;

describe('stall priority', () => {
  it('is exactly the API’s AGENCY_STALL_PRIORITY, in order', () => {
    // Mirrored by hand from the server's stall-priority contract. Pinned
    // literally rather than derived, because the whole point of the constant is
    // that a reorder is a decision someone made — it should break a test, not
    // quietly change which diagnosis a supervisor sees.
    expect([...AGENCY_STALL_PRIORITY]).toEqual([
      'auto_paused_abandonment',
      'auto_paused_carrier',
      'no_dialable_caller_ids',
      'no_carrier_capacity',
      'dnc_unavailable',
      'no_agents_available',
      'concurrency_saturated',
      'outside_calling_hours',
      'list_exhausted_retries_pending',
      // There is no `credits_low` stall code: agency has no credits.
      'elevated_failure_rate',
    ]);
  });

  it('agrees with the contract’s own list', () => {
    expect([...AGENCY_STALL_PRIORITY]).toEqual([...CONTRACT_STALL_PRIORITY]);
  });

  it('labels every code, so a disclosure can never render an empty line', () => {
    for (const code of AGENCY_STALL_PRIORITY) {
      expect(AGENCY_STALL_LABELS[code]).toBeTruthy();
    }
  });
});

describe('sortStallCodes', () => {
  it('sorts by priority, NOT by the order the array arrived in', () => {
    // The API does send `other_stalls` ranked. This asserts the console does not
    // depend on that: reversed input must come back in priority order.
    // `credits_low` is not a stall code; `outside_calling_hours` takes its slot.
    const scrambled: AgencyStallCode[] = [
      'elevated_failure_rate',
      'no_agents_available',
      'outside_calling_hours',
      'dnc_unavailable',
    ];
    expect(sortStallCodes(scrambled)).toEqual([
      'dnc_unavailable',
      'no_agents_available',
      'outside_calling_hours',
      'elevated_failure_rate',
    ]);
  });

  it('drops a code this build has no label for', () => {
    // A "3 more issues" count whose disclosure lists two names is worse than an
    // honest two — so unknown codes leave the count as well as the list.
    const withUnknown = ['dnc_unavailable', 'time_travel_paradox'] as AgencyStallCode[];
    expect(sortStallCodes(withUnknown)).toEqual(['dnc_unavailable']);
  });

  it('does not mutate its input', () => {
    const input: AgencyStallCode[] = ['elevated_failure_rate', 'dnc_unavailable'];
    sortStallCodes(input);
    expect(input).toEqual(['elevated_failure_rate', 'dnc_unavailable']);
  });
});

describe('stallCopy — the carrier-account diagnoses', () => {
  const VENDOR = /plivo|voicelink|vobiz/i;

  it.each(CARRIER_ACCOUNT_PAUSE_REASONS)('an automatic `%s` pause says what happened, when, and to contact support', (reason) => {
    const copy = stallCopy({ code: 'auto_paused_carrier', reason, paused_at: '2026-11-04T09:00:00.000Z' }, at);
    // The strip says the same cause and action as Insights and Activity, from the one table.
    expect(copy.headline).toBe(`Paused automatically — ${CARRIER_PAUSE_COPY[reason].cause}.`);
    expect(copy.advice).toBe(CARRIER_PAUSE_COPY[reason].action);
    expect(copy.headline).toMatch(/^Paused automatically/);
    expect(copy.evidence).toContain('«2026-11-04T09:00:00.000Z»');
    expect(copy.advice).toMatch(/Contact support/);
    // Support fixes a carrier account, not the workspace's own administrators.
    expect(`${copy.headline} ${copy.advice}`).not.toMatch(/administrator/i);
    expect(`${copy.headline} ${copy.evidence} ${copy.advice}`).not.toMatch(VENDOR);
  });

  it('a reason this build has no sentence for still says it is the carrier account, and what to do', () => {
    const copy = stallCopy(
      { code: 'auto_paused_carrier', reason: 'carrier_from_the_future' as never, paused_at: '2026-11-04T09:00:00.000Z' }, at,
    );
    expect(copy.headline).toMatch(/carrier account cannot place calls/);
    expect(copy.advice).toMatch(/Contact support/);
  });

  it('no_dialable_caller_ids counts the stored pool and says how to fix it', () => {
    const copy = stallCopy({ code: 'no_dialable_caller_ids', caller_ids_stored: 3 }, at);
    expect(copy.headline).toMatch(/none of this campaign’s caller IDs is available/);
    expect(copy.evidence).toBe('3 caller IDs chosen, none still available.');
    expect(copy.advice).toMatch(/campaign’s settings.*contact support/);
    expect(`${copy.headline} ${copy.advice}`).not.toMatch(VENDOR);
  });

  it('no_carrier_capacity names support as the fix', () => {
    const copy = stallCopy({ code: 'no_carrier_capacity' }, at);
    expect(copy.headline).toMatch(/no call capacity on the campaign’s carrier/);
    expect(copy.advice).toMatch(/^Contact support to add capacity for this carrier/);
    expect(`${copy.headline} ${copy.advice}`).not.toMatch(/administrator/i);
  });
});

describe('stallCopy — each arm names its own evidence', () => {
  it('auto_paused_abandonment says the rate was MEASURED, not that it is current', () => {
    const stall: AgencyStall = {
      code: 'auto_paused_abandonment',
      measured_pct: 3.42,
      ceiling_pct: 3,
      paused_at: '2026-08-15T09:30:00.000Z',
    };
    const copy = stallCopy(stall, at);

    expect(copy.headline).toContain('3.4%');
    expect(copy.headline).toContain('3%');
    // The figure is frozen at the instant the guardrail fired (`paused_at` /
    // `pause_abandonment_rate_pct`). Calling it a current rate means a supervisor who has since staffed
    // up watches a number that cannot move and concludes the fix failed.
    expect(copy.evidence).toContain('«2026-08-15T09:30:00.000Z»');
    expect(copy.evidence).toMatch(/not a live rate/i);
    expect(copy.headline).not.toMatch(/currently|right now/i);
  });

  it('dnc_unavailable says the whole workspace is affected', () => {
    const copy = stallCopy({ code: 'dnc_unavailable', tenant_wide: true }, at);
    expect(copy.evidence).toMatch(/workspace/i);
    expect(copy.evidence).toMatch(/every campaign/i);
  });

  it('no_agents_available breaks the roster down by break reason', () => {
    const copy = stallCopy(
      {
        code: 'no_agents_available',
        agents_on_shift: 6,
        on_break_by_reason: { training: 1, lunch: 3 },
        on_call: 2,
        last_dial_at: '2026-08-15T10:00:00.000Z',
      },
      at,
    );
    expect(copy.evidence).toContain('6 agents on shift');
    expect(copy.evidence).toContain('2 on a call');
    // Largest reason first — the one holding the most agents is the actionable
    // one, and it is what a supervisor scanning under pressure reads.
    expect(copy.evidence).toContain('4 on break (lunch 3, training 1)');
    // The last dial is EVIDENCE, not advice — a fact about the campaign the
    // supervisor can check, which sat in `advice` only because the banner had
    // nowhere else to put it. What to do about an empty floor is the "Open the
    // floor" link, so this arm now offers no advice sentence at all.
    expect(copy.evidence).toContain('«2026-08-15T10:00:00.000Z»');
    expect(copy.advice).toBeUndefined();
  });

  it('no_agents_available counts on shift by the floor’s rows when the caller has them', () => {
    // The server's `agents_on_shift` is `agents_live`: signed-out sessions too. The
    // banner said "2 agents on shift" above a floor of two Offline agents (QA).
    const stall: AgencyStall = {
      code: 'no_agents_available',
      agents_on_shift: 2,
      on_break_by_reason: {},
      on_call: 0,
      last_dial_at: null,
    };
    expect(stallCopy(stall, at, { agentsOnShift: 0 }).evidence).toMatch(/^0 agents on shift/);
    expect(stallCopy(stall, at, { agentsOnShift: 1 }).facts[0]).toEqual({ text: '1 agent on shift', emphasis: '1' });
    // No rows in the payload ("not known"): the server's figure is all there is.
    expect(stallCopy(stall, at, { agentsOnShift: null }).evidence).toMatch(/^2 agents on shift/);
    expect(stallCopy(stall, at).evidence).toMatch(/^2 agents on shift/);
  });

  it('no_agents_available distinguishes “never dialed” from “stopped dialing”', () => {
    const copy = stallCopy(
      {
        code: 'no_agents_available',
        agents_on_shift: 0,
        on_break_by_reason: {},
        on_call: 0,
        last_dial_at: null,
      },
      at,
    );
    // Two different problems with two different fixes; a missing timestamp must
    // not silently render as a blank where a time would go.
    expect(copy.evidence).toMatch(/never placed a call/i);
    expect(copy.evidence).not.toMatch(/on break/i);
  });

  it('concurrency_saturated names the numbers and says who can change the limit', () => {
    const copy = stallCopy({ code: 'concurrency_saturated', limit: 5, in_use: 5 }, at);
    expect(copy.headline).toContain('5 of 5');
    // `shift_seconds`: read-only. The advice must not imply the supervisor can raise it.
    expect(copy.advice).toMatch(/support/i);
  });

  it('concurrency_saturated says "lines", not "concurrency", in its label and headline (the strip and Home share both)', () => {
    expect(AGENCY_STALL_LABELS.concurrency_saturated).toBe('All lines in use');
    const copy = stallCopy({ code: 'concurrency_saturated', limit: 5, in_use: 5 }, at);
    expect(copy.headline).toBe('All your lines are in use: 5 of 5.');
    expect(`${AGENCY_STALL_LABELS.concurrency_saturated} ${copy.headline}`).not.toMatch(/concurrency/i);
  });

  it('outside_calling_hours falls back honestly when no window resolves', () => {
    const withWindow = stallCopy(
      {
        code: 'outside_calling_hours',
        contacts_waiting: 412,
        next_window_opens_at: '2026-08-16T03:30:00.000Z',
      },
      at,
    );
    expect(withWindow.evidence).toContain('412 contacts');
    expect(withWindow.advice).toContain('«2026-08-16T03:30:00.000Z»');

    const noWindow = stallCopy(
      { code: 'outside_calling_hours', contacts_waiting: 1, next_window_opens_at: null },
      at,
    );
    expect(noWindow.evidence).toContain('1 contact ');
    expect(noWindow.advice).toMatch(/no upcoming window/i);
  });

  it('list_exhausted_retries_pending pluralises retries and handles a null next time', () => {
    const one = stallCopy(
      { code: 'list_exhausted_retries_pending', retries_pending: 1, next_retry_at: null },
      at,
    );
    expect(one.evidence).toContain('1 retry');
    expect(one.advice).toMatch(/no retry time is set/i);

    const many = stallCopy(
      {
        code: 'list_exhausted_retries_pending',
        retries_pending: 12,
        next_retry_at: '2026-08-15T14:00:00.000Z',
      },
      at,
    );
    expect(many.evidence).toContain('12 retries');
    expect(many.advice).toContain('«2026-08-15T14:00:00.000Z»');
  });

  it('credits_low is GONE — no label, dropped from a disclosure, no "top up" copy anywhere (magick-agency)', () => {
    // A `credits_low` stall must never render, even though an API could in
    // principle insert the arm from a balance. Agency v1 has no credits, so the
    // code is absent from the union AND the console's health-strip copy, because
    // a declared-but-unproducible code is a trap. This is that absence's test.
    const removed = 'credits_low' as AgencyStallCode;
    expect(AGENCY_STALL_PRIORITY).not.toContain(removed);
    expect(Object.keys(AGENCY_STALL_LABELS)).not.toContain('credits_low');
    expect(sortStallCodes([removed, 'dnc_unavailable'])).toEqual(['dnc_unavailable']);
    for (const label of Object.values(AGENCY_STALL_LABELS)) {
      expect(label.toLowerCase()).not.toContain('credit');
    }
  });

  it('elevated_failure_rate names its window rather than implying “lately”', () => {
    const copy = stallCopy(
      { code: 'elevated_failure_rate', failed_pct: 62.5, attempts: 80, window_minutes: 15 },
      at,
    );
    expect(copy.headline).toContain('62.5%');
    expect(copy.evidence).toContain('80 attempts');
    expect(copy.evidence).toContain('15 minutes');
  });
});

describe('the evidence run — facts, and the numbers inside them', () => {
  /**
   * The banner reads the facts, not the joined string. These pin the one thing
   * that could quietly go wrong once the two exist side by side: they must be
   * the same words.
   */
  it('joins to exactly the evidence sentence, for every arm', () => {
    const arms: AgencyStall[] = [
      { code: 'auto_paused_abandonment', measured_pct: 3.42, ceiling_pct: 3, paused_at: 'P' },
      { code: 'dnc_unavailable', tenant_wide: true },
      {
        code: 'no_agents_available',
        agents_on_shift: 2,
        on_break_by_reason: { lunch: 1 },
        on_call: 0,
        last_dial_at: 'D',
      },
      { code: 'concurrency_saturated', limit: 5, in_use: 5 },
      { code: 'outside_calling_hours', contacts_waiting: 412, next_window_opens_at: null },
      { code: 'list_exhausted_retries_pending', retries_pending: 3, next_retry_at: null },
      { code: 'elevated_failure_rate', failed_pct: 62.5, attempts: 80, window_minutes: 15 },
    ];
    for (const stall of arms) {
      const copy = stallCopy(stall, at);
      expect(copy.facts.length).toBeGreaterThan(0);
      expect(copy.facts.map((fact) => fact.text).join(' · ')).toBe(copy.evidence);
    }
  });

  it('emphasises a number that is really a substring of its own fact', () => {
    // The emphasis is a substring rather than a separate value precisely so it
    // cannot drift from the sentence. If it ever stops matching, the fact still
    // renders — but the banner silently loses every bold number, which nothing
    // else here would catch.
    const copy = stallCopy(
      {
        code: 'no_agents_available',
        agents_on_shift: 1200,
        on_break_by_reason: { lunch: 3 },
        on_call: 7,
        last_dial_at: '2026-08-15T10:00:00.000Z',
      },
      at,
    );
    for (const fact of copy.facts) {
      if (!fact.emphasis) continue;
      expect(fact.text).toContain(fact.emphasis);
    }
    // Localised, so the bold run covers the whole number and not "1" of "1,200".
    expect(copy.facts[0]).toEqual({ text: '1,200 agents on shift', emphasis: '1,200' });
    expect(splitFact(copy.facts[0]!)).toEqual({
      before: '',
      value: '1,200',
      after: ' agents on shift',
    });
  });

  it('splitFact degrades to the whole sentence rather than dropping words', () => {
    expect(splitFact({ text: 'No emphasis here.' })).toEqual({
      before: 'No emphasis here.',
      value: '',
      after: '',
    });
    // An emphasis that does not match is a styling miss, never a missing fact.
    expect(splitFact({ text: 'Nine lines free', emphasis: '9' })).toEqual({
      before: 'Nine lines free',
      value: '',
      after: '',
    });
    expect(splitFact({ text: 'Last call placed at 09:21', emphasis: '09:21' })).toEqual({
      before: 'Last call placed at ',
      value: '09:21',
      after: '',
    });
  });
});
