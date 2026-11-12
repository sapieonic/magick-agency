import { describe, expect, it } from 'vitest';
import { campaignRunLength, campaignTimeline } from '../../utils/agency/overview/lifecycle';
import type { AgencyCampaign } from '../../types/agency-campaign';

/**
 * What is left of the Overview panel's derivations after the Insights tab replaced it: the
 * detail page's lifecycle line (`utils/agency/overview/lifecycle.ts`).
 *
 * It is computed from optional-and-nullable fields. The failure these tests exist to stop is
 * the quiet one: a missing number rendered as a confident `0`, or an absent instant rendered as a
 * campaign of zero length.
 */

/*
  ── The campaign's own clock ────────────────────────────────────

  `started_at`, `ended_at` and `last_transition_by` are what let a TERMINAL
  campaign say anything about itself, and a terminal campaign is the primary
  case for this workspace. All three are optional-and-nullable on the wire, so
  the failures worth pinning are the ones that read as facts: a duration that
  came out negative because two clocks disagreed, and an automatic
  pause attributed to nobody at all.
*/

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('campaignRunLength', () => {
  it('reads seconds below a minute, and never a negative one', () => {
    expect(campaignRunLength(0)).toBe('0 seconds');
    expect(campaignRunLength(1)).toBe('1 second');
    expect(campaignRunLength(59)).toBe('59 seconds');
    // A clock skew is enough to produce this. It is not a
    // duration, and "-4 seconds" is worse than a floor at zero.
    expect(campaignRunLength(-90)).toBe('0 seconds');
  });

  it('rounds to whole seconds rather than printing a fraction', () => {
    expect(campaignRunLength(1.6)).toBe('2 seconds');
  });

  it('steps up to minutes, then hours, then days', () => {
    expect(campaignRunLength(60)).toBe('1 minute');
    expect(campaignRunLength(3599)).toBe('59 minutes');
    expect(campaignRunLength(3600)).toBe('1 hour');
    expect(campaignRunLength(86_400)).toBe('1 day');
  });

  it('carries at most two components, largest first', () => {
    expect(campaignRunLength(2 * 3600 + 3 * 60)).toBe('2 hours 3 minutes');
    expect(campaignRunLength(3 * 86_400 + 4 * 3600)).toBe('3 days 4 hours');
    /*
      Minutes are dropped once days are in play — a campaign is being given a
      magnitude, not read a clock, and "3 days 4 hours 12 minutes" is three
      figures where the reader wanted one.
    */
    expect(campaignRunLength(3 * 86_400 + 4 * 3600 + 12 * 60)).toBe('3 days 4 hours');
  });

  it('drops a zero component rather than padding it', () => {
    expect(campaignRunLength(3 * 86_400)).toBe('3 days');
    expect(campaignRunLength(3 * 86_400 + 59)).toBe('3 days');
    expect(campaignRunLength(5 * 3600)).toBe('5 hours');
  });

  it('says “1 day”, not “1 days”', () => {
    expect(campaignRunLength(86_400)).toBe('1 day');
    expect(campaignRunLength(2 * 86_400)).toBe('2 days');
    expect(campaignRunLength(3600 + 60)).toBe('1 hour 1 minute');
  });
});

describe('campaignTimeline', () => {
  const NOW = new Date('2026-08-14T18:30:00.000Z');

  function campaign(over: Partial<AgencyCampaign> = {}): AgencyCampaign {
    return { id: 'c1', name: 'Collections', status: 'running', ...over };
  }

  const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

  it('says nothing at all without a campaign', () => {
    const timeline = campaignTimeline(null, null, NOW);

    expect(timeline.started).toBeNull();
    expect(timeline.ran).toBeNull();
    expect(timeline.ended).toBeNull();
    expect(timeline.duration).toBeNull();
    expect(timeline.actor).toBeNull();
    expect(timeline.neverStarted).toBe(false);
  });

  it('drops the start line entirely when the field did not arrive', () => {
    // An older API. Not "Started —", which reads as a failed read.
    const timeline = campaignTimeline(campaign(), null, NOW);

    expect(timeline.started).toBeNull();
    expect(timeline.ran).toBeNull();
    expect(timeline.neverStarted).toBe(false);
  });

  it('counts a live campaign forward, in the present tense', () => {
    const timeline = campaignTimeline(campaign({ started_at: iso(-6 * HOUR) }), null, NOW);

    expect(timeline.started).toMatch(/^Started .+/);
    expect(timeline.ran).toBe('Running for 6 hours');
    expect(timeline.duration).toBe('6 hours');
    // Nothing has ended, so nothing says it has — beside a live Stop button.
    expect(timeline.ended).toBeNull();
    expect(timeline.endedStamp).toBeNull();
  });

  it('closes the clock on a terminal campaign, in the past tense', () => {
    const timeline = campaignTimeline(
      campaign({
        status: 'stopped',
        started_at: iso(-(3 * DAY + 4 * HOUR)),
        ended_at: iso(0),
      }),
      'stopped',
      NOW,
    );

    expect(timeline.ran).toBe('Ran for 3 days 4 hours');
    expect(timeline.duration).toBe('3 days 4 hours');
    expect(timeline.ended).toMatch(/^Stopped .+/);
    expect(timeline.endedStamp).not.toBeNull();
    // `now` is not consulted once there is an end: a campaign that stopped last
    // month must not grow another month of runtime while the page is open.
    expect(timeline.ran).toBe(
      campaignTimeline(
        campaign({
          status: 'stopped',
          started_at: iso(-(3 * DAY + 4 * HOUR)),
          ended_at: iso(0),
        }),
        'stopped',
        new Date(NOW.getTime() + 30 * DAY),
      ).ran,
    );
  });

  it('drops a backwards duration but keeps both stamps', () => {
    /*
      Two writers stamping two clocks is enough to produce an end before a
      start. "Ran for -4 hours" is a number nobody can act on; the two instants
      are still facts and stay.
    */
    const timeline = campaignTimeline(
      campaign({ status: 'stopped', started_at: iso(0), ended_at: iso(-4 * HOUR) }),
      'stopped',
      NOW,
    );

    expect(timeline.duration).toBeNull();
    expect(timeline.ran).toBeNull();
    expect(timeline.started).toMatch(/^Started .+/);
    expect(timeline.ended).toMatch(/^Stopped .+/);
  });

  it('names a person, and names the dialer when there was none', () => {
    const by = (last: AgencyCampaign['last_transition_by']) =>
      campaignTimeline(campaign({ status: 'stopped', last_transition_by: last }), 'stopped', NOW).actor;

    expect(by({ user_id: 'usr-1', name: 'Priya Sharma' })).toBe('Priya Sharma');
    /*
      `null` is the API saying nobody did this — the abandonment auto-pause. On a
      campaign that stopped itself that is the single most useful sentence on
      the page, so it is said rather than dropped.
    */
    expect(by(null)).toBe('Automatically');
    // `undefined` is an older API carrying no such field. This console then
    // has nothing to say either way, so it says nothing.
    expect(by(undefined)).toBeNull();
  });

  it('renders the id of an actor the server could not name', () => {
    /*
      `{ user_id, name: null }` is an id-only actor: a caller that sent an id and
      no display name. The server sends it as such (`name ?? null`), and the
      contract's note says the console renders the id rather than inventing a
      name or dropping the line.
    */
    const timeline = campaignTimeline(
      campaign({ status: 'stopped', last_transition_by: { user_id: 'usr-1', name: null } }),
      'stopped',
      NOW,
    );

    expect(timeline.actor).toBe('usr-1');
  });

  it('attributes nothing on a campaign that has not finished', () => {
    // `last_transition_by` describes the CURRENT status, which on a live
    // campaign is "running" — "Stopped by Priya" above a Pause button is a
    // sentence that contradicts the page.
    const timeline = campaignTimeline(
      campaign({ last_transition_by: { user_id: 'usr-1', name: 'Priya Sharma' } }),
      null,
      NOW,
    );

    expect(timeline.actor).toBeNull();
  });

  it('flags “never started” only on a terminal campaign that explicitly did not', () => {
    expect(campaignTimeline(campaign({ status: 'stopped', started_at: null }), 'stopped', NOW)
      .neverStarted).toBe(true);
    // Live and not yet dialing is not the same claim — it may start in a minute.
    expect(campaignTimeline(campaign({ status: 'draft', started_at: null }), null, NOW)
      .neverStarted).toBe(false);
    // Absent is "we were not told", never "it never happened".
    expect(campaignTimeline(campaign({ status: 'stopped' }), 'stopped', NOW)
      .neverStarted).toBe(false);
  });
});

/*
  ── "including 1,922 retries" ───────────────────────────────────────────────

  `attempts_total` silently includes retries, so "6,742 dials" against a
  2,100-contact list invites a reconciliation ("the list was dialled three times
  over") that is wrong. The sub-line is the reconciliation, and every way of
  NOT having one is a separate rule.
*/
/*
  ── The success case, found in review ───────────────────────────────────────
  Everything behind the old `terminal` boolean was worded for `stopped`, so a
  campaign that ran its whole list was told "Stopped by: Automatically" under a
  badge reading "Completed".
*/
describe('a completed campaign is not a stopped one', () => {
  // Its own fixtures: the helpers above are scoped to their describe blocks.
  const NOW = new Date('2026-08-14T18:30:00.000Z');
  const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
  const campaign = (over: Partial<AgencyCampaign> = {}): AgencyCampaign =>
    ({ id: 'c1', name: 'Collections', status: 'running', ...over });

  const finished = campaign({
    status: 'completed',
    started_at: iso(-(2 * DAY)),
    ended_at: iso(-HOUR),
    last_transition_by: null,
  });

  it('says it finished, not that it was stopped', () => {
    const timeline = campaignTimeline(finished, 'completed', NOW);
    expect(timeline.ended).toMatch(/^Finished /);
    expect(timeline.ended).not.toMatch(/^Stopped /);
  });

  it('names NOBODY as its ender, because nobody ended it', () => {
    /*
      `last_transition_by: null` means "no human did this", which on a STOPPED
      campaign is the most useful sentence on the page (the abandonment
      auto-pause). On a completed one it is a fabrication: it ran out of list.
      "Automatically" is the specific fabrication that reads as a fault.
    */
    const timeline = campaignTimeline(finished, 'completed', NOW);
    expect(timeline.actor).toBeNull();
    expect(JSON.stringify(timeline)).not.toContain('Automatically');
  });

  it('still names the ender on a campaign somebody really did stop', () => {
    // The other side of the guard: the `stopped` arm is unchanged.
    const stopped = campaign({
      status: 'stopped',
      started_at: iso(-(2 * DAY)),
      ended_at: iso(-HOUR),
      last_transition_by: null,
    });
    expect(campaignTimeline(stopped, 'stopped', NOW).actor).toBe('Automatically');
  });
});

/*
  ── Guards that existed but nothing exercised ───────────────────────────────
  Each of these was proved by a QA mutation that left the suite green.
*/
describe('inconsistent and unparseable payloads', () => {
  const NOW = new Date('2026-08-27T15:30:00.000Z');
  const campaign = (over: Partial<AgencyCampaign> = {}): AgencyCampaign =>
    ({ id: 'c1', name: 'Collections', status: 'running', ...over });

  it('treats a start in the future as skew, not as a campaign of zero length', () => {
    // `campaignRunLength` clamped the negative to zero, so the header read
    // "Running for 0 seconds" on a campaign that had been dialing all morning.
    const timeline = campaignTimeline(
      campaign({ started_at: '2099-01-01T00:00:00.000Z' }),
      null,
      NOW,
    );
    expect(timeline.duration).toBeNull();
    expect(timeline.ran).toBeNull();
    // The stamp is still a fact and stays.
    expect(timeline.started).toMatch(/^Started /);
  });

  it('keeps a genuine zero-length campaign, which is a measurement', () => {
    const at = '2026-08-27T09:00:00.000Z';
    expect(
      campaignTimeline(campaign({ status: 'stopped', started_at: at, ended_at: at }), 'stopped', NOW)
        .duration,
    ).toBe('0 seconds');
  });

  it('renders nothing at all for an unparseable timestamp', () => {
    const timeline = campaignTimeline(
      campaign({ status: 'stopped', started_at: 'not-a-date', ended_at: '2026-13-45' }),
      'stopped',
      NOW,
    );
    expect(timeline.started).toBeNull();
    expect(timeline.endedStamp).toBeNull();
    expect(timeline.duration).toBeNull();
  });

  it('never renders the string "NaN"', () => {
    // `Math.round(NaN)` survives `Math.max(0, …)` and fell through every branch.
    expect(campaignRunLength(Number.NaN)).not.toContain('NaN');
    expect(campaignRunLength(Number.POSITIVE_INFINITY)).not.toContain('Infinity');
  });

  it('dates an old campaign with its year, and a current one without', () => {
    /*
      "How it ended" exists for campaigns that finished months ago, so this is
      the one screen where the year matters most — and "Stopped 18 Jan" is
      indistinguishable from last January's.
    */
    const old = campaignTimeline(
      campaign({
        status: 'stopped',
        started_at: '2025-01-15T09:00:00.000Z',
        ended_at: '2025-01-18T09:00:00.000Z',
      }),
      'stopped',
      NOW,
    );
    expect(old.endedStamp).toContain('2025');

    const thisYear = campaignTimeline(
      campaign({
        status: 'stopped',
        started_at: '2026-08-20T09:00:00.000Z',
        ended_at: '2026-08-21T09:00:00.000Z',
      }),
      'stopped',
      NOW,
    );
    // A redundant "2026" on every live campaign's header is the commoner read.
    expect(thisYear.endedStamp).not.toContain('2026');
  });
});

describe('the tense follows the status, not "is it terminal?"', () => {
  const NOW = new Date('2026-08-14T18:30:00.000Z');
  const HOURS_6 = 6 * 60 * 60 * 1000;
  const started = new Date(NOW.getTime() - HOURS_6).toISOString();
  const campaign = (status: string): AgencyCampaign =>
    ({ id: 'c1', name: 'Collections', status, started_at: started });

  it('does not tell a PAUSED campaign it is running', () => {
    /*
      "Running for 6 hours" beside a Paused badge and a Resume button is the same
      tense-contradicts-the-control failure `PAUSE_IN_FLIGHT_NOTE` prevents one
      row higher up — and the clock genuinely is not running on a paused
      campaign.
    */
    const ran = campaignTimeline(campaign('paused'), null, NOW).ran;
    expect(ran).not.toContain('Running for');
    // Nor "Live for": beside a Paused badge that read as live too (QA). Only how long ago it started.
    expect(ran).toBe('6 hours ago');
  });

  it('does not tell a STOPPING campaign it is running or live either', () => {
    expect(campaignTimeline(campaign('stopping'), null, NOW).ran).toBe('6 hours ago');
  });

  it('still says "Running for" on a campaign that really is dialing', () => {
    expect(campaignTimeline(campaign('running'), null, NOW).ran).toBe('Running for 6 hours');
  });

  it('still says "Ran for" once it has ended', () => {
    // A finished campaign needs its `ended_at` to have a duration at all — `now`
    // is not consulted once it is over, which is its own pinned rule above.
    const finished = (status: string): AgencyCampaign =>
      ({ ...campaign(status), ended_at: NOW.toISOString() });
    expect(campaignTimeline(finished('stopped'), 'stopped', NOW).ran).toBe('Ran for 6 hours');
    expect(campaignTimeline(finished('completed'), 'completed', NOW).ran).toBe('Ran for 6 hours');
  });
});
