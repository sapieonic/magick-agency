import { describe, it, expect } from 'vitest';
import { assignmentEntry, canEnterStation } from '../../utils/agencyAssignmentEntry';

/**
 * Whether to offer an agent the way into a campaign's station.
 *
 * ── The regression these cases exist to prevent ────────────────────────────
 * The first version of this helper blocked `draft`, `paused`, `stopping`,
 * `stopped` and `completed`, justified as sparing the agent "a refusal they could
 * have been told about". Core has no such refusal: its `POST /sessions` checks
 * campaign ownership and nothing else, and `campaign_not_running` is declared in
 * its contracts but raised nowhere. Joining a paused campaign has always worked.
 *
 * So the helper was strictly worse than absent — a supervisor pausing for two
 * minutes locked every agent out of the station and told them to go ask a
 * supervisor. The block list is now terminal states only, and the `paused` case
 * below is the one that would catch a re-widening.
 */

describe('assignmentEntry — only terminal states block', () => {
  it.each([
    ['stopped', /won’t start again/i],
    ['completed', /every contact has been dialled/i],
  ])('blocks %s, because no call will ever arrive', (status, reason) => {
    const entry = assignmentEntry(status);
    expect(entry.canEnter).toBe(false);
    expect(entry.note).toMatch(reason);
  });

  it('never blocks without saying why', () => {
    // A greyed control with no stated reason reads as an outage or a lost
    // permission — the house rule the console's disabled affordances follow.
    for (const status of ['stopped', 'completed']) {
      expect(assignmentEntry(status).note).toBeTruthy();
    }
  });
});

describe('assignmentEntry — a campaign that is merely not dialing yet', () => {
  /**
   * The heart of the fix. Each of these is a state a campaign LEAVES, and an agent
   * who wants to be at the station when it does is behaving correctly.
   */
  it.each(['draft', 'paused', 'stopping'])('lets %s through', (status) => {
    expect(assignmentEntry(status).canEnter).toBe(true);
  });

  it('explains paused as a wait, not a refusal', () => {
    // The exact case that regressed. The note must read as context beside an
    // available control, not as a reason there isn't one.
    const entry = assignmentEntry('paused');
    expect(entry.canEnter).toBe(true);
    expect(entry.note).toMatch(/wait at the station/i);
    expect(entry.note).not.toMatch(/can’t|cannot|not taking/i);
  });

  it('gives draft and stopping a note too, so the row is not silently odd', () => {
    expect(assignmentEntry('draft').note).toBeTruthy();
    expect(assignmentEntry('stopping').note).toBeTruthy();
  });
});

describe('assignmentEntry — what must NOT block', () => {
  it('lets a running campaign through with nothing to add', () => {
    expect(assignmentEntry('running')).toEqual({ canEnter: true, note: null });
  });

  /**
   * `campaign_status` is null whenever master's best-effort lookup failed — a core
   * blip, a shape core changed. Blocking would let a thirty-second outage lock
   * every agent out of a running campaign: strictly worse than the pointless
   * station this helper avoids.
   */
  it.each([null, undefined, ''])('lets an unresolved status (%s) through', (status) => {
    expect(canEnterStation(status)).toBe(true);
  });

  /**
   * The block list is an ALLOW-LIST OF BLOCKS, deliberately. Core owns the campaign
   * lifecycle and master forwards its value verbatim, so a status core adds arrives
   * here before this file knows the word. Treating unknown-to-us as terminal would
   * lock agents out of a state core considers dialable, and it would look like a
   * permissions bug.
   */
  it('lets a status this client has never heard of through', () => {
    expect(assignmentEntry('draining')).toEqual({ canEnter: true, note: null });
    expect(canEnterStation('some_future_state')).toBe(true);
  });

  it('is case-sensitive, matching the wire rather than guessing', () => {
    // Core sends lower-case statuses. Anything else is an unrecognised value and
    // takes the permissive branch, not a normalised guess at what was meant.
    expect(canEnterStation('STOPPED')).toBe(true);
  });

  /**
   * ── Prototype keys ────────────────────────────────────────────────────────
   * `campaign_status` is forwarded verbatim and unvalidated, so the lookup table
   * must not be reachable through `Object.prototype`. With an object literal,
   * `status = 'toString'` matched, blocked entry, and rendered
   * `"function toString() { [native code] }"` as the reason. A `Map` has no such
   * keys — this is the case that pins the container choice.
   */
  it.each(['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf'])(
    'treats %s as an ordinary unrecognised status',
    (status) => {
      expect(assignmentEntry(status)).toEqual({ canEnter: true, note: null });
    },
  );
});
